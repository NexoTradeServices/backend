// Voiding an invoice -- Feature 6008, invoice reminders and void.
//
// Invoicing (voiding an invoice). The operator voids an unpaid invoice with a required
// reason: status void, with who and when (the audit pair). The assignment and the
// contractor's pay are not touched. After the commit its Stripe pay link is switched off;
// a Stripe failure is logged and never undoes the void -- the daily sweep's switch-off step
// tries again for a week.
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { isFakePayLink } from "../test-data/fake-stripe.js";
import { stripeProvider } from "./stripe.js";

export const VOID_REASON_MAX = 500;
export const VOID_REASON_ERROR = "Give a reason for voiding.";

/** The reason, trimmed, or the field error. */
export function parseVoidReason(body: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const raw = (body as { reason?: unknown } | null | undefined)?.reason;
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason === "" || reason.length > VOID_REASON_MAX) return { ok: false, error: VOID_REASON_ERROR };
  return { ok: true, reason };
}

export type VoidOutcome = "voided" | "paid" | "void" | "zero_dollar" | "not_found";

export const VOID_REFUSALS: Record<Exclude<VoidOutcome, "voided" | "not_found">, string> = {
  paid: "This invoice is already paid - it can't be voided.",
  void: "This invoice is already void.",
  zero_dollar: "A zero-dollar invoice can't be voided.",
};

/** Switch a pay link off at Stripe. Never throws: false when it could not be done. */
export async function switchPayLinkOff(paymentLinkId: string, invoiceReference: string): Promise<boolean> {
  if (isFakePayLink(paymentLinkId)) return true;
  const provider = stripeProvider();
  if (provider === null) return false;
  try {
    await provider.deactivatePayLink(paymentLinkId);
    return true;
  } catch (error: unknown) {
    console.error(`invoices: the pay link of ${invoiceReference} could not be switched off -- the daily run tries again`, error);
    return false;
  }
}

type Db = Prisma.TransactionClient;

/**
 * The void itself, inside the caller's transaction (Feature 6007 voids inside Correct & reissue's):
 * the invoice row locked, guarded on `status = sent`. The pay link is NOT switched off here -- the
 * caller does that after its commit.
 */
export async function voidInTx(
  tx: Db,
  input: { invoiceId: string; userId: string; reason: string; now: Date },
): Promise<VoidOutcome> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Invoice" WHERE id = ${input.invoiceId} FOR UPDATE`;
  if (locked.length === 0) return "not_found";
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: input.invoiceId }, select: { status: true, isZeroDollar: true } });
  if (invoice.status === "paid") return "paid";
  if (invoice.status === "void") return "void";
  if (invoice.isZeroDollar) return "zero_dollar";
  const changed = await tx.invoice.updateMany({
    where: { id: input.invoiceId, status: "sent" },
    data: { status: "void", voidReason: input.reason, voidedByUserId: input.userId, voidedAt: input.now },
  });
  return changed.count === 1 ? "voided" : "paid";
}

/** After the commit: switch the voided invoice's pay link off. Never throws. */
export async function switchOffAfterVoid(client: PrismaClient, invoiceId: string): Promise<void> {
  const invoice = await client.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { stripePaymentLinkId: true, reference: true },
  });
  if (invoice.stripePaymentLinkId !== null) await switchPayLinkOff(invoice.stripePaymentLinkId, invoice.reference);
}

/**
 * Void the invoice. One transaction, guarded on `status = sent` (a payment landing at the
 * same moment wins or loses cleanly); then the pay link is switched off.
 */
export async function voidInvoice(
  client: PrismaClient,
  input: { invoiceId: string; userId: string; reason: string; now?: Date },
): Promise<VoidOutcome> {
  const now = input.now ?? new Date();
  const outcome = await client.$transaction((tx) => voidInTx(tx, { ...input, now }));
  if (outcome === "voided") await switchOffAfterVoid(client, input.invoiceId);
  return outcome;
}

/** The sweep's switch-off step: every invoice voided in the last 7 days, once more. Returns how many links were asked. */
export async function runPayLinkSwitchOff(
  client: PrismaClient,
  now: Date = new Date(),
  onlyLabel: string | null = null,
): Promise<number> {
  if (stripeProvider() === null) return 0;
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const voided = await client.invoice.findMany({
    where: {
      status: "void",
      stripePaymentLinkId: { not: null },
      voidedAt: { gte: since },
      ...(onlyLabel === null ? {} : { testData: onlyLabel }),
    },
    select: { reference: true, stripePaymentLinkId: true },
  });
  let asked = 0;
  for (const invoice of voided) {
    if (invoice.stripePaymentLinkId === null) continue;
    await switchPayLinkOff(invoice.stripePaymentLinkId, invoice.reference);
    asked += 1;
  }
  return asked;
}
