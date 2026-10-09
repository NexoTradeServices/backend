// The Stripe adapter -- Feature 6001, invoice at completion.
//
// Payments (Stripe) / Core: one Payment Link per invoice -- Stripe's own hosted
// checkout page, card plus whatever the Stripe settings switch on, one payment
// only. This is the whole of the platform's contact with Stripe for 6001; the
// pay-link loop (pay-link.ts) talks to the `PayLinkProvider` below and nothing
// else, so tests swap in a fake and never reach the network.
//
// No STRIPE_SECRET_KEY is never a refusal to boot: `stripeProvider()` answers
// null, one loud warning is logged at startup (`warnIfStripeMissing`), and every
// invoice waits for its pay link.
import Stripe from "stripe";

export interface PayLinkRequest {
  invoiceId: string;
  /** INV-2042 */
  invoiceReference: string;
  /** JOB-1043 */
  jobReference: string;
  /** Cents, GST-inclusive. */
  amount: number;
}

export interface PayLink {
  url: string;
  id: string;
}

/** What the pay-link loop needs from Stripe. */
export interface PayLinkProvider {
  createPayLink(request: PayLinkRequest): Promise<PayLink>;
}

const REQUEST_TIMEOUT_MS = 20_000;

/** Stripe's idempotency key: a retry after a lost answer never makes a second link. */
export function idempotencyKeyFor(invoiceId: string): string {
  return `payment-link-${invoiceId}`;
}

/**
 * The parameters of the one Payment Link. A single inline AUD price named
 * "INV-2042 - JOB-1043"; limited to one completed checkout; NO fixed
 * payment-method list (Stripe's own settings decide); the invoice id and
 * reference ride in the link's metadata AND the payment intent's, where 6002's
 * webhook reads them.
 */
export function payLinkParams(request: PayLinkRequest): Stripe.PaymentLinkCreateParams {
  const metadata = { invoiceId: request.invoiceId, invoiceReference: request.invoiceReference };
  return {
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "aud",
          unit_amount: request.amount,
          product_data: { name: `${request.invoiceReference} - ${request.jobReference}` },
        },
      },
    ],
    restrictions: { completed_sessions: { limit: 1 } },
    metadata,
    payment_intent_data: { metadata },
  };
}

function providerFor(secretKey: string): PayLinkProvider {
  const stripe = new Stripe(secretKey, { timeout: REQUEST_TIMEOUT_MS, maxNetworkRetries: 0 });
  return {
    async createPayLink(request) {
      const link = await stripe.paymentLinks.create(payLinkParams(request), {
        idempotencyKey: idempotencyKeyFor(request.invoiceId),
      });
      return { url: link.url, id: link.id };
    },
  };
}

let override: PayLinkProvider | null | undefined;

/** Tests: use this provider (or `null` for "no key") instead of reading the environment. */
export function setPayLinkProvider(provider: PayLinkProvider | null | undefined): void {
  override = provider;
}

/** The real provider if the key is set; null (every invoice waits) when it is not. */
export function stripeProvider(): PayLinkProvider | null {
  if (override !== undefined) return override;
  const key = process.env["STRIPE_SECRET_KEY"]?.trim();
  if (!key) return null;
  return providerFor(key);
}

export function warnIfStripeMissing(): void {
  if (stripeProvider() === null) {
    console.warn(
      "payments: STRIPE_SECRET_KEY is not set -- invoices will issue and wait for their pay link until it is",
    );
  }
}

// ---------------------------------------------------------------------------
// Feature 6002 -- reading payments back. Behind its own fake-able seam, beside
// the pay link's: the webhook reads the payment intent a checkout session names,
// and Check payment lists the sessions of an invoice's link.
// ---------------------------------------------------------------------------

/** One payment intent, as the paid step needs it. */
export interface StripePayment {
  paymentIntentId: string;
  /** From the intent's metadata (stripe.ts payLinkParams); null when it carries none. */
  invoiceId: string | null;
  /** Cents. */
  amount: number;
  /** Stripe's word for the latest charge's payment method: card, payto, ... */
  method: string | null;
  /** When the latest charge was made; null when there is no charge yet. */
  chargedAt: Date | null;
}

/** What the webhook and Check payment need from Stripe. */
export interface PaymentReader {
  readPaymentIntent(paymentIntentId: string): Promise<StripePayment>;
  /** The payment intents of the link's checkout sessions that are complete AND paid. */
  paidPaymentIntentsOfLink(paymentLinkId: string): Promise<string[]>;
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.id;
}

function readerFor(secretKey: string): PaymentReader {
  const stripe = new Stripe(secretKey, { timeout: REQUEST_TIMEOUT_MS, maxNetworkRetries: 1 });
  return {
    async readPaymentIntent(paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
      const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
      const invoiceId = intent.metadata["invoiceId"];
      return {
        paymentIntentId: intent.id,
        invoiceId: invoiceId === undefined || invoiceId === "" ? null : invoiceId,
        amount: intent.amount_received > 0 ? intent.amount_received : intent.amount,
        method: charge?.payment_method_details?.type ?? intent.payment_method_types[0] ?? null,
        chargedAt: charge === null ? null : new Date(charge.created * 1000),
      };
    },
    async paidPaymentIntentsOfLink(paymentLinkId) {
      const sessions = await stripe.checkout.sessions.list({ payment_link: paymentLinkId, limit: 20 });
      return sessions.data
        .filter((session) => session.status === "complete" && session.payment_status === "paid")
        .map((session) => idOf(session.payment_intent))
        .filter((id): id is string => id !== null);
    },
  };
}

let readerOverride: PaymentReader | null | undefined;

/** Tests: use this reader (or `null` for "no key") instead of reading the environment. */
export function setPaymentReader(reader: PaymentReader | null | undefined): void {
  readerOverride = reader;
}

/** The real reader if the key is set; null when it is not. */
export function paymentReader(): PaymentReader | null {
  if (readerOverride !== undefined) return readerOverride;
  const key = process.env["STRIPE_SECRET_KEY"]?.trim();
  if (!key) return null;
  return readerFor(key);
}

/** The webhook's signing secret, or null when it is not set. */
export function webhookSecret(): string | null {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"]?.trim();
  return secret ? secret : null;
}

export function warnIfWebhookSecretMissing(): void {
  if (webhookSecret() === null) {
    console.warn("payments: STRIPE_WEBHOOK_SECRET is not set -- no payment will be marked paid until it is");
  }
}
