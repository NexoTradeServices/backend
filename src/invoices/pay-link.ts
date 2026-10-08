// The pay-link loop -- Feature 6001, invoice at completion.
//
// Payments (Stripe) / Core (the pay link; Stripe unreachable at invoice time).
// An invoice issues the moment Bob presses Complete; its Stripe Payment Link is
// made straight after, and only once the link exists do the invoice email and
// text go. With Stripe unreachable (or no key) the invoice still issues, Complete
// still succeeds, and this loop keeps asking Stripe every few minutes, without
// limit, until it answers.
//
// CLAIMED THE DISPATCHER'S WAY: SELECT ... FOR UPDATE SKIP LOCKED inside a
// transaction that stays open across the Stripe call, so two loops (two
// machines during a deploy overlap) never both make a link for one invoice. The
// link, its id and the two message rows commit together or not at all; Stripe's
// idempotency key (stripe.ts) covers a lost answer.
import { getPrisma, type PrismaClient } from "../db/client.js";
import { askInvoiceMessages } from "./messages.js";
import { stripeProvider, warnIfStripeMissing, type PayLinkProvider } from "./stripe.js";

/** The running loop asks Stripe this often. */
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_BATCH = 25;
/** A claim holds its row across the Stripe call; the adapter caps its own request well inside this. */
const TRANSACTION_TIMEOUT_MS = 40_000;

interface Waiting {
  id: string;
}

/** One waiting invoice, locked, sent to Stripe and stored -- or null when none is due or free. */
async function claimAndLinkOne(
  client: PrismaClient,
  provider: PayLinkProvider,
  alreadyHandled: string[],
  onlyInvoiceId: string | null,
): Promise<string | null> {
  return client.$transaction(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<Waiting[]>(
        `
        SELECT i.id
          FROM "Invoice" i
         WHERE i.status = 'sent'
           AND i."isZeroDollar" = false
           AND i."stripePaymentLinkUrl" IS NULL
           AND i.id <> ALL($1::text[])
           AND ($2::text IS NULL OR i.id = $2::text)
         ORDER BY i."createdAt"
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      `,
        alreadyHandled,
        onlyInvoiceId,
      );
      const row = rows[0];
      if (row === undefined) return null;

      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: row.id },
        include: { job: { select: { reference: true } } },
      });
      // A throw here (Stripe down) rolls the transaction back: nothing stored, nothing sent.
      const link = await provider.createPayLink({
        invoiceId: invoice.id,
        invoiceReference: invoice.reference,
        jobReference: invoice.job.reference,
        amount: invoice.amount,
      });
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { stripePaymentLinkUrl: link.url, stripePaymentLinkId: link.id },
      });
      await askInvoiceMessages(tx, invoice.id);
      return invoice.id;
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );
}

/**
 * One pass: make the pay link for every waiting invoice (up to `limit`) and send
 * its messages. Returns how many invoices got their link. A Stripe failure on one
 * invoice is logged and left for the next pass; it never throws.
 */
export async function payLinkPass(
  client: PrismaClient = getPrisma(),
  options: { limit?: number; invoiceId?: string; provider?: PayLinkProvider | null } = {},
): Promise<number> {
  const provider = options.provider === undefined ? stripeProvider() : options.provider;
  if (provider === null) return 0;
  const limit = options.limit ?? DEFAULT_BATCH;
  const handled: string[] = [];
  let linked = 0;
  while (handled.length < limit) {
    try {
      const id = await claimAndLinkOne(client, provider, handled, options.invoiceId ?? null);
      if (id === null) break;
      handled.push(id);
      linked += 1;
    } catch (error: unknown) {
      // Stripe (or the database) said no; every invoice is in the same boat, so stop this pass.
      console.error("pay-link pass failed -- trying again next pass", error);
      break;
    }
  }
  return linked;
}

/** Complete's own first try, straight after its transaction commits. Not awaited by the response; never throws. */
export function kickPayLink(client: PrismaClient, invoiceId: string): void {
  void payLinkPass(client, { invoiceId, limit: 1 }).catch((error: unknown) => {
    console.error("pay-link kick failed", error);
  });
}

export interface PayLinkLoop {
  stop(): Promise<void>;
}

export interface PayLinkLoopOptions {
  client?: PrismaClient;
  intervalMs?: number;
}

/** The running loop, started from the API's boot beside the notification dispatcher. */
export function startPayLinkLoop(options: PayLinkLoopOptions = {}): PayLinkLoop {
  const client = options.client ?? getPrisma();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  warnIfStripeMissing();

  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = inFlight.then(async () => {
      if (stopped) return;
      await payLinkPass(client);
    });
  }, intervalMs);
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
