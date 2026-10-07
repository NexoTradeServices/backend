// Cloudinary, the little the backend needs -- Feature 3003, enquiry photos.
//
// Images live in Cloudinary, never in Postgres and never through this
// backend (ADR 0000): the browser uploads straight to Cloudinary with a
// signature made here, and the database keeps only the public id per
// Attachment. Cloudinary is a convenience, never a gate -- any missing
// setting reads as "not set up", never a boot failure.
import { createHash } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";

/** The folder every enquiry photo lives in; a stored key must sit inside it. */
export const ENQUIRY_PHOTO_FOLDER = "tradeservice/enquiry-photos";

/** Feature 5001: where a contractor's part receipts live -- its own folder, its own key check. */
export const RECEIPT_FOLDER = "tradeservice/receipts";

/** Signed into each upload, so Cloudinary itself refuses anything else. */
export const ALLOWED_PHOTO_FORMATS = "jpg,png,webp,heic";

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  uploadPreset: string;
}

/** The four settings, or null when any is missing. */
export function readCloudinaryConfig(env: NodeJS.ProcessEnv = process.env): CloudinaryConfig | null {
  const cloudName = env["CLOUDINARY_CLOUD_NAME"]?.trim();
  const apiKey = env["CLOUDINARY_API_KEY"]?.trim();
  const apiSecret = env["CLOUDINARY_API_SECRET"]?.trim();
  const uploadPreset = env["CLOUDINARY_UPLOAD_PRESET"]?.trim();
  if (!cloudName || !apiKey || !apiSecret || !uploadPreset) return null;
  return { cloudName, apiKey, apiSecret, uploadPreset };
}

/** What the browser needs for one signed direct upload. Never the API secret. */
export interface PhotoUploadSignature {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  uploadPreset: string;
  folder: string;
  allowedFormats: string;
  returnDeleteToken: boolean;
}

/**
 * Cloudinary's signature: the signed parameters sorted by name, joined as
 * name=value with &, the API secret appended, SHA-1 in hex.
 */
export function signParams(params: Record<string, string | number | boolean>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((name) => `${name}=${String(params[name])}`)
    .join("&");
  return createHash("sha1").update(toSign + apiSecret).digest("hex");
}

function signUpload(config: CloudinaryConfig, folder: string, now: Date, uploadPreset: string = config.uploadPreset): PhotoUploadSignature {
  const timestamp = Math.floor(now.getTime() / 1000);
  const signature = signParams(
    {
      allowed_formats: ALLOWED_PHOTO_FORMATS,
      folder,
      return_delete_token: true,
      timestamp,
      upload_preset: uploadPreset,
    },
    config.apiSecret,
  );
  return {
    cloudName: config.cloudName,
    apiKey: config.apiKey,
    timestamp,
    signature,
    uploadPreset,
    folder,
    allowedFormats: ALLOWED_PHOTO_FORMATS,
    returnDeleteToken: true,
  };
}

export function signEnquiryPhotoUpload(config: CloudinaryConfig, now: Date = new Date()): PhotoUploadSignature {
  return signUpload(config, ENQUIRY_PHOTO_FOLDER, now);
}

/**
 * Feature 5001: a signed direct upload for the receipts folder. It uses its own
 * preset, `CLOUDINARY_RECEIPT_UPLOAD_PRESET` (asset folder `tradeservice/receipts`),
 * because the enquiry preset pins its asset folder to the enquiry photos; with
 * the setting absent it falls back to the enquiry preset.
 */
export function signReceiptUpload(
  config: CloudinaryConfig,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): PhotoUploadSignature {
  return signUpload(config, RECEIPT_FOLDER, now, env["CLOUDINARY_RECEIPT_UPLOAD_PRESET"]?.trim() || config.uploadPreset);
}

function isKeyInFolder(key: string, folder: string): boolean {
  const prefix = `${folder}/`;
  if (!key.startsWith(prefix) || key.length === prefix.length) return false;
  return !key.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** A public id is ours only when it sits inside the enquiry-photos folder. */
export function isEnquiryPhotoKey(key: string): boolean {
  return isKeyInFolder(key, ENQUIRY_PHOTO_FOLDER);
}

/** Feature 5001: a receipt's public id must sit inside the receipts folder -- never the enquiry folder. */
export function isReceiptKey(key: string): boolean {
  return isKeyInFolder(key, RECEIPT_FOLDER);
}

export interface PhotoView {
  fileName: string;
  /** Square, automatic format and quality (a HEIC shows as an ordinary image). */
  thumbnailUrl: string;
  fullUrl: string;
}

/** URLs are built, never stored. */
export function photoUrls(storageKey: string, cloudName: string): { thumbnailUrl: string; fullUrl: string } {
  const base = `https://res.cloudinary.com/${cloudName}/image/upload`;
  return {
    thumbnailUrl: `${base}/c_fill,g_auto,w_240,h_240,f_auto,q_auto/${storageKey}`,
    fullUrl: `${base}/f_auto,q_auto/${storageKey}`,
  };
}

/**
 * The job's customer-uploaded photos, oldest first. With the cloud name not
 * set there is no way to build a URL, so the list is empty rather than a
 * broken picture.
 */
export async function customerPhotosOf(
  client: Pick<Prisma.TransactionClient, "attachment">,
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PhotoView[]> {
  const cloudName = env["CLOUDINARY_CLOUD_NAME"]?.trim();
  if (!cloudName) return [];
  const rows = await client.attachment.findMany({
    where: { jobId, uploadedByRole: "customer" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { storageKey: true, fileName: true },
  });
  return rows.map((row) => ({ fileName: row.fileName, ...photoUrls(row.storageKey, cloudName) }));
}
