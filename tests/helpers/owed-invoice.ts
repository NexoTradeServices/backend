// An invoice already issued to a cast customer -- Feature 6002.
//
// Written straight into the tables (no Complete), so the payment and receivables
// tests start from "the invoice is out": Bob's completed Plumbing job, its invoice
// sent with a pay link, due when the test says. INV numbers come from the same
// sequence as Complete's, so Sarah's first invoice is INV-2042.
import type { PrismaClient } from "../../src/db/client.js";
import { nextReference } from "../../src/db/reference.js";

export interface OwedInvoiceOptions {
  /** Defaults to Sarah, CUS-1050. */
  customerCode?: string;
  /** A customer made for the test (Nina of Rossi's Cafe). */
  customer?: { name: string; email: string; phone?: string; businessName?: string };
  amount?: number;
  dueAt?: Date;
  status?: "sent" | "paid" | "void";
  /** false: still waiting for its pay link. */
  withLink?: boolean;
  isZeroDollar?: boolean;
  testData?: string;
}

export interface OwedInvoice {
  invoiceId: string;
  invoiceReference: string;
  jobId: string;
  jobReference: string;
  customerId: string;
  paymentLinkId: string | null;
}

export async function owedInvoice(db: PrismaClient, options: OwedInvoiceOptions = {}): Promise<OwedInvoice> {
  const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("fixture Bob has no Plumbing specialty");
  const customer = options.customer
    ? await db.customer.create({
        data: {
          code: await nextReference("CUS", db),
          name: options.customer.name,
          email: options.customer.email,
          phone: options.customer.phone ?? null,
          businessName: options.customer.businessName ?? null,
        },
      })
    : await db.customer.findUniqueOrThrow({ where: { code: options.customerCode ?? "CUS-1050" } });
  const label = options.testData === undefined ? {} : { testData: options.testData };
  const slot = new Date("2026-10-07T00:00:00.000Z");
  const job = await db.job.create({
    data: {
      ...label,
      reference: await nextReference("JOB", db),
      customerId: customer.id,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: "6163",
      serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      timezone: "Australia/Perth",
      description: "The mixer tap in the kitchen leaks.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: slot,
      status: "completed",
      serviceLevel: "normal",
    },
  });
  const assignment = await db.assignment.create({
    data: {
      ...label,
      jobId: job.id,
      contractorId: bob.id,
      specialtyId: specialty.id,
      status: "completed",
      proposedSlot: slot,
      confirmedSlot: slot,
      acceptedAt: slot,
      completedAt: slot,
    },
  });
  const amount = options.isZeroDollar ? 0 : (options.amount ?? 65_500);
  const reference = await nextReference("INV", db);
  const withLink = options.withLink ?? true;
  const paymentLinkId = withLink ? `plink_${reference}` : null;
  const invoice = await db.invoice.create({
    data: {
      ...label,
      reference,
      jobId: job.id,
      assignmentId: assignment.id,
      customerId: customer.id,
      amount,
      labourAmount: amount,
      materialsAmount: 0,
      gstAmount: 0,
      gstApplied: false,
      isZeroDollar: options.isZeroDollar ?? false,
      billedTo: customer.businessName ? { name: customer.name, businessName: customer.businessName } : { name: customer.name },
      status: options.status ?? "sent",
      dueAt: options.dueAt ?? new Date(Date.now() + 14 * 86_400_000),
      sentAt: slot,
      stripePaymentLinkUrl: withLink ? `https://pay.test/${reference}` : null,
      stripePaymentLinkId: paymentLinkId,
    },
  });
  await db.assignment.update({ where: { id: assignment.id }, data: { invoiceId: invoice.id } });
  return { invoiceId: invoice.id, invoiceReference: reference, jobId: job.id, jobReference: job.reference, customerId: customer.id, paymentLinkId };
}
