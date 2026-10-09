// POST /api/test-data/sweep -- Feature 9002.
// POST /api/test-data/jobs/:reference/pay-link -- Feature 6001.
// POST /api/test-data/jobs/:reference/paid -- Feature 6002.
// POST /api/test-data/jobs/:reference/due -- Feature 6002.
// POST /api/test-data/settlements/run -- Feature 6003.
// POST /api/test-data/settlements/:reference/approve-link -- Feature 6003.
// POST /api/test-data/jobs/:reference/correction-note -- Feature 6003.
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
//
// The paid hook runs the ONE paid step (payments/paid.ts) with a fake card payment
// (payment intent `pi_test_<invoice reference>`), so a browser test reaches Paid
// without Stripe. Sent twice, it is the same payment twice: nothing more happens.
//
// The due hook moves a test job's invoice's due date to `days` from now (negative:
// overdue), so the Receivables browser test can put rows in a known order. Only an
// invoice labelled as test data is moved.
//
// The settlement hook runs the Monday run (settlements/sweep.ts runWeekly) as of `now` (default:
// the real now), so a browser test or a UAT hand check reaches "a draft invoice" without waiting
// for a Monday. Run twice for the same week it does nothing the second time, exactly as live.
// Called with the test-run cookie it sweeps only that label's own work (the owner's UAT records
// are never touched).
//
// The approve-link hook mints a fresh approve link for a settlement labelled as test data and
// hands back its URL: the real link only ever exists inside a delivered email, which a browser
// test cannot read. The correction-note hook writes the `correction` note Correct & reissue
// (Feature 6007) will write, onto a labelled job, so the "Job corrected since" flag can be seen.
import type { Express, Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { currentLabel, isProduction, isValidLabel } from "./label.js";
import { payLinkPass } from "../invoices/pay-link.js";
import { recordConfirmedPayment } from "../payments/paid.js";
import { FAKE_PAY_LINK_PREFIX } from "./fake-stripe.js";
import { sweepTestData } from "./sweep.js";
import { runWeekly } from "../settlements/sweep.js";
import { randomUUID } from "node:crypto";
import { CapabilityTokenType, mintCapabilityLink } from "../capability-tokens/index.js";
import { readNotes } from "../jobs/notes.js";

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
            Promise.resolve({ url: `https://pay.test/${request.invoiceReference}`, id: `${FAKE_PAY_LINK_PREFIX}${request.invoiceReference}` }),
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

  router.post("/jobs/:reference/paid", (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const invoice = await client.invoice.findFirst({
        where: { job: { reference: req.params.reference } },
        orderBy: { createdAt: "desc" },
        select: { id: true, reference: true, amount: true },
      });
      if (invoice === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const outcome = await recordConfirmedPayment(client, {
        invoiceId: invoice.id,
        paymentIntentId: `pi_test_${invoice.reference}`,
        amount: invoice.amount,
        method: "card",
        paidAt: new Date(),
      });
      res.json({ outcome });
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/jobs/:reference/paid failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  router.post("/jobs/:reference/due", (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const days = (req.body as { days?: unknown } | undefined)?.days;
      if (typeof days !== "number" || !Number.isInteger(days) || Math.abs(days) > 365) {
        res.status(400).json({ error: "days must be a whole number of days from now" });
        return;
      }
      const invoice = await client.invoice.findFirst({
        where: { job: { reference: req.params.reference }, testData: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (invoice === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      await client.invoice.update({ where: { id: invoice.id }, data: { dueAt: new Date(Date.now() + days * 86_400_000) } });
      res.json({ moved: true });
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/jobs/:reference/due failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  router.post("/settlements/run", (req: Request, res: Response) => {
    void (async () => {
      const raw = (req.body as { now?: unknown } | undefined)?.now;
      const now = raw === undefined ? new Date() : typeof raw === "string" ? new Date(raw) : null;
      if (now === null || Number.isNaN(now.getTime())) {
        res.status(400).json({ error: "now must be an ISO date-time" });
        return;
      }
      // A browser test's run (its cookie carries the e2e label) sweeps only its own work: it never
      // touches the owner's UAT records, nor makes one draft too many beside them.
      const label = currentLabel();
      res.json(await runWeekly(client, now, label === null ? {} : { onlyLabel: label }));
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/settlements/run failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  router.post("/settlements/:reference/approve-link", (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const settlement = await client.contractorSettlement.findFirst({
        where: { reference: req.params.reference, testData: { not: null } },
        select: { id: true },
      });
      if (settlement === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const minted = await mintCapabilityLink(client, { type: CapabilityTokenType.approve, settlementId: settlement.id });
      res.json({ url: minted.url, path: new URL(minted.url).pathname });
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/settlements/:reference/approve-link failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  router.post("/jobs/:reference/correction-note", (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const job = await client.job.findFirst({
        where: { reference: req.params.reference, testData: { not: null } },
        select: { id: true, operatorNotes: true },
      });
      const operator = await client.user.findFirst({ where: { role: "ops" }, select: { id: true } });
      if (job === null || operator === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const note = { id: randomUUID(), at: new Date().toISOString(), operatorId: operator.id, type: "correction", note: "Missing half hour added." };
      await client.job.update({ where: { id: job.id }, data: { operatorNotes: [...readNotes(job.operatorNotes), note] as unknown as Prisma.InputJsonArray } });
      res.json({ added: true });
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/jobs/:reference/correction-note failed", error);
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
