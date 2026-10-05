// Feature 3003 -- enquiry photos (the upload signature and the photo URLs)
//
// 3003 AC4  with Cloudinary set up the signature endpoint returns a signed
//           upload for the enquiry-photos folder and the preset, and never the
//           API secret; with it not set up the endpoint answers unavailable
//           (and the enquiry endpoint is untouched by that)
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { testClient } from "./helpers/database.js";
import { enquiryRoutes } from "../src/enquiries/routes.js";
import {
  ALLOWED_PHOTO_FORMATS,
  ENQUIRY_PHOTO_FOLDER,
  photoUrls,
  readCloudinaryConfig,
  type CloudinaryConfig,
} from "../src/photos/cloudinary.js";
import type { PrismaClient } from "../src/db/client.js";

const CONFIG: CloudinaryConfig = {
  cloudName: "test-cloud",
  apiKey: "123456789012345",
  apiSecret: "test-only-api-secret-value",
  uploadPreset: "tradeservice-enquiry-photos",
};

let db: PrismaClient;

function appWith(config: CloudinaryConfig | null): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/enquiries", enquiryRoutes(db, { cloudinaryConfig: () => config }));
  return app;
}

beforeAll(() => {
  db = testClient();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("the upload signature", () => {
  test("3003 AC4: set up -> a signed upload for the enquiry-photos folder and the preset, never the secret", async () => {
    const res = await request(appWith(CONFIG)).post("/api/enquiries/photo-signature").send({});
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toMatchObject({
      cloudName: "test-cloud",
      apiKey: "123456789012345",
      uploadPreset: "tradeservice-enquiry-photos",
      folder: ENQUIRY_PHOTO_FOLDER,
      allowedFormats: ALLOWED_PHOTO_FORMATS,
      returnDeleteToken: true,
    });
    expect(ENQUIRY_PHOTO_FOLDER).toBe("tradeservice/enquiry-photos");
    expect(ALLOWED_PHOTO_FORMATS).toBe("jpg,png,webp,heic");
    expect(JSON.stringify(res.body)).not.toContain(CONFIG.apiSecret);

    // The signature is Cloudinary's: sorted name=value pairs, secret appended, SHA-1.
    const timestamp = body["timestamp"] as number;
    const expected = createHash("sha1")
      .update(
        `allowed_formats=jpg,png,webp,heic&folder=tradeservice/enquiry-photos&return_delete_token=true&timestamp=${String(timestamp)}&upload_preset=tradeservice-enquiry-photos${CONFIG.apiSecret}`,
      )
      .digest("hex");
    expect(body["signature"]).toBe(expected);
    expect(Math.abs(timestamp - Date.now() / 1000)).toBeLessThan(60);
  });

  test("3003 AC4: not set up -> unavailable, and no secret anywhere", async () => {
    const res = await request(appWith(null)).post("/api/enquiries/photo-signature").send({});
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("signature");
  });

  test("3003 AC4: any one of the four settings missing reads as not set up", () => {
    const all = {
      CLOUDINARY_CLOUD_NAME: "c",
      CLOUDINARY_API_KEY: "k",
      CLOUDINARY_API_SECRET: "s",
      CLOUDINARY_UPLOAD_PRESET: "p",
    };
    expect(readCloudinaryConfig(all)).toEqual({ cloudName: "c", apiKey: "k", apiSecret: "s", uploadPreset: "p" });
    for (const name of Object.keys(all)) {
      expect(readCloudinaryConfig({ ...all, [name]: undefined })).toBeNull();
      expect(readCloudinaryConfig({ ...all, [name]: "  " })).toBeNull();
    }
  });
});

describe("the photo URLs", () => {
  test("a square thumbnail and a full-size URL, both automatic format and quality", () => {
    const urls = photoUrls("tradeservice/enquiry-photos/tap-aaa111", "test-cloud");
    expect(urls.thumbnailUrl).toBe(
      "https://res.cloudinary.com/test-cloud/image/upload/c_fill,g_auto,w_240,h_240,f_auto,q_auto/tradeservice/enquiry-photos/tap-aaa111",
    );
    expect(urls.fullUrl).toBe(
      "https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto/tradeservice/enquiry-photos/tap-aaa111",
    );
  });
});
