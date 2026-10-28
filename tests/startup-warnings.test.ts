// Feature 1015, every outside service announces itself at boot -- AC1 to AC3 (backend).
//
// AC1  no Cloudinary keys: exactly one `photos:` line naming the missing keys
// AC2  no RECAPTCHA_SECRET_KEY: exactly one `enquiries:` line
// AC3  every key set: neither line
//
// "Still boots and serves requests" rests on the two functions only ever
// calling console.warn: nothing here throws, and notifications-boot-resilience
// keeps proving the boot itself.
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { warnIfCloudinaryMissing } from "../src/photos/cloudinary.js";
import { warnIfRecaptchaMissing } from "../src/enquiries/recaptcha.js";

const CLOUDINARY_ENV = {
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-key",
  CLOUDINARY_API_SECRET: "test-secret",
  CLOUDINARY_UPLOAD_PRESET: "test-preset",
};

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe("AC1 -- Cloudinary", () => {
  test("one key missing: one line naming it", () => {
    warnIfCloudinaryMissing({ ...CLOUDINARY_ENV, CLOUDINARY_API_SECRET: "" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      "photos: CLOUDINARY_API_SECRET is not set -- photo uploads and contractor agreement files are off until it is",
    );
  });

  test("all four missing: still one line, every key named", () => {
    warnIfCloudinaryMissing({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      "photos: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_UPLOAD_PRESET are not set -- photo uploads and contractor agreement files are off until they are",
    );
  });
});

describe("AC2 -- reCAPTCHA", () => {
  test("no secret: one line", () => {
    vi.stubEnv("RECAPTCHA_SECRET_KEY", "");
    warnIfRecaptchaMissing();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      "enquiries: RECAPTCHA_SECRET_KEY is not set -- web enquiries are not bot-checked until it is",
    );
  });
});

describe("AC3 -- everything set", () => {
  test("neither line appears", () => {
    vi.stubEnv("RECAPTCHA_SECRET_KEY", "test-secret");
    warnIfCloudinaryMissing(CLOUDINARY_ENV);
    warnIfRecaptchaMissing();
    expect(warn).not.toHaveBeenCalled();
  });

  test("the receipt preset has a fallback and is never checked", () => {
    warnIfCloudinaryMissing({ ...CLOUDINARY_ENV, CLOUDINARY_RECEIPT_UPLOAD_PRESET: "" });
    expect(warn).not.toHaveBeenCalled();
  });
});
