// The credit note PDF -- Feature 6006, refunds (ADR 0006, pdf-lib).
//
// Refunds; Foundations / Brand identity (Three identities, one row): headed with the LEGAL
// identity -- legalEntityName, "ABN <businessAbn>" when set, businessAddress -- exactly as the
// invoice is, never the display name alone. Titled "Adjustment note" with an "Includes GST of
// $X" line (one eleventh of the amount, to the cent) when the invoice carried GST, else
// "Credit note" with no GST line. Composed from the stored rows on the spot and never stored.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PrismaClient } from "../db/client.js";
import { addressLine } from "../settings/address.js";
import { plain, wrap } from "../agreements/pdf.js";
import { formatDate } from "../time/index.js";
import type { BilledTo } from "../invoices/issue.js";
import { pdfMoney } from "../invoices/pdf.js";

export interface CreditNoteInput {
  legalEntityName: string;
  businessAbn: string;
  businessAddress: unknown;
  operatorPhone: string;
  timezone: string;
  reference: string;
  issuedAt: Date;
  invoiceReference: string;
  invoiceIssuedAt: Date;
  jobReference: string;
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

export function creditNoteTitle(gstApplied: boolean): string {
  return gstApplied ? "Adjustment note" : "Credit note";
}

export function creditNotePdfName(reference: string): string {
  return `${reference}.pdf`;
}

export async function makeCreditNotePdf(input: CreditNoteInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.4, 0.4, 0.4);
  const left = 56;
  const pageWidth = 595.28;
  const width = pageWidth - left * 2;
  const bottom = 64;
  const top = 841.89 - 64;

  let page: PDFPage = pdf.addPage([pageWidth, 841.89]);
  let y = top;

  const room = (needed: number): void => {
    if (y - needed >= bottom) return;
    page = pdf.addPage([pageWidth, 841.89]);
    y = top;
  };
  const text = (value: string, size: number, font: PDFFont, color = ink): void => {
    for (const line of wrap(plain(value), font, size, width)) {
      room(size + 5);
      page.drawText(line, { x: left, y, size, font, color });
      y -= size + 5;
    }
  };

  // Header: the legal identity, as on the invoice.
  text(input.legalEntityName, 18, bold);
  if (input.businessAbn.trim() !== "") text(`ABN ${input.businessAbn}`, 10, regular, muted);
  const address = addressLine(input.businessAddress);
  if (address !== "") text(address, 10, regular, muted);
  y -= 14;
  page.drawLine({ start: { x: left, y }, end: { x: left + width, y }, thickness: 0.75, color: muted });
  y -= 28;

  text(creditNoteTitle(input.gstApplied), 16, bold);
  y -= 8;

  const facts: [string, string][] = [
    [`${creditNoteTitle(input.gstApplied)} number`, input.reference],
    ["Date", formatDate(input.timezone, input.issuedAt)],
    ["Invoice", input.invoiceReference],
    ["Invoice issued", formatDate(input.timezone, input.invoiceIssuedAt)],
    ["Job", input.jobReference],
  ];
  for (const [label, value] of facts) {
    room(30);
    page.drawText(plain(label), { x: left, y, size: 9, font: regular, color: muted });
    page.drawText(plain(value), { x: left + 130, y, size: 11, font: regular, color: ink });
    y -= 17;
  }
  y -= 10;

  text("Issued to", 9, regular, muted);
  const billed = input.billedTo;
  if (billed.businessName !== undefined && billed.businessName !== "") {
    text(billed.businessName, 11, bold);
    text(`Attn: ${billed.name}`, 11, regular);
  } else {
    text(billed.name, 11, bold);
  }
  const billedAddress = addressLine(billed.address ?? null);
  if (billedAddress !== "") text(billedAddress, 10, regular, muted);
  y -= 16;

  text("Reason", 9, regular, muted);
  text(input.reason, 11, regular);
  y -= 16;

  page.drawLine({ start: { x: left, y: y + 6 }, end: { x: left + width, y: y + 6 }, thickness: 0.5, color: muted });
  y -= 10;
  room(40);
  const amountText = plain(pdfMoney(input.amount));
  page.drawText("Amount refunded", { x: left, y, size: 11, font: bold, color: ink });
  page.drawText(amountText, { x: left + width - bold.widthOfTextAtSize(amountText, 11), y, size: 11, font: bold, color: ink });
  y -= 18;
  if (input.gstApplied) {
    text(`Includes GST of ${pdfMoney(gstOf(input.amount))}`, 10, regular, muted);
  }
  y -= 14;
  text(`Questions about this refund? Call ${input.operatorPhone}`, 10, regular, muted);

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
    operatorPhone: settings.operatorPhone,
    timezone: invoice.job.timezone,
    reference: refund.reference,
    issuedAt: refund.approvedAt,
    invoiceReference: invoice.reference,
    invoiceIssuedAt: invoice.sentAt ?? invoice.createdAt,
    jobReference: invoice.job.reference,
    billedTo: invoice.billedTo as unknown as BilledTo,
    reason: refund.reason,
    amount: refund.amount,
    gstApplied: invoice.gstApplied,
  });
  return { fileName: creditNotePdfName(refund.reference), content };
}
