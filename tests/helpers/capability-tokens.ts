// Test helpers -- Feature 1005, capability tokens.
//
// JOB-1042 and Bob's assignment on it are the cast's reference job (cast.md),
// deliberately NOT part of the base fixture seed (see fixtures.ts) -- each
// feature that needs them creates its own, here, in its own tests.
//
// Also: two test-only templates carrying `{{linkUrl}}`, so the dispatch-path
// criteria can prove a real message contains a real link. The wording is a
// stand-in; the real dispatch/review/track messages belong to the features
// that send them (4002, 6009, 4005 -- see this feature's Scope).
import type { PrismaClient } from "../../src/db/client.js";
import type { NotificationTemplate } from "../../src/notifications/types.js";
import { zoneForState } from "../../src/time/index.js";
import type { CastIds } from "./notifications.js";

export interface JobAndAssignment {
  jobId: string;
  assignmentId: string;
}

/**
 * JOB-1042, dispatched to Bob (Plumbing) with a proposed slot -- the
 * assignment AC1 mints Bob's respond token against.
 */
export async function seedJob1042(client: PrismaClient, cast: CastIds): Promise<JobAndAssignment> {
  const serviceType = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const specialty = await client.contractorSpecialty.findFirstOrThrow({
    where: { contractorId: cast.bobId, trade: "Plumbing" },
  });

  const job = await client.job.create({
    data: {
      reference: "JOB-1042",
      customerId: cast.sarahId,
      serviceTypeId: serviceType.id,
      customerCalloutRate: 25_000,
      customerStandardRate: 18_000,
      postcode: "6160",
      serviceLocation: { suburb: "Fremantle", state: "WA", country: "AU", postcode: "6160" },
      timezone: zoneForState("WA"),
      preferredWindow: "morning",
    },
  });

  const assignment = await client.assignment.create({
    data: {
      jobId: job.id,
      contractorId: cast.bobId,
      specialtyId: specialty.id,
      proposedSlot: new Date(Date.now() + 2 * 60 * 60 * 1000),
    },
  });

  return { jobId: job.id, assignmentId: assignment.id };
}

/** Bob's respond SMS -- stand-in for feature 4002's real dispatch wording. */
export const respondLinkSms: NotificationTemplate = {
  type: "respond_link_test",
  channel: "sms",
  category: "transactional",
  render: (context) => ({
    text: `New job ${String(context["jobReference"] ?? "")} - respond: ${String(context["linkUrl"] ?? "")}`,
  }),
};

/** Sarah's track SMS -- stand-in for feature 4005's real wording. */
export const trackLinkSms: NotificationTemplate = {
  type: "track_link_test",
  channel: "sms",
  category: "transactional",
  render: (context) => ({
    text: `Track your job here: ${String(context["linkUrl"] ?? "")}`,
  }),
};

/** Sarah's review-request email -- stand-in for feature 6009's real wording. */
export const reviewLinkEmail: NotificationTemplate = {
  type: "review_link_test",
  channel: "email",
  category: "transactional",
  render: (context) => ({
    subject: "How did we do?",
    text: `Leave a review: ${String(context["linkUrl"] ?? "")}`,
  }),
};
