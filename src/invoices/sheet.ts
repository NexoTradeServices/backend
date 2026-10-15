// The drawing frame the invoice and the refund receipt share -- Feature 6015.
//
// Invoicing / Invoice layouts and Refunds: both documents are one frame -- the legal identity
// on the left with the title right-aligned on its first line, a rule, the buyer block on the
// left with the facts on the right, a rule -- and then their own body. This file draws the
// frame; invoices/pdf.ts and refunds/credit-note.ts draw the rest.
import { rgb, type PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import { addressLine } from "../settings/address.js";
import { plain, wrap } from "../agreements/pdf.js";
import { formatAbn } from "./abn.js";
import { isBusinessBilledTo } from "./billing.js";
import type { BilledTo } from "./issue.js";

export const INK = rgb(0.1, 0.1, 0.1);
export const MUTED = rgb(0.4, 0.4, 0.4);

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LEFT = 56;
const BOTTOM = 64;
const TOP = PAGE_HEIGHT - 64;

export class Sheet {
  readonly left = LEFT;
  readonly width = PAGE_WIDTH - LEFT * 2;
  readonly right = PAGE_WIDTH - LEFT;
  page: PDFPage;
  y = TOP;

  constructor(
    readonly pdf: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  }

  room(needed: number): void {
    if (this.y - needed >= BOTTOM) return;
    this.page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = TOP;
  }

  /** Wrapped text from the left edge, moving down. */
  text(value: string, size: number, font: PDFFont, color = INK): void {
    for (const line of wrap(plain(value), font, size, this.width)) {
      this.room(size + 5);
      this.page.drawText(line, { x: this.left, y: this.y, size, font, color });
      this.y -= size + 5;
    }
  }

  /** Text ending at `right` on the current line, without moving down. */
  rightAt(value: string, right: number, size: number, font: PDFFont, color = INK): void {
    const safe = plain(value);
    this.page.drawText(safe, { x: right - font.widthOfTextAtSize(safe, size), y: this.y, size, font, color });
  }

  rule(thickness = 0.5): void {
    this.page.drawLine({ start: { x: this.left, y: this.y }, end: { x: this.right, y: this.y }, thickness, color: MUTED });
  }

  /** A rule with room round it: space above, the line, space below. */
  ruled(): void {
    this.y -= 6;
    this.rule();
    this.y -= 16;
  }

  /**
   * The top of the document: the legal identity left, the title right on the same first line,
   * then ABN and address, then a rule.
   */
  header(identity: { legalEntityName: string; businessAbn: string; businessAddress: unknown }, title: string): void {
    this.page.drawText(plain(title), {
      x: this.right - this.bold.widthOfTextAtSize(plain(title), 16),
      y: this.y,
      size: 16,
      font: this.bold,
      color: INK,
    });
    this.text(identity.legalEntityName, 18, this.bold);
    if (identity.businessAbn.trim() !== "") this.text(`ABN ${formatAbn(identity.businessAbn)}`, 10, this.regular, MUTED);
    const address = addressLine(identity.businessAddress);
    if (address !== "") this.text(address, 10, this.regular, MUTED);
    this.y -= 6;
    this.rule(0.75);
    this.y -= 20;
  }

  /**
   * The buyer block on the left (a label, then the person or the business, "Attn:", "ABN" when
   * frozen, the address) with the facts on the right, the first level with the label.
   */
  parties(label: string, billed: BilledTo, facts: [string, string][]): void {
    const top = this.y;
    const factsX = this.left + 300;
    this.room(100);
    // Facts, right column.
    let factY = top;
    for (const [name, value] of facts) {
      this.page.drawText(plain(`${name}: `), { x: factsX, y: factY, size: 9, font: this.regular, color: MUTED });
      this.page.drawText(plain(value), { x: factsX + 74, y: factY, size: 10, font: this.regular, color: INK });
      factY -= 15;
    }
    // Buyer, left column, kept clear of the facts.
    const leftWidth = 280;
    const put = (value: string, size: number, font: PDFFont, color = INK): void => {
      for (const line of wrap(plain(value), font, size, leftWidth)) {
        this.page.drawText(line, { x: this.left, y: this.y, size, font, color });
        this.y -= size + 5;
      }
    };
    put(label, 9, this.regular, MUTED);
    if (isBusinessBilledTo(billed)) {
      put(billed.businessName ?? "", 11, this.bold);
      put(`Attn: ${billed.name}`, 11, this.regular);
      if (billed.abn !== undefined && billed.abn !== "") put(`ABN ${formatAbn(billed.abn)}`, 10, this.regular);
    } else {
      put(billed.name, 11, this.bold);
    }
    const billedAddress = addressLine(billed.address ?? null);
    if (billedAddress !== "") put(billedAddress, 10, this.regular, MUTED);
    this.y = Math.min(this.y, factY);
    this.y -= 4;
  }
}

/** The "GST: Not applicable" line, printed on the documents of a business not registered for GST. */
export const GST_NOT_APPLICABLE = "GST: Not applicable - this business is not registered for GST.";
