// The review request -- Feature 6009, ratings and reviews.
//
// Notifications / Customer messages (Review request). Asked from inside the transaction that
// caused it, so a rolled-back step sends nothing: as a reaction in the paid step (payments/paid.ts),
// and beside the Callback - no charge email when a goodwill callback is completed.
//
// ONE request per JOB: the idempotency key carries the job, so an invoice a Correct & reissue
// replaced and that is paid later asks nothing more. A job that already has a review asks nothing.
// A job with no completed assignment (a no-show's call-out invoice) asks nothing.
import { CapabilityTokenType } from "../capability-tokens/index.js";
import { sendNotification } from "../notifications/index.js";
import type { Prisma } from "../generated/prisma/client.js";

type Db = Prisma.TransactionClient;

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

export async function askReviewRequest(db: Db, jobId: string): Promise<void> {
  // Asked for already (a replaced invoice paid later): look first. Inside a transaction a repeated
  // ask would hit the unique key and abort the whole step, so the repeat must never be attempted.
  const key = `review_request:job:${jobId}:email`;
  if ((await db.notification.count({ where: { idempotencyKey: key } })) > 0) return;
  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      customer: true,
      serviceType: { select: { trade: true } },
      assignments: { where: { status: "completed" }, orderBy: { completedAt: "desc" }, take: 1, include: { contractor: { select: { name: true } } } },
    },
  });
  const done = job.assignments[0];
  if (done === undefined) return;
  if ((await db.review.count({ where: { jobId } })) > 0) return;
  const settings = await db.platformSettings.findFirstOrThrow({ select: { operatorPhone: true } });
  await sendNotification(
    {
      type: "review_request",
      channel: "email",
      recipientType: "customer",
      recipientId: job.customerId,
      idempotencyKey: key,
      relatedType: "job",
      relatedId: jobId,
      jobId,
      context: {
        firstName: firstNameOf(job.customer.name),
        trade: job.serviceType.trade.toLowerCase(),
        jobReference: job.reference,
        tradieFirstName: firstNameOf(done.contractor.name),
        officePhone: settings.operatorPhone,
      },
      capabilityLink: { type: CapabilityTokenType.review, jobId },
    },
    db,
  );
}
