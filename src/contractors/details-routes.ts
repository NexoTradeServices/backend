// GET / PUT /api/contractor/details -- Feature 2005, contractor My details.
//
// The contractor's OWN page: the contractor comes from the session, never the URL (the dashboard's door).
// Bob edits only his address, emergency contact and bank details; everything else is read-only here and any
// other field in the body is ignored. Replacing bank details already on file stamps who and when and emails
// the contractor and the office (bank-change.ts); the payout is not held. The address is for the file, so it
// has no state check.
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { bankStamp, sendBankChanged } from "./bank-change.js";
import { isPlacesAddress, isValidBsb, optionalString } from "./routes.js";

async function loadOwn(client: PrismaClient, userId: string) {
  return client.contractor.findUnique({ where: { userId }, include: { specialties: { orderBy: { trade: "asc" } } } });
}

function viewOf(contractor: NonNullable<Awaited<ReturnType<typeof loadOwn>>>) {
  return {
    own: {
      address: contractor.address,
      emergencyContactName: contractor.emergencyContactName,
      emergencyContactPhone: contractor.emergencyContactPhone,
      payoutBsb: contractor.payoutBsb,
      payoutAccountNo: contractor.payoutAccountNo,
      payoutAccountName: contractor.payoutAccountName,
    },
    office: {
      name: contractor.name,
      code: contractor.code,
      email: contractor.email,
      phone: contractor.phone,
      businessName: contractor.businessName,
      abn: contractor.abn,
      gstRegistered: contractor.gstRegistered,
      operatingState: contractor.operatingState,
      specialties: contractor.specialties.map((s) => ({
        trade: s.trade,
        licenceNumber: s.licenceNumber,
        licenceExpiry: s.licenceExpiry.toISOString().slice(0, 10),
      })),
      insurer: contractor.insurer,
      insurancePolicyNo: contractor.insurancePolicyNo,
      insuranceExpiry: contractor.insuranceExpiry ? contractor.insuranceExpiry.toISOString().slice(0, 10) : null,
      status: contractor.status,
    },
  };
}

export function contractorDetailsRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/details", requireRole(Role.contractor), (req: Request, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      const contractor = await loadOwn(client, req.authUser.id);
      if (!contractor) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(viewOf(contractor));
    })().catch((error: unknown) => {
      console.error("GET /api/contractor/details failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.put("/details", requireRole(Role.contractor), (req: Request, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      const contractor = await loadOwn(client, req.authUser.id);
      if (!contractor) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const bad = (error: string, field: string) => res.status(400).json({ error, field });

      // Only the six own fields are read; a body that names anything else is simply not read for it.
      let address: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
      if (b["address"] === null) address = Prisma.DbNull;
      else if (b["address"] !== undefined) {
        if (!isPlacesAddress(b["address"])) return void bad("Pick the address from the list, or clear the field.", "address");
        address = b["address"];
      }
      const emergencyContactName = optionalString(b["emergencyContactName"]);
      if (emergencyContactName === undefined) return void bad("invalid emergency contact name", "emergencyContactName");
      const emergencyContactPhone = optionalString(b["emergencyContactPhone"]);
      if (emergencyContactPhone === undefined) return void bad("invalid emergency contact phone", "emergencyContactPhone");
      const payoutBsb = optionalString(b["payoutBsb"]);
      if (payoutBsb === undefined) return void bad("invalid BSB", "payoutBsb");
      if (payoutBsb !== null && !isValidBsb(payoutBsb)) return void bad("A BSB is six digits.", "payoutBsb");
      const payoutAccountNo = optionalString(b["payoutAccountNo"]);
      if (payoutAccountNo === undefined) return void bad("invalid account number", "payoutAccountNo");
      const payoutAccountName = optionalString(b["payoutAccountName"]);
      if (payoutAccountName === undefined) return void bad("invalid account name", "payoutAccountName");

      const after = { payoutBsb, payoutAccountNo, payoutAccountName };
      const now = new Date();
      const stamp = bankStamp(contractor, after, req.authUser.id, now);
      const updated = await client.contractor.update({
        where: { id: contractor.id },
        data: { ...(address === undefined ? {} : { address }), emergencyContactName, emergencyContactPhone, ...after, ...stamp },
        include: { specialties: { orderBy: { trade: "asc" } } },
      });
      if (Object.keys(stamp).length > 0) await sendBankChanged(client, contractor, now);
      res.json(viewOf(updated));
    })().catch((error: unknown) => {
      console.error("PUT /api/contractor/details failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
