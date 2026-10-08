// Issuing the invoice -- Feature 6001, invoice at completion.
//
// Invoicing; Line items - frozen at issue; GST (inclusive); Foundations /
// Brand identity. Runs INSIDE the transaction that freezes the visit, so a
// completed visit never exists without its invoice: the assignment keeps the
// exact numbers used (all four tier rates, the level, the customer's labour,
// Bob's pay, the parts he is owed back) and the invoice gets its INV number,
// its frozen lines, its splits, its GST stamp, its due date and a frozen copy of
// who it is billed to.
//
// Nothing here talks to Stripe or sends a message -- the pay link is made after
// the commit (pay-link.ts), and the email and text go out once it exists.
import type { Prisma } from "../generated/prisma/client.js";
import { nextReference } from "../db/reference.js";
import { formatDollars } from "../enquiries/money.js";
import { completionArithmetic, contractorMultiplierOf, customerMultiplierOf, gstWithin } from "./arithmetic.js";

type Db = Prisma.TransactionClient;

export interface BilledTo {
  name: string;
  businessName?: string;
  address?: Record<string, unknown>;
}

export interface IssueInput {
  assignmentId: string;
  /** The visit's start times, any order -- the earliest decides both weekend questions. */
  entryStarts: readonly Date[];
  billedHours: number;
  now: Date;
}

export interface IssuedInvoice {
  id: string;
  reference: string;
}

/** "2.0h" for a whole number of hours, "2.25h" otherwise. */
function hoursText(hours: number): string {
  return `${Number.isInteger(hours) ? hours.toFixed(1) : String(Number(hours.toFixed(2)))}h`;
}

function isAddress(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The customer as the invoice will carry her for good: name, business name and billing address when she has them. */
export function billedToOf(customer: { name: string; businessName: string | null; billingAddress: unknown }): BilledTo {
  const businessName = customer.businessName?.trim();
  return {
    name: customer.name,
    ...(businessName ? { businessName } : {}),
    ...(isAddress(customer.billingAddress) ? { address: customer.billingAddress } : {}),
  };
}

export async function issueInvoice(tx: Db, input: IssueInput): Promise<IssuedInvoice> {
  const assignment = await tx.assignment.findUniqueOrThrow({
    where: { id: input.assignmentId },
    include: {
      specialty: true,
      parts: { orderBy: { id: "asc" } },
      job: { include: { customer: true, serviceType: { select: { trade: true, serviceLevelMultipliers: true } } } },
    },
  });
  const job = assignment.job;
  const settings = await tx.platformSettings.findFirstOrThrow();

  const earliest = new Date(Math.min(...input.entryStarts.map((start) => start.getTime())));
  const { level, multiplier: customerMultiplier } = customerMultiplierOf(
    job.serviceType.serviceLevelMultipliers,
    job.serviceLevel,
    job.timezone,
    earliest,
  );
  const result = completionArithmetic({
    hours: input.billedHours,
    customerBase: { calloutRate: job.customerCalloutRate, standardRate: job.customerStandardRate },
    contractorBase: {
      calloutRate: assignment.specialty.contractorCalloutRate,
      standardRate: assignment.specialty.contractorStandardRate,
    },
    customerMultiplier,
    contractorMultiplier: contractorMultiplierOf(job.timezone, earliest),
    contractorPartTotals: assignment.parts.filter((part) => part.suppliedBy === "contractor").map((part) => part.lineTotal),
  });

  const trade = job.serviceType.trade;
  const labourLines: Prisma.InvoiceLineCreateWithoutInvoiceInput[] = [
    {
      kind: "labour",
      description: `Call-out + first hour - ${trade}, ${level}`,
      qty: 1,
      unitPrice: result.customer.tier1Rate,
      lineTotal: result.customer.tier1Rate,
    },
  ];
  if (result.customer.extraHours > 0) {
    labourLines.push({
      kind: "labour",
      description: `Additional ${hoursText(result.customer.extraHours)} @ ${formatDollars(result.customer.tier2Rate)}/h`,
      qty: result.customer.extraHours,
      unitPrice: result.customer.tier2Rate,
      lineTotal: result.customer.tier2Total,
    });
  }
  const partLines: Prisma.InvoiceLineCreateWithoutInvoiceInput[] = assignment.parts.map((part) => ({
    kind: "part",
    description: part.description ? `${part.name} - ${part.description}` : part.name,
    qty: part.qty,
    unitPrice: part.unitPrice,
    lineTotal: part.lineTotal,
  }));

  const labourAmount = labourLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const materialsAmount = partLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const amount = labourAmount + materialsAmount;
  const gstApplied = settings.gstRegistered;
  const dueAt = new Date(input.now.getTime() + settings.paymentTermsDays * 24 * 60 * 60 * 1000);

  const invoice = await tx.invoice.create({
    data: {
      reference: await nextReference("INV", tx),
      jobId: job.id,
      assignmentId: assignment.id,
      customerId: job.customerId,
      amount,
      labourAmount,
      materialsAmount,
      gstApplied,
      gstAmount: gstWithin(amount, Number(settings.gstRatePercent), gstApplied),
      isZeroDollar: amount === 0,
      status: "sent",
      sentAt: input.now,
      dueAt,
      billedTo: billedToOf(job.customer) as unknown as Prisma.InputJsonObject,
      lines: { create: [...labourLines, ...partLines] },
    },
    select: { id: true, reference: true },
  });

  await tx.assignment.update({
    where: { id: assignment.id },
    data: {
      customerCalloutRate: job.customerCalloutRate,
      customerStandardRate: job.customerStandardRate,
      contractorCalloutRate: assignment.specialty.contractorCalloutRate,
      contractorStandardRate: assignment.specialty.contractorStandardRate,
      serviceLevel: level,
      customerTotal: result.customerTotal,
      contractorPay: result.contractorPay,
      materialsReimbursement: result.materialsReimbursement,
      invoiceId: invoice.id,
    },
  });
  return invoice;
}
