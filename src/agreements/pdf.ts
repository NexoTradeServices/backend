// The stamped acceptance record -- Feature 2006, ADR 0006 (pdf-lib).
//
// One page: the legal identity as the header, then who accepted what, when,
// from where, and the fingerprint of the exact file. Laid out by hand.
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { addressLine } from "../settings/address.js";

export interface AcceptanceRecordInput {
  legalEntityName: string;
  businessAbn: string;
  businessAddress: unknown;
  contractorName: string;
  contractorCode: string;
  version: string;
  versionIssuedAt: Date;
  acceptedAt: Date;
  timezone: string;
  ip: string;
  userAgent: string | null;
  documentHash: string;
  operatorPhone: string;
  operatorEmail: string;
}

/** Standard fonts encode Latin-1 only; anything else would throw, so it reads as "?". */
export function plain(text: string): string {
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

/** "9 Sep 2026" in the business's own clock. */
export function formatLongDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: timezone }).format(date);
}

/** "9 Sep 2026, 2:15 pm AWST" in the business's own clock. */
export function formatMoment(date: Date, timezone: string): string {
  const day = formatLongDate(date, timezone);
  const parts = new Intl.DateTimeFormat("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
    timeZoneName: "short",
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const zone = pick("timeZoneName").replace(/^GMT\+8$/, "AWST");
  return `${day}, ${pick("hour")}:${pick("minute")} ${pick("dayPeriod").toLowerCase()} ${zone}`.trim();
}

export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    // A word wider than the line (a hash, a long agent string) is cut where it must be.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut -= 1;
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    const next = line ? `${line} ${rest}` : rest;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      line = next;
    } else {
      lines.push(line);
      line = rest;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function makeAcceptanceRecord(input: AcceptanceRecordInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.4, 0.4, 0.4);
  const left = 56;
  const width = 595.28 - left * 2;
  let y = 841.89 - 64;

  const text = (value: string, size: number, font: PDFFont, color = ink): void => {
    for (const line of wrap(plain(value), font, size, width)) {
      page.drawText(line, { x: left, y, size, font, color });
      y -= size + 5;
    }
  };

  text(input.legalEntityName, 18, bold);
  text(`ABN ${input.businessAbn}`, 10, regular, muted);
  text(addressLine(input.businessAddress), 10, regular, muted);
  y -= 14;
  page.drawLine({ start: { x: left, y }, end: { x: left + width, y }, thickness: 0.75, color: muted });
  y -= 28;

  text("Contractor agreement - acceptance record", 14, bold);
  y -= 10;

  const facts: [string, string][] = [
    ["Contractor", `${input.contractorName} (${input.contractorCode})`],
    ["Agreement version", `Version ${input.version}, issued ${formatLongDate(input.versionIssuedAt, input.timezone)}`],
    ["Accepted", formatMoment(input.acceptedAt, input.timezone)],
    ["IP address", input.ip],
    ["Device", input.userAgent ?? "Not recorded"],
    ["File fingerprint (SHA-256)", input.documentHash],
  ];
  for (const [label, value] of facts) {
    text(label, 9, regular, muted);
    text(value, 11, regular);
    y -= 8;
  }

  y -= 6;
  text(
    `On the date above ${input.contractorName} read and accepted version ${input.version} of the contractor agreement with ${input.legalEntityName}, by ticking the acceptance box and pressing Accept while signed in. The fingerprint identifies the exact file that was accepted: the same file always gives the same fingerprint, and any change to it gives a different one.`,
    10,
    regular,
  );
  y -= 14;
  text(`Questions: ${input.operatorPhone} - ${input.operatorEmail}`, 10, regular, muted);

  return pdf.save();
}
