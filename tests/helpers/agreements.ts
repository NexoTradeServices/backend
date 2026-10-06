// Test helpers -- Feature 2006, contractor agreement.
//
// A fake file store (never the real Cloudinary account), a real, tiny PDF to
// publish, and a reader for the text of the PDFs the backend makes.
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import type { AgreementStorage } from "../../src/agreements/storage.js";

export interface FakeStorage extends AgreementStorage {
  /** every stored file, by key */
  files: Map<string, Uint8Array>;
  /** the folder each key was stored in */
  folders: string[];
  /** true makes every upload fail, as with Cloudinary down */
  down: boolean;
  /** every address handed out */
  opened: { key: string; expiresAt: Date }[];
}

export function fakeStorage(): FakeStorage {
  const storage: FakeStorage = {
    files: new Map(),
    folders: [],
    down: false,
    opened: [],
    upload(folder, bytes) {
      if (storage.down) return Promise.reject(new Error("storage down"));
      const key = `${folder}/fake-${String(storage.files.size + 1)}.pdf`;
      storage.files.set(key, bytes);
      storage.folders.push(folder);
      return Promise.resolve(key);
    },
    signedUrl(key, now = new Date()) {
      const expiresAt = new Date(now.getTime() + 120_000);
      storage.opened.push({ key, expiresAt });
      return { url: `https://files.test/${key}?expires=${String(expiresAt.getTime())}`, expiresAt };
    },
  };
  return storage;
}

/** A real one-page PDF; `note` makes two files differ. */
export async function makePdf(note = "agreement"): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText(note);
  return Buffer.from(await pdf.save());
}

/** The text a pdf-lib-made PDF shows: inflate every stream and read its hex-encoded show-text operands. */
export function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content = match[1] ?? "";
    try {
      content = inflateSync(Buffer.from(content, "latin1")).toString("latin1");
    } catch {
      // an uncompressed stream is read as it is
    }
    for (const shown of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      out.push(Buffer.from(shown[1] ?? "", "hex").toString("latin1"));
    }
  }
  return out.join("\n");
}
