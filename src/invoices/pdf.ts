// The invoice PDF -- Feature 6001, invoice at completion (ADR 0006, pdf-lib).
//
// Invoicing; Foundations / Brand identity (Three identities, one row): the
// header is the LEGAL identity -- legalEntityName, "ABN <businessAbn>" when set,
// businessAddress -- never the display name alone. Built from the FROZEN rows
// only (the invoice, its lines, its billed-to copy), so the same invoice always
// reads the same; it is built at send time and never stored. No bank account
// appears anywhere: the customer pays online.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { addressLine } from "../settings/address.js";
import { formatLongDate, plain, wrap } from "../agreements/pdf.js";
import type { BilledTo } from "./issue.js";

export interface InvoicePdfInput {
  legalEntityName: string;
  businessAbn: string;
  businessAddress: unknown;
  operatorPhone: string;
  reference: string;
  jobReference: string;
  timezone: string;
  issuedAt: Date;
  dueAt: Date;
  billedTo: BilledTo;
  lines: { description: string; qty: number; unitPrice: number; lineTotal: number }[];
  amount: number;
  gstApplied: boolean;
  gstAmount: number;
  payLinkUrl: string | null;
}

const MONEY = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });

/** "$1,250.00" -- the PDF always shows cents. */
export function pdfMoney(cents: number): string {
  return MONEY.format(cents / 100);
}

function qtyText(qty: number): string {
  return String(Number(qty.toFixed(2)));
}

export function invoicePdfName(reference: string): string {
  return `${reference}.pdf`;
}

export async function makeInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
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

  let page: PDFPage = pdf.addPage([pageWidth, 841.89]); // A4
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

  // Right-aligned figure ending at `right`.
  const figure = (value: string, right: number, size: number, font: PDFFont, color = ink): void => {
    const safe = plain(value);
    page.drawText(safe, { x: right - font.widthOfTextAtSize(safe, size), y, size, font, color });
  };

  // Header: the legal identity.
  text(input.legalEntityName, 18, bold);
  if (input.businessAbn.trim() !== "") text(`ABN ${input.businessAbn}`, 10, regular, muted);
  const address = addressLine(input.businessAddress);
  if (address !== "") text(address, 10, regular, muted);
  y -= 14;
  page.drawLine({ start: { x: left, y }, end: { x: left + width, y }, thickness: 0.75, color: muted });
  y -= 28;

  text(input.gstApplied ? "Tax invoice" : "Invoice", 16, bold);
  y -= 8;

  const facts: [string, string][] = [
    ["Invoice number", input.reference],
    ["Job", input.jobReference],
    ["Issued", formatLongDate(input.issuedAt, input.timezone)],
    ["Due", formatLongDate(input.dueAt, input.timezone)],
  ];
  for (const [label, value] of facts) {
    room(30);
    page.drawText(plain(label), { x: left, y, size: 9, font: regular, color: muted });
    page.drawText(plain(value), { x: left + 110, y, size: 11, font: regular, color: ink });
    y -= 17;
  }
  y -= 10;

  // Billed to: business name then "Attn: <name>", or the name alone; then the address.
  text("Billed to", 9, regular, muted);
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

  // The lines.
  const colAmount = left + width;
  const colPrice = colAmount - 90;
  const colQty = colPrice - 80;
  room(40);
  page.drawText("Description", { x: left, y, size: 9, font: bold, color: muted });
  figure("Qty", colQty, 9, bold, muted);
  figure("Unit price", colPrice, 9, bold, muted);
  figure("Amount", colAmount, 9, bold, muted);
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: left + width, y }, thickness: 0.5, color: muted });
  y -= 15;
  const descriptionWidth = colQty - left - 48;
  for (const line of input.lines) {
    const wrapped = wrap(plain(line.description), regular, 10, descriptionWidth);
    room(wrapped.length * 14 + 6);
    const rowTop = y;
    for (const piece of wrapped) {
      page.drawText(piece, { x: left, y, size: 10, font: regular, color: ink });
      y -= 14;
    }
    const keep = y;
    y = rowTop;
    figure(qtyText(line.qty), colQty, 10, regular);
    figure(pdfMoney(line.unitPrice), colPrice, 10, regular);
    figure(pdfMoney(line.lineTotal), colAmount, 10, regular);
    y = keep - 4;
  }
  page.drawLine({ start: { x: left, y: y + 6 }, end: { x: left + width, y: y + 6 }, thickness: 0.5, color: muted });
  y -= 10;

  // Totals: "Total" alone when GST is not applied; Subtotal / Includes GST / Total when it is.
  const total = (label: string, cents: number, font: PDFFont): void => {
    room(20);
    page.drawText(label, { x: colPrice - 70, y, size: 10, font, color: ink });
    figure(pdfMoney(cents), colAmount, 10, font);
    y -= 16;
  };
  if (input.gstApplied) {
    total("Subtotal", input.amount - input.gstAmount, regular);
    total("Includes GST", input.gstAmount, regular);
  }
  total("Total", input.amount, bold);
  y -= 14;

  if (input.payLinkUrl !== null) text(`Pay online: ${input.payLinkUrl}`, 10, regular);
  y -= 4;
  text(`Questions about this bill? Call ${input.operatorPhone}`, 10, regular, muted);

  return pdf.save();
}

/** The frozen rows an invoice PDF is built from. */
const invoiceForPdf = {
  include: {
    lines: { orderBy: { id: "asc" } },
    job: { select: { reference: true, timezone: true } },
  },
} satisfies Prisma.InvoiceDefaultArgs;

/**
 * Build the PDF for one invoice, from the database as it is now: the invoice's
 * frozen rows plus the settings row's legal identity. Called at SEND time by the
 * email template's attachment, so a resend after a pay link exists carries it.
 */
export async function buildInvoicePdf(
  client: Pick<PrismaClient, "invoice" | "platformSettings">,
  invoiceId: string,
): Promise<{ fileName: string; content: Uint8Array }> {
  const invoice = await client.invoice.findUniqueOrThrow({ where: { id: invoiceId }, ...invoiceForPdf });
  const settings = await client.platformSettings.findFirstOrThrow();
  const content = await makeInvoicePdf({
    legalEntityName: settings.legalEntityName,
    businessAbn: settings.businessAbn ?? "",
    businessAddress: settings.businessAddress,
    operatorPhone: settings.operatorPhone,
    reference: invoice.reference,
    jobReference: invoice.job.reference,
    timezone: invoice.job.timezone,
    issuedAt: invoice.sentAt ?? invoice.createdAt,
    dueAt: invoice.dueAt,
    billedTo: invoice.billedTo as unknown as BilledTo,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      qty: Number(line.qty),
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),
    amount: invoice.amount,
    gstApplied: invoice.gstApplied,
    gstAmount: invoice.gstAmount ?? 0,
    payLinkUrl: invoice.stripePaymentLinkUrl,
  });
  return { fileName: invoicePdfName(invoice.reference), content };
}
