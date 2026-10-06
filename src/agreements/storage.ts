// Private file storage for the contractor agreement -- Feature 2006.
//
// Server-side only: the backend uploads with the API secret, into
// `tradeservice/agreements`, as PRIVATE raw files. Nothing is openable from a
// public address; a file is opened only through a short-lived signed address
// the backend hands out after its own check. Reuses 3003's Cloudinary config
// and signer (never a second copy), and uses no upload preset.
import { randomUUID } from "node:crypto";
import { readCloudinaryConfig, signParams, type CloudinaryConfig } from "../photos/cloudinary.js";

export const AGREEMENT_FOLDER = "tradeservice/agreements";
export const AGREEMENT_RECORD_FOLDER = `${AGREEMENT_FOLDER}/records`;

/** How long an opened address lives. */
export const SIGNED_URL_TTL_SECONDS = 120;

/** The seam tests swap -- never the real account. */
export interface AgreementStorage {
  /** Stores the file privately; resolves to its key, rejects when the store cannot take it. */
  upload(folder: string, bytes: Uint8Array): Promise<string>;
  /** A short-lived address that opens the stored file. */
  signedUrl(storageKey: string, now?: Date): { url: string; expiresAt: Date };
}

/** The real store, or null when Cloudinary is not set up. */
export function cloudinaryAgreementStorage(config: CloudinaryConfig | null = readCloudinaryConfig()): AgreementStorage | null {
  if (config === null) return null;
  return {
    async upload(folder, bytes) {
      const publicId = `${folder}/${randomUUID()}.pdf`;
      const timestamp = Math.floor(Date.now() / 1000);
      const signed = { public_id: publicId, timestamp, type: "private" };
      const form = new FormData();
      form.set("file", new Blob([Buffer.from(bytes)], { type: "application/pdf" }), "agreement.pdf");
      form.set("api_key", config.apiKey);
      form.set("timestamp", String(timestamp));
      form.set("public_id", publicId);
      form.set("type", "private");
      form.set("signature", signParams(signed, config.apiSecret));
      const response = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/raw/upload`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        throw new Error(`Cloudinary refused the upload (${String(response.status)}): ${await response.text()}`);
      }
      const body = (await response.json()) as { public_id?: unknown };
      return typeof body.public_id === "string" ? body.public_id : publicId;
    },
    signedUrl(storageKey, now = new Date()) {
      const timestamp = Math.floor(now.getTime() / 1000);
      const expiresAtSeconds = timestamp + SIGNED_URL_TTL_SECONDS;
      const signed = { expires_at: expiresAtSeconds, public_id: storageKey, timestamp, type: "private" };
      const query = new URLSearchParams({
        api_key: config.apiKey,
        expires_at: String(expiresAtSeconds),
        public_id: storageKey,
        timestamp: String(timestamp),
        type: "private",
        signature: signParams(signed, config.apiSecret),
      });
      return {
        url: `https://api.cloudinary.com/v1_1/${config.cloudName}/raw/download?${query.toString()}`,
        expiresAt: new Date(expiresAtSeconds * 1000),
      };
    },
  };
}
