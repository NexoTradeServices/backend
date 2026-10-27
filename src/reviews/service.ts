// The review link and the review it saves -- Feature 6009, ratings and reviews.
//
// Ratings & Reviews; Identity & Access / Passwordless capability links (a dead link explains itself).
// NO session: the token in the path is the permission (ADR 0004). One review per job (Review.jobId
// is unique), single use, 30 days from the send.
//
//   read    open -> the page's facts; used / expired -> 410 with why; unknown -> 404
//   submit  one transaction: spend the token, keep the Review, recompute the contractor's average and count
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { CapabilityTokenType, consumeCapabilityToken, findCapabilityToken } from "../capability-tokens/index.js";
import { formatDate } from "../time/index.js";

type Db = Prisma.TransactionClient | PrismaClient;

export type ReviewRead =
  | { state: "open"; firstName: string; trade: string; jobReference: string; finishedOn: string; officePhone: string }
  | { state: "used"; jobReference: string; officePhone: string }
  | { state: "expired"; jobReference: string; officePhone: string }
  | { state: "unknown"; officePhone: string };

export function statusOfRead(read: ReviewRead): number {
  if (read.state === "open") return 200;
  return read.state === "unknown" ? 404 : 410;
}

async function officePhoneOf(db: Db): Promise<string> {
  const settings = await db.platformSettings.findFirst({ select: { operatorPhone: true } });
  return settings?.operatorPhone ?? "";
}

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

export async function readReview(client: PrismaClient, rawToken: string, now: Date): Promise<ReviewRead> {
  const officePhone = await officePhoneOf(client);
  const unknown: ReviewRead = { state: "unknown", officePhone };
  const token = await findCapabilityToken(client, rawToken);
  if (token === null || token.type !== CapabilityTokenType.review || token.jobId === null) return unknown;
  const job = await client.job.findUnique({
    where: { id: token.jobId },
    include: {
      serviceType: { select: { trade: true } },
      customer: { select: { name: true } },
      assignments: { where: { status: "completed" }, orderBy: { completedAt: "desc" }, take: 1, include: { contractor: { select: { name: true } } } },
    },
  });
  const done = job?.assignments[0];
  if (job === null || job === undefined || done === undefined) return unknown;
  const reviewed = (await client.review.count({ where: { jobId: job.id } })) > 0;
  if (token.usedAt !== null || reviewed) return { state: "used", jobReference: job.reference, officePhone };
  if (token.expiresAt.getTime() <= now.getTime()) return { state: "expired", jobReference: job.reference, officePhone };
  return {
    state: "open",
    firstName: firstNameOf(done.contractor.name),
    trade: job.serviceType.trade,
    jobReference: job.reference,
    finishedOn: formatDate(job.timezone, done.completedAt ?? now),
    officePhone,
  };
}

export interface ReviewInput {
  rating: number;
  reviewText: string | null;
  recommendScore: number | null;
}

export type ParsedInput = { ok: true; input: ReviewInput } | { ok: false; error: string; field: string };

export function parseReviewInput(body: unknown): ParsedInput {
  const raw = (body ?? {}) as Record<string, unknown>;
  const rating = raw["rating"];
  if (rating === undefined || rating === null || rating === "") return { ok: false, error: "Choose a star.", field: "rating" };
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: "Choose from 1 to 5 stars.", field: "rating" };
  }
  const score = raw["recommendScore"];
  if (score !== undefined && score !== null && (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 10)) {
    return { ok: false, error: "Choose from 0 to 10.", field: "recommendScore" };
  }
  const text = raw["reviewText"];
  if (text !== undefined && text !== null && typeof text !== "string") return { ok: false, error: "Not valid.", field: "reviewText" };
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length > 2000) return { ok: false, error: "Keep it under 2000 characters.", field: "reviewText" };
  return { ok: true, input: { rating, reviewText: trimmed === "" ? null : trimmed, recommendScore: typeof score === "number" ? score : null } };
}

/** The contractor's average (one decimal, kept as a float) and count, from all his reviews. */
export async function recomputeContractorRating(db: Db, contractorId: string): Promise<{ average: number | null; count: number }> {
  const sum = await db.review.aggregate({ where: { contractorId }, _avg: { rating: true }, _count: { _all: true } });
  const average = sum._avg.rating === null ? null : Math.round(sum._avg.rating * 10) / 10;
  await db.contractor.update({ where: { id: contractorId }, data: { averageRating: average, reviewCount: sum._count._all } });
  return { average, count: sum._count._all };
}

export type SubmitResult = { ok: true } | { ok: false; status: number; body: Record<string, unknown> };

export async function submitReview(client: PrismaClient, rawToken: string, input: ReviewInput, now: Date): Promise<SubmitResult> {
  const dead = async (): Promise<SubmitResult> => {
    const read = await readReview(client, rawToken, now);
    return { ok: false, status: statusOfRead(read), body: { ...read } };
  };
  const first = await readReview(client, rawToken, now);
  if (first.state !== "open") return { ok: false, status: statusOfRead(first), body: { ...first } };
  try {
    return await client.$transaction(async (tx): Promise<SubmitResult> => {
      const spent = await consumeCapabilityToken(tx, rawToken, CapabilityTokenType.review);
      if (!spent.ok || spent.jobId === null) return dead();
      const job = await tx.job.findUniqueOrThrow({
        where: { id: spent.jobId },
        select: { id: true, customerId: true, testData: true, assignments: { where: { status: "completed" }, orderBy: { completedAt: "desc" }, take: 1, select: { contractorId: true } } },
      });
      const done = job.assignments[0];
      if (done === undefined) return dead();
      await tx.review.create({
        data: {
          jobId: job.id,
          customerId: job.customerId,
          contractorId: done.contractorId,
          rating: input.rating,
          reviewText: input.reviewText,
          recommendScore: input.recommendScore,
          ...(job.testData === null ? {} : { testData: job.testData }),
        },
      });
      await recomputeContractorRating(tx, done.contractorId);
      return { ok: true };
    });
  } catch (error: unknown) {
    // Another link of the same job saved its review a moment ago: one review per job.
    if ((error as { code?: unknown }).code === "P2002") return dead();
    throw error;
  }
}

export const REVIEWS_PAGE = 50;

export interface ContractorReviews {
  average: number | null;
  count: number;
  reviews: { id: string; createdAt: string; createdLabel: string; jobReference: string; rating: number; reviewText: string | null }[];
  /** Pass back as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
}

/** A contractor's reviews, newest first, 50 at a time. The 0-10 recommend score is the business's, never shown here. */
export async function listContractorReviews(client: PrismaClient, contractorId: string, cursor: string | null): Promise<ContractorReviews> {
  const contractor = await client.contractor.findUniqueOrThrow({ where: { id: contractorId }, select: { averageRating: true, reviewCount: true } });
  const rows = await client.review.findMany({
    where: { contractorId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: REVIEWS_PAGE + 1,
    ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
    include: { job: { select: { reference: true, timezone: true } } },
  });
  const page = rows.slice(0, REVIEWS_PAGE);
  return {
    average: contractor.averageRating,
    count: contractor.reviewCount ?? 0,
    reviews: page.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      createdLabel: formatDate(row.job.timezone, row.createdAt),
      jobReference: row.job.reference,
      rating: row.rating,
      reviewText: row.reviewText,
    })),
    nextCursor: rows.length > REVIEWS_PAGE ? (page[page.length - 1]?.id ?? null) : null,
  };
}
