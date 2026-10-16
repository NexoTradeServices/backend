// The refund receipt PDF -- Feature 6006, refunds (ADR 0006, pdf-lib); redrawn in Feature 6015.
//
// Refunds (Refund A1 to B2); Foundations / Brand identity (Three identities, one row): headed
// with the LEGAL identity exactly as the invoice is, then REFUND TO from the details frozen on
// the refund. Titled ADJUSTMENT NOTE only for a business on a tax invoice, else REFUND. Composed
// from the stored rows on the spot and never stored.
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import type { PrismaClient } from "../db/client.js";
import { plain } from "../agreements/pdf.js";
import { formatDate } from "../time/index.js";
import type { BilledTo } from "../invoices/issue.js";
import { pdfMoney } from "../invoices/pdf.js";
import { billQuestionsPhone, isBusinessBilledTo } from "../invoices/billing.js";
import { GST_NOT_APPLICABLE, INK, MUTED, Sheet } from "../invoices/sheet.js";

export interface CreditNoteInput {
  legalEntityName: string;
  businessAbn: string;
  businessAddress: unknown;
  /** The number on the questions line: the accounts phone, or the operator phone while blank. */
  accountsPhone: string;
  timezone: string;
  reference: string;
  issuedAt: Date;
  invoiceReference: string;
  invoiceIssuedAt: Date;
  jobReference: string;
  /** Frozen on the refund when it was made (`Refund.billedTo`). */
  billedTo: BilledTo;
  reason: string;
  /** Cents, GST-inclusive. */
  amount: number;
  gstApplied: boolean;
}

/** One eleventh of a GST-inclusive amount, rounded to the cent. */
export function gstOf(amount: number): number {
  return Math.round(amount / 11);
}

/** An adjustment note only for a business on a tax invoice (Refund B2); every other refund is a Refund. */
export function creditNoteTitle(gstApplied: boolean, billedTo: Pick<BilledTo, "businessName">): string {
  return gstApplied && isBusinessBilledTo(billedTo) ? "ADJUSTMENT NOTE" : "REFUND";
}

export function creditNotePdfName(reference: string): string {
  return `${reference}.pdf`;
}

export async function makeCreditNotePdf(input: CreditNoteInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const sheet = new Sheet(pdf, await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold));
  const { regular, bold, left, right } = sheet;
  const title = creditNoteTitle(input.gstApplied, input.billedTo);

  sheet.header(input, title);
  sheet.parties("REFUND TO", input.billedTo, [
    ["Refund No", input.reference],
    ["Date", formatDate(input.timezone, input.issuedAt)],
    ["Invoice No", input.invoiceReference],
    ["Invoice date", formatDate(input.timezone, input.invoiceIssuedAt)],
    ["Job", input.jobReference],
  ]);
  sheet.y -= 4;
  sheet.rule();
  sheet.y -= 18;

  sheet.text("REASON", 9, bold, MUTED);
  sheet.text(input.reason, 11, regular);
  sheet.y -= 2;
  sheet.rule();
  sheet.y -= 18;

  sheet.room(80);
  sheet.page.drawText("DESCRIPTION", { x: left, y: sheet.y, size: 9, font: bold, color: MUTED });
  sheet.rightAt("AMOUNT", right, 9, bold, MUTED);
  sheet.y -= 6;
  sheet.rule();
  sheet.y -= 15;
  const against = title === "ADJUSTMENT NOTE" ? "tax invoice" : "invoice";
  sheet.page.drawText(plain(`Refund against ${against} ${input.invoiceReference}`), { x: left, y: sheet.y, size: 10, font: regular, color: INK });
  sheet.rightAt(pdfMoney(input.amount), right, 10, regular);
  sheet.y -= 12;
  sheet.rule();
  sheet.y -= 20;

  const total = (label: string, cents: number, font: PDFFont): void => {
    sheet.room(20);
    sheet.page.drawText(label, { x: right - 250, y: sheet.y, size: 10, font, color: INK });
    sheet.rightAt(pdfMoney(cents), right, 10, font);
    sheet.y -= 16;
  };
  if (input.gstApplied) {
    total("TOTAL REFUNDED (INCLUDES GST)", input.amount, bold);
    total("GST INCLUDED", gstOf(input.amount), regular);
  } else {
    total("TOTAL REFUNDED", input.amount, bold);
  }
  sheet.y -= 10;

  if (!input.gstApplied) {
    sheet.text(GST_NOT_APPLICABLE, 10, regular);
    sheet.y -= 6;
  }
  sheet.text(`Questions about this refund? Call ${input.accountsPhone}`, 10, regular, MUTED);

  return pdf.save();
}

/** Build the credit note for one refund, from the database as it is now. */
export async function buildCreditNotePdf(
  client: Pick<PrismaClient, "refund" | "platformSettings">,
  refundId: string,
): Promise<{ fileName: string; content: Uint8Array }> {
  const refund = await client.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { invoice: { include: { job: { select: { reference: true, timezone: true } } } } },
  });
  const settings = await client.platformSettings.findFirstOrThrow();
  const invoice = refund.invoice;
  const content = await makeCreditNotePdf({
    legalEntityName: settings.legalEntityName,
    businessAbn: settings.businessAbn ?? "",
    businessAddress: settings.businessAddress,
    accountsPhone: billQuestionsPhone(settings),
    timezone: invoice.job.timezone,
    reference: refund.reference,
    issuedAt: refund.approvedAt,
    invoiceReference: invoice.reference,
    invoiceIssuedAt: invoice.sentAt ?? invoice.createdAt,
    jobReference: invoice.job.reference,
    billedTo: refund.billedTo as unknown as BilledTo,
    reason: refund.reason,
    amount: refund.amount,
    gstApplied: invoice.gstApplied,
  });
  return { fileName: creditNotePdfName(refund.reference), content };
}
