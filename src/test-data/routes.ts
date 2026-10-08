// POST /api/test-data/sweep -- Feature 9002.
// POST /api/test-data/jobs/:reference/pay-link -- Feature 6001.
//
// Lets the browser tests clear their own label from wherever they run (the dev
// machine, CI). Mounted only when NODE_ENV is not production -- absent, not
// merely refused (index.ts); the sweep itself refuses production as well.
//
// The pay-link hook gives a job's invoice, if it is still waiting, a FAKE pay link
// (https://pay.test/<reference>) and sends its messages, exactly as the real
// loop does once Stripe answers -- so a browser test can reach "an invoice with
// a link" on a machine with no Stripe key (CI) and never depends on Stripe being
// reachable. An invoice that already has a link is left alone.
import type { Express, Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { isProduction, isValidLabel } from "./label.js";
import { payLinkPass } from "../invoices/pay-link.js";
import { sweepTestData } from "./sweep.js";

export function testDataRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.post("/sweep", (req: Request, res: Response) => {
    void (async () => {
      const label = (req.body as { label?: unknown } | undefined)?.label;
      if (!isValidLabel(label)) {
        res.status(400).json({ error: "label must be a short lowercase word such as e2e or uat-9002" });
        return;
      }
      res.json(await sweepTestData(client, label));
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/sweep failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  router.post("/jobs/:reference/pay-link", (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const invoice = await client.invoice.findFirst({ where: { job: { reference: req.params.reference } }, select: { id: true } });
      if (invoice === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const made = await payLinkPass(client, {
        invoiceId: invoice.id,
        limit: 1,
        provider: {
          createPayLink: (request) =>
            Promise.resolve({ url: `https://pay.test/${request.invoiceReference}`, id: `plink_test_${request.invoiceReference}` }),
        },
      });
      // `linked` tells the test whether the invoice has a link now: false while a real
      // attempt holds the row (its Stripe call is still in flight) -- ask again in a moment.
      const after = await client.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { stripePaymentLinkUrl: true } });
      res.json({ made, linked: after.stripePaymentLinkUrl !== null });
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/jobs/:reference/pay-link failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  return router;
}

/** Mounts the test-data routes -- and only outside production: there it is absent, not refused. */
export function mountTestDataRoutes(app: Express, client: PrismaClient): void {
  if (isProduction()) return;
  app.use("/api/test-data", testDataRoutes(client));
}
