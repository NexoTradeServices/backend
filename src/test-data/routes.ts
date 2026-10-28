// POST /api/test-data/sweep -- Feature 9002.
// POST /api/test-data/jobs/:reference/pay-link -- Feature 6001.
// POST /api/test-data/jobs/:reference/paid -- Feature 6002.
// POST /api/test-data/jobs/:reference/due -- Feature 6002.
// POST /api/test-data/settlements/run -- Feature 6003.
// POST /api/test-data/daily/run -- Feature 6008.
// POST /api/test-data/settlements/:reference/approve-link -- Feature 6003.
// POST /api/test-data/settlements/:reference/status -- Feature 6007.
// POST /api/test-data/jobs/:reference/correction -- Feature 6007.
// POST /api/test-data/customer-login -- Feature 1018.
// POST /api/test-data/jobs/:reference/review-link -- Feature 6009.
// POST /api/test-data/customers/set-password-link -- Feature 3004.
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
// without Stripe. Sent twice, it is the same payment twice: nothing more happens. With
// `{ "refuseRefund": true }` the intent is `pi_test_refuse_<invoice reference>`, which the pretend
// refund provider (fake-stripe.ts) refuses -- so a browser test can see Stripe's "no" (Feature 6006).
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
// The daily hook runs the daily sweep's steps now (daily/index.ts), whatever the hour; the optional
// `today` (YYYY-MM-DD) runs it as that business day, so the 7-day gap between the two invoice
// reminders can be crossed without waiting. Like the live run it is idempotent. Called with the
// test-run cookie it does only that label's own invoices (the owner's UAT records are never
// touched); without the cookie it acts on every owed invoice, the same as the real morning run.
//
// The approve-link hook mints a fresh approve link for a settlement labelled as test data and
// hands back its URL: the real link only ever exists inside a delivered email, which a browser
// test cannot read. The status hook (Feature 6007) turns a labelled draft into an approved or a paid
// invoice -- the contractor's tap, and Mike's mark-paid, in one step -- so a browser test reaches the
// weeks Correct & reissue must never reopen. The correction hook writes a correction row of any size onto
// a labelled job's contractor, so a browser test can reach "a deduction bigger than the week's pay for
// work" (Still to deduct) whatever other work happens to be waiting.
//
// The review-link hook mints a fresh review link for a completed job labelled as test data and hands
// back its URL (the real link only ever exists inside a delivered email). With `{ "state": "used" }` the
// link is spent, with `{ "state": "expired" }` it is past its 30 days; otherwise it is open.
//
// The set-password-link hook hands back the path of the Set a new password page for the latest
// Set your password email sent to a customer labelled as test data (the real link only ever exists
// inside a delivered email, which a browser test cannot read).
//
// The customer-login hook makes a labelled customer User with the dev password and answers its
// email and name. The seeded cast has no customer login (Sarah is a guest by design, 1003 AC9),
// so a browser test of the customer portal makes its own. Only with the test-run cookie: the row
// carries the label and the sweep removes it with the rest.
import type { Express, Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { currentLabel, isProduction, isValidLabel } from "./label.js";
import { payLinkPass } from "../invoices/pay-link.js";
import { recordConfirmedPayment } from "../payments/paid.js";
import { FAKE_PAY_LINK_PREFIX } from "./fake-stripe.js";
import { sweepTestData } from "./sweep.js";
import { runWeekly } from "../settlements/sweep.js";
import { runDailySteps } from "../daily/index.js";
import { randomUUID } from "node:crypto";
import { CapabilityTokenType, mintCapabilityLink } from "../capability-tokens/index.js";
import { gstOnTop, labourOf } from "../settlements/invoice-view.js";
import { passwordHasher } from "../auth/dev-password.js";
import { DEV_PASSWORD } from "../db/seed/auth.js";

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
          deactivatePayLink: () => Promise.resolve(),
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
      const refuse = (req.body as { refuseRefund?: unknown } | undefined)?.refuseRefund === true;
      const outcome = await recordConfirmedPayment(client, {
        invoiceId: invoice.id,
        paymentIntentId: refuse ? `pi_test_refuse_${invoice.reference}` : `pi_test_${invoice.reference}`,
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

  router.post("/daily/run", (req: Request, res: Response) => {
    void (async () => {
      const today = (req.body as { today?: unknown } | undefined)?.today;
      if (today !== undefined && (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today))) {
        res.status(400).json({ error: "today must be a YYYY-MM-DD business day" });
        return;
      }
      // A browser test's run (its cookie carries the e2e label) does only its own labelled work:
      // it never sends a reminder for the owner's UAT invoices.
      res.json(await runDailySteps(client, { ...(today === undefined ? {} : { today }), label: currentLabel() }));
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/daily/run failed", error);
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

  router.post("/jobs/:reference/review-link", (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const state = (req.body as { state?: unknown } | undefined)?.state;
      if (state !== undefined && state !== "open" && state !== "used" && state !== "expired") {
        res.status(400).json({ error: "state must be open, used or expired" });
        return;
      }
      const job = await client.job.findFirst({ where: { reference: req.params.reference, testData: { not: null } }, select: { id: true } });
      if (job === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const minted = await mintCapabilityLink(client, { type: CapabilityTokenType.review, jobId: job.id });
      if (state === "used") await client.capabilityToken.update({ where: { id: minted.tokenId }, data: { usedAt: new Date() } });
      if (state === "expired") await client.capabilityToken.update({ where: { id: minted.tokenId }, data: { expiresAt: new Date(Date.now() - 86_400_000) } });
      res.json({ url: minted.url, path: new URL(minted.url).pathname });
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/jobs/:reference/review-link failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  router.post("/settlements/:reference/status", (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const status = (req.body as { status?: unknown } | undefined)?.status;
      if (status !== "approved" && status !== "paid") {
        res.status(400).json({ error: "status must be approved or paid" });
        return;
      }
      const settlement = await client.contractorSettlement.findFirst({
        where: { reference: req.params.reference, testData: { not: null } },
        include: { contractor: { select: { gstRegistered: true } } },
      });
      const operator = await client.user.findFirst({ where: { role: "ops" }, select: { id: true } });
      if (settlement === null || operator === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (settlement.status !== "draft" && !(settlement.status === "approved" && status === "paid")) {
        res.status(409).json({ error: "only a draft can be approved, and only an approved one paid" });
        return;
      }
      const now = new Date();
      const settings = await client.platformSettings.findFirstOrThrow({ select: { gstRatePercent: true } });
      const registered = settlement.contractor.gstRegistered === true;
      await client.contractorSettlement.update({
        where: { id: settlement.id },
        data: {
          ...(settlement.status === "draft"
            ? {
                status: "approved" as const,
                approvedAt: now,
                contractorGstRegistered: settlement.contractor.gstRegistered ?? false,
                gstAmount: gstOnTop(labourOf(settlement.breakdownByTrade) + settlement.adjustmentsAmount, registered, Number(settings.gstRatePercent)),
              }
            : {}),
          ...(status === "paid" ? { status: "paid" as const, paidAt: now, paidByUserId: operator.id, paymentReference: settlement.reference } : {}),
        },
      });
      res.json({ reference: settlement.reference, status });
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/settlements/:reference/status failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  router.post("/jobs/:reference/correction", (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as { amount?: unknown; reason?: unknown };
      if (typeof body.amount !== "number" || !Number.isInteger(body.amount) || body.amount === 0 || typeof body.reason !== "string" || body.reason === "") {
        res.status(400).json({ error: "amount must be a whole number of cents, not zero, and reason is required" });
        return;
      }
      const job = await client.job.findFirst({
        where: { reference: req.params.reference, testData: { not: null } },
        select: { id: true, assignments: { where: { status: "completed" }, select: { contractorId: true }, take: 1 } },
      });
      const operator = await client.user.findFirst({ where: { role: "ops" }, select: { id: true } });
      const contractorId = job?.assignments[0]?.contractorId;
      if (job === null || operator === null || contractorId === undefined) {
        res.status(404).json({ error: "not found" });
        return;
      }
      await client.contractorPayAdjustment.create({
        data: { contractorId, amount: body.amount, kind: "correction", reason: body.reason, jobId: job.id, createdByUserId: operator.id },
      });
      res.json({ added: true });
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/jobs/:reference/correction failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  router.post("/customers/set-password-link", (req: Request, res: Response) => {
    void (async () => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      if (typeof email !== "string") {
        res.status(400).json({ error: "email is required" });
        return;
      }
      const customer = await client.customer.findFirst({
        where: { email: email.trim().toLowerCase(), testData: { not: null } },
        select: { userId: true },
      });
      if (customer?.userId === null || customer === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const row = await client.notification.findFirst({
        where: { type: "customer_set_password", recipientType: "user", recipientId: customer.userId },
        orderBy: { createdAt: "desc" },
      });
      const resetUrl = (row?.context as { resetUrl?: string } | null | undefined)?.resetUrl;
      const token = resetUrl === undefined ? null : /\/reset-password\/([^?]+)/.exec(resetUrl)?.[1];
      if (token === null || token === undefined) {
        res.status(404).json({ error: "no set-password email sent" });
        return;
      }
      res.json({ path: `/reset-password?token=${token}` });
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/customers/set-password-link failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  router.post("/customer-login", (_req: Request, res: Response) => {
    void (async () => {
      if (currentLabel() === null) {
        res.status(400).json({ error: "a customer login is made only for a test run" });
        return;
      }
      const email = `customer-${randomUUID().slice(0, 8)}@idelta.com.au`;
      const name = "Sarah Chen";
      const user = await client.user.create({ data: { name, email, role: "customer" } });
      const hash = await passwordHasher().hash(DEV_PASSWORD);
      await client.account.create({ data: { userId: user.id, providerId: "credential", accountId: user.id, password: hash } });
      res.json({ email, name, password: DEV_PASSWORD });
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/customer-login failed", error);
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
