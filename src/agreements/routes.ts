// The contractor agreement -- Feature 2006.
//
// Owner: publish a version (a PDF), list the versions. Everyone concerned:
// open a file through a short-lived signed address after the backend's own
// check. The contractor: read his agreement and accept it. Versions and
// acceptances are never edited or deleted. Mounted at /api.
import { createHash } from "node:crypto";
import type { Router } from "express";
import express, { Router as createRouter } from "express";
import type { Request, Response } from "express";
import { PDFDocument } from "pdf-lib";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { sendNotification } from "../notifications/index.js";
import { currentAgreement } from "./current.js";
import { makeAcceptanceRecord } from "./pdf.js";
import {
  AGREEMENT_FOLDER,
  AGREEMENT_RECORD_FOLDER,
  cloudinaryAgreementStorage,
  type AgreementStorage,
} from "./storage.js";

export const MAX_AGREEMENT_BYTES = 10 * 1024 * 1024;
const MAX_LABEL_LENGTH = 40;

export const STORE_FAILED = "Couldn't store the file - try again shortly";
export const LEGAL_IDENTITY_INCOMPLETE = "Fill in the legal name, ABN and address in Settings first";

export interface AgreementRouteOptions {
  /** The file store, or null for "not set up". Tests swap it; the default is Cloudinary. */
  storage?: () => AgreementStorage | null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/** The trusted client-IP header (ip-config.ts), else the socket's own address. */
function clientIp(req: Request): string {
  const header = process.env["AUTH_TRUSTED_IP_HEADER"];
  if (header) {
    const raw = req.get(header);
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function looksLikePdf(bytes: Buffer): Promise<boolean> {
  if (bytes.length < 8 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return false;
  try {
    await PDFDocument.load(bytes, { ignoreEncryption: true });
    return true;
  } catch {
    return false;
  }
}

export function agreementRoutes(client: PrismaClient, options: AgreementRouteOptions = {}): Router {
  const router = createRouter();
  const storageOf = options.storage ?? (() => cloudinaryAgreementStorage());

  /** Makes and stores one acceptance's stamped record; resolves to its key, or null when the store is down. */
  async function makeRecord(acceptanceId: string): Promise<string | null> {
    const storage = storageOf();
    if (storage === null) return null;
    try {
      const acceptance = await client.contractorAgreementAcceptance.findUniqueOrThrow({
        where: { id: acceptanceId },
        include: { contractor: { select: { name: true, code: true } }, agreementVersion: true },
      });
      const settings = await client.platformSettings.findFirstOrThrow();
      const bytes = await makeAcceptanceRecord({
        legalEntityName: settings.legalEntityName,
        businessAbn: settings.businessAbn ?? "",
        businessAddress: settings.businessAddress,
        contractorName: acceptance.contractor.name,
        contractorCode: acceptance.contractor.code,
        version: acceptance.agreementVersion.version,
        versionIssuedAt: acceptance.agreementVersion.issuedAt,
        acceptedAt: acceptance.acceptedAt,
        timezone: settings.timezone,
        ip: acceptance.acceptedFromIp,
        userAgent: acceptance.userAgent,
        documentHash: acceptance.agreementVersion.documentHash,
        operatorPhone: settings.operatorPhone,
        operatorEmail: settings.operatorEmail,
      });
      const key = await storage.upload(AGREEMENT_RECORD_FOLDER, bytes);
      await client.contractorAgreementAcceptance.update({ where: { id: acceptanceId }, data: { recordStorageKey: key } });
      return key;
    } catch (error: unknown) {
      console.error("agreement record could not be stored", error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Owner: list and publish
  // -------------------------------------------------------------------------

  router.get("/agreements", requireRole(Role.owner), (_req: Request, res: Response) => {
    void (async () => {
      const [versions, activeContractors] = await Promise.all([
        client.contractorAgreementVersion.findMany({
          orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
          include: { issuedBy: { select: { name: true } } },
        }),
        client.contractor.count({ where: { status: "active" } }),
      ]);
      res.json({
        activeContractors,
        versions: versions.map((v, index) => ({
          id: v.id,
          version: v.version,
          issuedAt: v.issuedAt.toISOString(),
          issuedBy: v.issuedBy.name,
          current: index === 0,
        })),
      });
    })().catch((error: unknown) => {
      console.error("GET /api/agreements failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  // The PDF is the request body (Content-Type application/pdf), its label the
  // `label` query value: no multipart parsing, nothing new to install.
  router.post(
    "/agreements",
    requireRole(Role.owner),
    express.raw({ type: () => true, limit: `${String(MAX_AGREEMENT_BYTES * 2)}b` }),
    (req: Request, res: Response) => {
      void (async () => {
        const owner = req.authUser;
        if (owner === undefined) {
          res.status(401).json({ error: "not authenticated" });
          return;
        }
        const refuse = (status: number, error: string, field: string): void => {
          res.status(status).json({ error, field });
        };

        const rawLabel = req.query["label"];
        const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
        if (label === "") return refuse(400, "Enter a version label.", "version");
        if (label.length > MAX_LABEL_LENGTH) return refuse(400, "That version label is too long.", "version");
        if ((await client.contractorAgreementVersion.findUnique({ where: { version: label } })) !== null) {
          return refuse(409, "That version label is already used.", "version");
        }

        const settings = await client.platformSettings.findFirstOrThrow();
        const addressLine = settings.businessAddress;
        if (
          !settings.legalEntityName.trim() ||
          !(settings.businessAbn ?? "").trim() ||
          addressLine === null ||
          addressLine === undefined
        ) {
          return refuse(409, LEGAL_IDENTITY_INCOMPLETE, "legalIdentity");
        }

        const bytes: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (bytes.length > MAX_AGREEMENT_BYTES) {
          return refuse(400, "That file is over 10MB - choose a smaller PDF.", "file");
        }
        if (!(await looksLikePdf(bytes))) {
          return refuse(400, "That isn't a PDF - choose a PDF file.", "file");
        }

        const documentHash = createHash("sha256").update(bytes).digest("hex");
        const storage = storageOf();
        let storageKey: string;
        try {
          if (storage === null) throw new Error("Cloudinary is not set up");
          storageKey = await storage.upload(AGREEMENT_FOLDER, bytes);
        } catch (error: unknown) {
          console.error("agreement upload failed", error);
          return refuse(503, STORE_FAILED, "file");
        }

        let version;
        try {
          version = await client.contractorAgreementVersion.create({
            data: { version: label, storageKey, documentHash, issuedByUserId: owner.id },
          });
        } catch (error: unknown) {
          if (isUniqueViolation(error)) return refuse(409, "That version label is already used.", "version");
          throw error;
        }

        // The email to every active contractor: one per contractor per version.
        const contractors = await client.contractor.findMany({
          where: { status: "active" },
          select: { id: true, userId: true, name: true },
        });
        const webOrigin = process.env["WEB_ORIGIN"];
        for (const contractor of contractors) {
          await sendNotification(
            {
              type: "contractor_agreement_updated",
              channel: "email",
              recipientType: "user",
              recipientId: contractor.userId,
              idempotencyKey: `contractor_agreement_updated:contractor:${contractor.id}:${version.id}`,
              relatedType: "contractor",
              relatedId: contractor.id,
              context: {
                name: contractor.name,
                version: version.version,
                agreementUrl: `${webOrigin ?? ""}/contractor/agreement`,
              },
            },
            client,
          );
        }

        res.status(201).json({
          id: version.id,
          version: version.version,
          issuedAt: version.issuedAt.toISOString(),
          documentHash: version.documentHash,
          emailed: contractors.length,
        });
      })().catch((error: unknown) => {
        console.error("POST /api/agreements failed", error);
        res.status(500).json({ error: "internal error" });
      });
    },
  );

  // -------------------------------------------------------------------------
  // Opening a file: the owner, ops and the contractor, each by their own rule
  // -------------------------------------------------------------------------

  router.get(
    "/agreements/:id/file",
    requireRole(Role.ops, Role.contractor),
    (req: Request, res: Response) => {
      void (async () => {
        const auth = req.authUser;
        const id = String(req.params["id"]);
        const version = await client.contractorAgreementVersion.findUnique({ where: { id } });
        if (!auth || !version) {
          res.status(404).json({ error: "not found" });
          return;
        }
        if (auth.role === Role.contractor) {
          const contractor = await client.contractor.findUnique({ where: { userId: auth.id }, select: { id: true } });
          const current = await currentAgreement(client);
          const accepted =
            contractor === null
              ? null
              : await client.contractorAgreementAcceptance.findUnique({
                  where: { contractorId_agreementVersionId: { contractorId: contractor.id, agreementVersionId: id } },
                });
          if (current?.id !== id && accepted === null) {
            res.status(403).json({ error: "forbidden" });
            return;
          }
        }
        const storage = storageOf();
        if (storage === null) {
          res.status(503).json({ error: "Try again shortly" });
          return;
        }
        const { url, expiresAt } = storage.signedUrl(version.storageKey);
        res.json({ url, expiresAt: expiresAt.toISOString() });
      })().catch((error: unknown) => {
        console.error("GET /api/agreements/:id/file failed", error);
        res.status(500).json({ error: "internal error" });
      });
    },
  );

  // A contractor's stamped record -- his own latest acceptance's. The record
  // made lazily on this first open when Cloudinary was down at acceptance.
  router.get(
    "/agreements/records/:code",
    requireRole(Role.ops, Role.contractor),
    (req: Request, res: Response) => {
      void (async () => {
        const auth = req.authUser;
        const code = String(req.params["code"]);
        if (!auth) {
          res.status(401).json({ error: "not authenticated" });
          return;
        }
        const contractor = await client.contractor.findUnique({ where: { code }, select: { id: true, userId: true } });
        if (!contractor) {
          res.status(404).json({ error: "not found" });
          return;
        }
        if (auth.role === Role.contractor && contractor.userId !== auth.id) {
          res.status(403).json({ error: "forbidden" });
          return;
        }
        const acceptance = await client.contractorAgreementAcceptance.findFirst({
          where: { contractorId: contractor.id },
          orderBy: [{ acceptedAt: "desc" }, { id: "desc" }],
        });
        if (!acceptance) {
          res.status(404).json({ error: "not found" });
          return;
        }
        const storage = storageOf();
        const key = acceptance.recordStorageKey ?? (await makeRecord(acceptance.id));
        if (storage === null || key === null) {
          res.status(503).json({ error: "Try again shortly" });
          return;
        }
        const { url, expiresAt } = storage.signedUrl(key);
        res.json({ url, expiresAt: expiresAt.toISOString() });
      })().catch((error: unknown) => {
        console.error("GET /api/agreements/records/:code failed", error);
        res.status(500).json({ error: "internal error" });
      });
    },
  );

  // -------------------------------------------------------------------------
  // The contractor's own: read, accept
  // -------------------------------------------------------------------------

  router.get("/contractor/agreement", requireRole(Role.contractor), (req: Request, res: Response) => {
    void (async () => {
      const auth = req.authUser;
      const contractor = auth
        ? await client.contractor.findUnique({ where: { userId: auth.id }, select: { id: true, code: true } })
        : null;
      if (!contractor) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const [current, settings] = await Promise.all([currentAgreement(client), client.platformSettings.findFirstOrThrow()]);
      if (!current) {
        res.json({ published: false, version: null, accepted: false, acceptedAt: null, contractorCode: contractor.code });
        return;
      }
      const acceptance = await client.contractorAgreementAcceptance.findUnique({
        where: { contractorId_agreementVersionId: { contractorId: contractor.id, agreementVersionId: current.id } },
      });
      res.json({
        published: true,
        version: { id: current.id, label: current.version, issuedAt: current.issuedAt.toISOString() },
        accepted: acceptance !== null,
        acceptedAt: acceptance ? acceptance.acceptedAt.toISOString() : null,
        timezone: settings.timezone,
        contractorCode: contractor.code,
      });
    })().catch((error: unknown) => {
      console.error("GET /api/contractor/agreement failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.post("/contractor/agreement/accept", requireRole(Role.contractor), express.json(), (req: Request, res: Response) => {
    void (async () => {
      const auth = req.authUser;
      const contractor = auth
        ? await client.contractor.findUnique({ where: { userId: auth.id }, select: { id: true } })
        : null;
      if (!contractor) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const body = req.body as { versionId?: unknown } | undefined;
      const versionId = typeof body?.versionId === "string" ? body.versionId : "";
      const current = await currentAgreement(client);
      if (!current || current.id !== versionId) {
        res.status(409).json({ error: "That is not the current version of the agreement." });
        return;
      }

      let acceptanceId: string;
      try {
        acceptanceId = await client.$transaction(async (tx) => {
          const acceptance = await tx.contractorAgreementAcceptance.create({
            data: {
              contractorId: contractor.id,
              agreementVersionId: current.id,
              acceptedFromIp: clientIp(req),
              userAgent: req.get("user-agent") ?? null,
            },
          });
          await tx.contractor.update({
            where: { id: contractor.id },
            data: { agreementVersion: current.version, agreementAcceptedAt: acceptance.acceptedAt },
          });
          return acceptance.id;
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          res.status(409).json({ error: "You have already accepted this version." });
          return;
        }
        throw error;
      }

      // The acceptance stands whatever happens next; with the store down the
      // record is made on its first open.
      await makeRecord(acceptanceId);
      res.status(201).json({ accepted: true, version: current.version });
    })().catch((error: unknown) => {
      console.error("POST /api/contractor/agreement/accept failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
