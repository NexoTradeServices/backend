// Feature 6009 -- ratings and reviews (Ratings & Reviews; Passwordless capability links; Customer messages)
//
// AC1  Sarah pays a completed job's invoice: one review request reaches her -- the words, five
//      star links, the office phone, no money, no "contractor"
// AC2  a goodwill callback asks at Complete, beside the Callback - no charge email; a no-show's
//      paid call-out invoice asks nothing; a replaced invoice paid later asks nothing more
// AC4  Send with no star is refused ("Choose a star.") and saves nothing; with a star (comment and
//      score optional) the Review is saved with recommendScore and the link is used up
// AC5  a used link says used (410, with the job); a link past 30 days says expired (410, with the
//      office phone); an unknown link is 404
// AC7  the ops job page carries the review (stars, comment, score, who and when) on a completed job, null before she rates
// AC6  a saved review recomputes Bob's averageRating and reviewCount
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { resetReferenceSequences, testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { freshWorld, signIn } from "./helpers/ops-app.js";
import { acceptCallback, buildCallbackApp, completeCallback, completedOriginal, raise } from "./helpers/callbacks.js";
import { owedInvoice } from "./helpers/owed-invoice.js";
import { drainOnce } from "../src/notifications/index.js";
import { recordConfirmedPayment } from "../src/payments/paid.js";
import { askReviewRequest } from "../src/reviews/messages.js";
import { reviewRoutes } from "../src/reviews/routes.js";
import { CapabilityTokenType, mintCapabilityLink } from "../src/capability-tokens/index.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
const email = recordingAdapter("test-email-6009", "email");

beforeAll(() => {
  db = testClient();
  registerProvider(email);
  app = buildCallbackApp(db);
  app.use("/api/review", reviewRoutes(db));
});

afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});

beforeEach(async () => {
  await freshWorld(db, email);
});

afterEach(async () => {
  await resetReferenceSequences(db);
});

/** Sarah pays the invoice (the one paid step the Stripe webhook drives). */
async function pay(invoice: { invoiceId: string; invoiceReference: string }, intent = "pi_6009"): Promise<void> {
  await recordConfirmedPayment(db, { invoiceId: invoice.invoiceId, paymentIntentId: intent, amount: 65_500, method: "card", paidAt: new Date() });
}

const requests = (jobId: string) => db.notification.findMany({ where: { jobId, type: "review_request" } });

/** A review link for a job, the way a delivered email carries one: the raw token. */
async function tokenFor(jobId: string): Promise<string> {
  const minted = await mintCapabilityLink(db, { type: CapabilityTokenType.review, jobId });
  return minted.url.split("/review/")[1] ?? "";
}

const read = (token: string) => request(app).get(`/api/review/${token}`);
const send = (token: string, body: Record<string, unknown>) => request(app).post(`/api/review/${token}`).send(body);

describe("AC1 -- the request after payment", () => {
  test("AC1: one email to Sarah: subject, Bob by first name, five star links, the office phone -- no money, no 'contractor'", async () => {
    const sarahs = await owedInvoice(db);
    await pay(sarahs);

    expect(await requests(sarahs.jobId)).toHaveLength(1);
    await drainOnce(db);
    const mail = email.sent.find((m) => (m.message.subject ?? "").startsWith("How did we go?"));
    expect(mail?.to).toBe("sarah@idelta.com.au");
    expect(mail?.message.subject).toBe(`How did we go? - ${sarahs.jobReference}`);
    const text = mail?.message.text ?? "";
    expect(text).toContain("Hi Sarah,");
    expect(text).toContain(`Your plumbing job ${sarahs.jobReference} is finished.`);
    expect(text).toContain("How did Bob go?");
    for (const n of [1, 2, 3, 4, 5]) expect(text).toMatch(new RegExp(`/review/[A-Za-z0-9_-]+\\?rating=${String(n)}`));
    expect(text).toContain("Call us on 08 0000 0000 and we will sort it out.");
    expect(text).not.toContain("$");
    expect(text.toLowerCase()).not.toContain("contractor");
    expect((mail?.message.html ?? "").toLowerCase()).not.toContain("contractor");
    expect(mail?.message.html).toContain("rating=4");
  });

  test("AC1: the same payment again asks nothing more", async () => {
    const sarahs = await owedInvoice(db);
    await pay(sarahs);
    await pay(sarahs);
    expect(await requests(sarahs.jobId)).toHaveLength(1);
  });
});

describe("AC2 -- who is asked, and only once", () => {
  test("AC2: a goodwill callback asks at Complete, beside the Callback - no charge email", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const bob = await signIn(app, "bob@idelta.com.au");
    const original = await completedOriginal(db);
    const reference = await raise(app, mike, original.reference);
    const made = await acceptCallback(db, reference);

    const res = await completeCallback(db, app, bob, made, reference, false);
    expect(res.status).toBe(200);
    expect(await requests(made.jobId)).toHaveLength(1);
    expect(await db.notification.count({ where: { jobId: made.jobId, type: "callback_no_charge" } })).toBe(1);
  });

  test("AC2: a charged callback asks nothing at Complete -- the payment will", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const bob = await signIn(app, "bob@idelta.com.au");
    const original = await completedOriginal(db);
    const reference = await raise(app, mike, original.reference);
    const made = await acceptCallback(db, reference);

    expect((await completeCallback(db, app, bob, made, reference, true)).status).toBe(200);
    expect(await requests(made.jobId)).toHaveLength(0);
  });

  test("AC2: a no-show's paid call-out invoice asks nothing", async () => {
    const tom = await owedInvoice(db);
    await db.assignment.updateMany({ where: { jobId: tom.jobId }, data: { status: "cancelled", completedAt: null } });
    await db.job.update({ where: { id: tom.jobId }, data: { status: "cancelled", cancelReason: "customer_no_show" } });
    await pay(tom);
    expect(await requests(tom.jobId)).toHaveLength(0);
  });

  test("AC2: a replacement invoice paid after the first was asked still gives one request", async () => {
    const sarahs = await owedInvoice(db);
    await pay(sarahs, "pi_first");
    // Correct & reissue: a second invoice on the same job, paid later.
    await db.$transaction((tx) => askReviewRequest(tx, sarahs.jobId));
    await db.$transaction((tx) => askReviewRequest(tx, sarahs.jobId));
    expect(await requests(sarahs.jobId)).toHaveLength(1);
  });

  test("AC2: a job that already has a review asks nothing", async () => {
    const sarahs = await owedInvoice(db);
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await db.review.create({ data: { jobId: sarahs.jobId, customerId: sarahs.customerId, contractorId: bob.id, rating: 5 } });
    await pay(sarahs);
    expect(await requests(sarahs.jobId)).toHaveLength(0);
  });
});

describe("AC3 / AC4 -- the review link and saving", () => {
  test("AC3: an open link reads Bob's first name, the trade, the job and the finish date", async () => {
    const sarahs = await owedInvoice(db);
    const res = await read(await tokenFor(sarahs.jobId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "open", firstName: "Bob", trade: "Plumbing", jobReference: sarahs.jobReference, finishedOn: "7 Oct 2026", officePhone: "08 0000 0000" });
  });

  test("AC4: no star -> 'Choose a star.' and nothing saved; a star out of range is refused", async () => {
    const sarahs = await owedInvoice(db);
    const token = await tokenFor(sarahs.jobId);
    const none = await send(token, { reviewText: "Great" });
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({ error: "Choose a star.", field: "rating" });
    expect((await send(token, { rating: 6 })).status).toBe(400);
    expect((await send(token, { rating: 0 })).status).toBe(400);
    expect((await send(token, { rating: 3, recommendScore: 11 })).status).toBe(400);
    expect(await db.review.count()).toBe(0);
    expect((await read(token)).status).toBe(200);
  });

  test("AC4: a star alone saves; the comment and the score are optional and kept when given; the link is used up", async () => {
    const sarahs = await owedInvoice(db);
    const token = await tokenFor(sarahs.jobId);
    const res = await send(token, { rating: 4, reviewText: "  Quick and tidy.  ", recommendScore: 9 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "saved" });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    expect(await db.review.findUniqueOrThrow({ where: { jobId: sarahs.jobId } })).toMatchObject({
      rating: 4,
      reviewText: "Quick and tidy.",
      recommendScore: 9,
      customerId: sarahs.customerId,
      contractorId: bob.id,
    });
    const again = await send(token, { rating: 5 });
    expect(again.status).toBe(410);
    expect(again.body).toMatchObject({ state: "used", jobReference: sarahs.jobReference });
    expect(await db.review.count()).toBe(1);
  });

  test("AC4: a star alone -- no comment, no score -- saves with both empty (score 0 is a real answer)", async () => {
    const sarahs = await owedInvoice(db);
    expect((await send(await tokenFor(sarahs.jobId), { rating: 5 })).status).toBe(200);
    expect(await db.review.findUniqueOrThrow({ where: { jobId: sarahs.jobId } })).toMatchObject({ rating: 5, reviewText: null, recommendScore: null });

    const zero = await owedInvoice(db);
    expect((await send(await tokenFor(zero.jobId), { rating: 1, recommendScore: 0 })).status).toBe(200);
    expect((await db.review.findUniqueOrThrow({ where: { jobId: zero.jobId } })).recommendScore).toBe(0);
  });

  test("AC4: a second link of the same job cannot make a second review", async () => {
    const sarahs = await owedInvoice(db);
    const first = await tokenFor(sarahs.jobId);
    const second = await tokenFor(sarahs.jobId);
    expect((await send(first, { rating: 5 })).status).toBe(200);
    const res = await send(second, { rating: 1 });
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ state: "used" });
    expect(await db.review.count()).toBe(1);
  });
});

describe("AC5 -- dead links explain themselves", () => {
  test("AC5: used -> 410 with the job reference", async () => {
    const sarahs = await owedInvoice(db);
    const token = await tokenFor(sarahs.jobId);
    await send(token, { rating: 5 });
    const res = await read(token);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ state: "used", jobReference: sarahs.jobReference });
  });

  test("AC5: past 30 days -> 410 expired with the office phone; the 30 days run from the send", async () => {
    const sarahs = await owedInvoice(db);
    const token = await tokenFor(sarahs.jobId);
    const row = await db.capabilityToken.findFirstOrThrow({ where: { jobId: sarahs.jobId, type: "review" } });
    const days = (row.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    await db.capabilityToken.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 86_400_000) } });
    const res = await read(token);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ state: "expired", officePhone: "08 0000 0000" });
    expect((await send(token, { rating: 5 })).status).toBe(410);
    expect(await db.review.count()).toBe(0);
  });

  test("AC5: an unknown link, and a link of another type, are 404", async () => {
    const res = await read("not-a-real-token");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ state: "unknown" });
    const sarahs = await owedInvoice(db);
    const approve = await mintCapabilityLink(db, { type: CapabilityTokenType.track, jobId: sarahs.jobId });
    expect((await read(approve.url.split("/track/")[1] ?? "")).status).toBe(404);
  });
});

describe("AC6 -- the contractor's average and count", () => {
  test("AC6: each saved review recomputes Bob's averageRating (one decimal) and reviewCount", async () => {
    const stars = [4, 4, 5];
    const expected = [
      { averageRating: 4, reviewCount: 1 },
      { averageRating: 4, reviewCount: 2 },
      { averageRating: 4.3, reviewCount: 3 },
    ];
    expect(await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, select: { averageRating: true, reviewCount: true } })).toEqual({ averageRating: null, reviewCount: null });
    for (const [index, rating] of stars.entries()) {
      const job = await owedInvoice(db);
      expect((await send(await tokenFor(job.jobId), { rating })).status).toBe(200);
      expect(await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, select: { averageRating: true, reviewCount: true } })).toEqual(expected[index]);
    }
  });
});

describe("AC7 -- the job page's review", () => {
  const jobPage = async (cookie: string, reference: string) =>
    (await request(app).get(`/api/jobs/${reference}`).set("Cookie", cookie)).body as {
      status: string;
      review: { rating: number; reviewText: string | null; recommendScore: number | null; customerName: string; createdLabel: string } | null;
    };

  test("AC7: null before she rates; after, the stars, comment, score, who and when", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const sarahs = await owedInvoice(db);
    const before = await jobPage(mike, sarahs.jobReference);
    expect(before.status).toBe("completed");
    expect(before.review).toBeNull();

    await send(await tokenFor(sarahs.jobId), { rating: 4, reviewText: "Quick and tidy.", recommendScore: 9 });
    const after = await jobPage(mike, sarahs.jobReference);
    expect(after.review).toMatchObject({ rating: 4, reviewText: "Quick and tidy.", recommendScore: 9, customerName: "Sarah Chen" });
    expect(after.review?.createdLabel).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
  });
});
