// The invoice PDF -- Feature 6001, invoice at completion (ADR 0006, pdf-lib).
//
// Invoicing / Invoice layouts (A1 to B2) and Foundations / Brand identity (Three
// identities, one row): the header is the LEGAL identity -- legalEntityName, "ABN <businessAbn>" when set,
// businessAddress -- never the display name alone. Built from the FROZEN rows
// only (the invoice, its lines, its billed-to copy), so the same invoice always
// reads the same; it is built at send time and never stored. No bank account
// appears anywhere: the customer pays online.
import QRCode from "qrcode";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { plain, wrap } from "../agreements/pdf.js";
import { formatDate } from "../time/index.js";
import { billQuestionsPhone } from "./billing.js";
import type { BilledTo } from "./issue.js";
import { GST_NOT_APPLICABLE, INK, MUTED, Sheet } from "./sheet.js";

export interface InvoicePdfInput {
  legalEntityName: string;
  businessAbn: string;
  businessAddress: unknown;
  /** The number on the questions line: the accounts phone, or the operator phone while blank. */
  accountsPhone: string;
  reference: string;
  jobReference: string;
  timezone: string;
  issuedAt: Date;
  dueAt: Date;
  billedTo: BilledTo;
  lines: { kind?: string; description: string; qty: number; unitPrice: number; lineTotal: number }[];
  amount: number;
  gstApplied: boolean;
  gstAmount: number;
  /** Paid in full: AMOUNT DUE reads $0.00. */
  paid: boolean;
  payLinkUrl: string | null;
  /** Feature 6004: set on a callback's invoice (derived from the job's parent, never stored). */
  callbackOn?: string | null;
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
  const sheet = new Sheet(pdf, await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold));
  const { regular, bold, left, right } = sheet;

  // Header: the legal identity left, the title right; then Bill to with the facts beside it.
  sheet.header(input, input.gstApplied ? "TAX INVOICE" : "INVOICE");
  sheet.parties("BILL TO", input.billedTo, [
    ["Invoice No", input.reference],
    ["Date", formatDate(input.timezone, input.issuedAt)],
    ["Due", formatDate(input.timezone, input.dueAt)],
    ["Job", input.jobReference],
  ]);
  sheet.y -= 4;
  sheet.rule();
  sheet.y -= 18;

  // Feature 6004: a callback's invoice says so above its lines, whatever it is charged.
  if (input.callbackOn != null && input.amount === 0) {
    sheet.text(`Follow-up visit for ${input.callbackOn} - no charge`, 11, bold);
    sheet.y -= 8;
  }

  // The lines.
  const colPrice = right - 90;
  const colQty = colPrice - 80;
  sheet.room(40);
  sheet.page.drawText("DESCRIPTION", { x: left, y: sheet.y, size: 9, font: bold, color: MUTED });
  sheet.rightAt("QTY", colQty, 9, bold, MUTED);
  sheet.rightAt("RATE", colPrice, 9, bold, MUTED);
  sheet.rightAt("AMOUNT", right, 9, bold, MUTED);
  sheet.y -= 6;
  sheet.rule();
  sheet.y -= 15;
  const descriptionWidth = colQty - left - 48;
  for (const line of input.lines) {
    const wrapped = wrap(plain(line.description), regular, 10, descriptionWidth);
    sheet.room(wrapped.length * 14 + 6);
    const rowTop = sheet.y;
    for (const piece of wrapped) {
      sheet.page.drawText(piece, { x: left, y: sheet.y, size: 10, font: regular, color: INK });
      sheet.y -= 14;
    }
    const keep = sheet.y;
    sheet.y = rowTop;
    sheet.rightAt(qtyText(line.qty), colQty, 10, regular);
    // A follow-up visit's labour line has no rate to show.
    if (!(line.kind === "labour" && line.unitPrice === 0)) sheet.rightAt(pdfMoney(line.unitPrice), colPrice, 10, regular);
    sheet.rightAt(pdfMoney(line.lineTotal), right, 10, regular);
    sheet.y = keep - 4;
  }
  sheet.y += 6;
  sheet.rule();
  sheet.y -= 20;

  // Totals. Not GST: TOTAL, AMOUNT DUE. GST: TOTAL (INCLUDES GST), GST INCLUDED, AMOUNT DUE.
  const total = (label: string, cents: number, font: PDFFont): void => {
    sheet.room(20);
    sheet.page.drawText(label, { x: right - 230, y: sheet.y, size: 10, font, color: INK });
    sheet.rightAt(pdfMoney(cents), right, 10, font);
    sheet.y -= 16;
  };
  total(input.gstApplied ? "TOTAL (INCLUDES GST)" : "TOTAL", input.amount, regular);
  if (input.gstApplied) total("GST INCLUDED", input.gstAmount, regular);
  total("AMOUNT DUE", input.paid ? 0 : input.amount, bold);
  sheet.y -= 10;

  if (!input.gstApplied) {
    sheet.text(GST_NOT_APPLICABLE, 10, regular);
    sheet.y -= 6;
  }
  if (input.payLinkUrl !== null) {
    // Feature 6007: the pay link is also a QR code, beside the "Pay online" line (none on a $0 invoice,
    // which has no link). Whoever holds the printed page can pay without typing the link.
    const side = 84;
    sheet.room(side + 12);
    const top = sheet.y + 8;
    const cells = QRCode.create(input.payLinkUrl, { errorCorrectionLevel: "M" }).modules;
    const cell = side / (cells.size + 4); // a two-cell quiet zone round the code
    for (let row = 0; row < cells.size; row += 1) {
      for (let col = 0; col < cells.size; col += 1) {
        if (cells.get(row, col) === 0) continue;
        sheet.page.drawRectangle({
          x: right - side + (col + 2) * cell,
          y: top - (row + 3) * cell,
          width: cell,
          height: cell,
          color: INK,
        });
      }
    }
    const textWidth = sheet.width - side - 16;
    for (const piece of wrap(plain(`Pay online: ${input.payLinkUrl}`), regular, 10, textWidth)) {
      sheet.page.drawText(piece, { x: left, y: sheet.y, size: 10, font: regular, color: INK });
      sheet.y -= 15;
    }
    sheet.y = Math.min(sheet.y, top - side) - 4;
  }
  sheet.text(`Questions about this bill? Call ${input.accountsPhone}`, 10, regular, MUTED);

  return pdf.save();
}

/** The frozen rows an invoice PDF is built from. */
const invoiceForPdf = {
  include: {
    lines: { orderBy: { id: "asc" } },
    job: { select: { reference: true, timezone: true, parentJob: { select: { reference: true } } } },
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
    accountsPhone: billQuestionsPhone(settings),
    reference: invoice.reference,
    jobReference: invoice.job.reference,
    timezone: invoice.job.timezone,
    issuedAt: invoice.sentAt ?? invoice.createdAt,
    dueAt: invoice.dueAt,
    billedTo: invoice.billedTo as unknown as BilledTo,
    lines: invoice.lines.map((line) => ({
      kind: line.kind,
      description: line.description,
      qty: Number(line.qty),
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),
    amount: invoice.amount,
    gstApplied: invoice.gstApplied,
    gstAmount: invoice.gstAmount ?? 0,
    paid: invoice.status === "paid",
    payLinkUrl: invoice.stripePaymentLinkUrl,
    callbackOn: invoice.job.parentJob?.reference ?? null,
  });
  return { fileName: invoicePdfName(invoice.reference), content };
}
