// Feature 9001 -- the one date writer (Data Model / Time; frontend-conventions /
// Organisms / Lists and tables / Formats).
//   AC1: "9 Sep 2026", month names fixed (September is "Sep", never "Sept"), no numbers.
//   AC2: "Wed 14 Oct" in the current year, "Wed 14 Oct 2025" outside it -- decided in the zone.
//   AC3: "9 Sep 2026, 10:14am"; "Today, 8:00am AWST" / "Thu 10 Sep, 8:00am AWST".
import { describe, expect, test } from "vitest";
import { makeAcceptanceRecord } from "../src/agreements/pdf.js";
import { makeInvoicePdf } from "../src/invoices/pdf.js";
import { pdfText } from "./helpers/agreements.js";
import {
  formatDate,
  formatDateTimeLabel,
  formatDateTimeZoned,
  formatDateWithDay,
  formatPlainDate,
  formatPlainDateShort,
  formatShortDateTime,
  formatSlotLabel,
} from "../src/time/index.js";

const PERTH = "Australia/Perth";
const NOW = new Date("2026-10-11T02:00:00.000Z"); // 10:00am Sun 11 Oct, Perth

describe("AC1 -- a date written out", () => {
  test("AC1: every month is its own three letters; September is Sep", () => {
    const months = Array.from({ length: 12 }, (_, index) => formatDate("UTC", new Date(Date.UTC(2026, index, 9, 12))));
    expect(months).toEqual([
      "9 Jan 2026",
      "9 Feb 2026",
      "9 Mar 2026",
      "9 Apr 2026",
      "9 May 2026",
      "9 Jun 2026",
      "9 Jul 2026",
      "9 Aug 2026",
      "9 Sep 2026",
      "9 Oct 2026",
      "9 Nov 2026",
      "9 Dec 2026",
    ]);
  });

  test("AC1: the day is read in the zone that decides, never the viewer's", () => {
    // 4:00pm UTC on the 9th is already the 10th in Perth.
    expect(formatDate(PERTH, new Date("2026-09-09T16:00:00.000Z"))).toBe("10 Sep 2026");
    expect(formatDate("UTC", new Date("2026-09-09T16:00:00.000Z"))).toBe("9 Sep 2026");
  });

  test("AC1: a plain date is read as stored and written in full", () => {
    expect(formatPlainDateShort(new Date("2027-03-14T00:00:00.000Z"))).toBe("14 Mar 2027");
  });
});

describe("AC2 -- a date with its weekday", () => {
  test("AC2: this year carries no year; any other year carries it", () => {
    expect(formatDateWithDay(PERTH, new Date("2026-10-14T00:00:00.000Z"), NOW)).toBe("Wed 14 Oct");
    expect(formatDateWithDay(PERTH, new Date("2025-10-14T00:00:00.000Z"), NOW)).toBe("Tue 14 Oct 2025");
    expect(formatDateWithDay(PERTH, new Date("2027-01-05T00:00:00.000Z"), NOW)).toBe("Tue 5 Jan 2027");
  });

  test("AC2: the year boundary is the zone's own midnight", () => {
    // 4:30pm UTC on 31 Dec is already 1 Jan in Perth: next year there, this year in UTC.
    const lateNewYearsEve = new Date("2026-12-31T16:30:00.000Z");
    const decemberNow = new Date("2026-12-20T02:00:00.000Z");
    expect(formatDateWithDay(PERTH, lateNewYearsEve, decemberNow)).toBe("Fri 1 Jan 2027");
    expect(formatDateWithDay("UTC", lateNewYearsEve, decemberNow)).toBe("Thu 31 Dec");
  });

  test("AC2: a plain date follows the same rule", () => {
    expect(formatPlainDate(new Date("2026-09-11T00:00:00.000Z"), NOW)).toBe("Fri 11 Sep");
    expect(formatPlainDate(new Date("2025-09-11T00:00:00.000Z"), NOW)).toBe("Thu 11 Sep 2025");
  });
});

describe("AC3 -- a date with a time", () => {
  test("AC3: the date and time, no zone name", () => {
    expect(formatShortDateTime(PERTH, new Date("2026-09-09T02:14:00.000Z"))).toBe("9 Sep 2026, 10:14am");
  });

  test("AC3: the date and time, with its zone", () => {
    expect(formatDateTimeZoned(PERTH, new Date("2026-10-15T06:15:00.000Z"))).toBe("15 Oct 2026, 2:15pm AWST");
  });

  test("AC3: a slot is Today, or its weekday and date, with its zone", () => {
    expect(formatSlotLabel(PERTH, new Date("2026-10-11T05:00:00.000Z"), NOW)).toBe("Today, 1:00pm AWST");
    expect(formatSlotLabel(PERTH, new Date("2026-10-14T00:00:00.000Z"), NOW)).toBe("Wed 14 Oct, 8:00am AWST");
    expect(formatSlotLabel(PERTH, new Date("2025-09-10T00:00:00.000Z"), NOW)).toBe("Wed 10 Sep 2025, 8:00am AWST");
    expect(formatDateTimeLabel(PERTH, new Date("2026-09-08T07:20:00.000Z"), NOW)).toBe("Tue 8 Sep, 3:20pm AWST");
  });
});

describe("AC1 -- the PDFs", () => {
  test("AC1: the invoice's Issued and Due lines and the agreement's acceptance line read '9 Sep 2026', never 'Sept'", async () => {
    const issuedAt = new Date("2026-09-09T02:14:00.000Z");
    const invoice = pdfText(
      await makeInvoicePdf({
        legalEntityName: "Idelta Pty Ltd",
        businessAbn: "12 345 678 901",
        businessAddress: null,
        accountsPhone: "08 9000 0000",
        reference: "INV-2041",
        jobReference: "JOB-1042",
        timezone: PERTH,
        issuedAt,
        dueAt: new Date("2026-09-23T02:14:00.000Z"),
        billedTo: { name: "Sarah Chen" },
        lines: [{ description: "Call-out", qty: 1, unitPrice: 25000, lineTotal: 25000 }],
        amount: 25000,
        gstApplied: false,
        gstAmount: 0,
        paid: false,
        payLinkUrl: null,
      }),
    );
    expect(invoice).toContain("9 Sep 2026");
    expect(invoice).toContain("23 Sep 2026");
    expect(invoice).not.toContain("Sept");

    const agreement = pdfText(
      await makeAcceptanceRecord({
        legalEntityName: "Idelta Pty Ltd",
        businessAbn: "12 345 678 901",
        businessAddress: null,
        contractorName: "Bob Reilly",
        contractorCode: "CON-014",
        version: "1",
        versionIssuedAt: new Date("2026-09-01T02:00:00.000Z"),
        acceptedAt: issuedAt,
        timezone: PERTH,
        ip: "203.0.113.7",
        userAgent: null,
        documentHash: "abc123",
        operatorPhone: "08 9000 0000",
        operatorEmail: "office@idelta.com.au",
      }),
    );
    expect(agreement).toContain("9 Sep 2026, 10:14am AWST");
    expect(agreement).toContain("issued 1 Sep 2026");
    expect(agreement).not.toContain("Sept");
  });
});
