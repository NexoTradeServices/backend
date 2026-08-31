// The dispatcher -- Feature 1004, notification module.
//
// THE QUEUE IS THE NOTIFICATION TABLE. Rows at `queued` are the work list, and
// a loop inside the API process claims and sends them. No Redis, no second
// service: the backend already has to run always-on on Fly for Stripe's
// webhooks, so the machine that drains this queue already has to exist.
//
// A ROW IS CLAIMED FOR AS LONG AS IT IS BEING SENT. The claim is a SELECT ... FOR
// UPDATE SKIP LOCKED inside a transaction that stays open across the provider
// call, so the row lock -- not a timing argument -- is what stops a second loop.
// One row per transaction, so a slow provider holds exactly one connection and a
// batch never multiplies that.
//
// An earlier build claimed with a single statement and leaned on the spent
// attempt plus the backoff to keep other loops away. That reasoning only covers a
// row claimed while it is still fresh: a row ALREADY older than its next backoff
// step is due again the instant the claim commits, so during a Fly deploy overlap
// two loops could both send it and Bob would be dispatched twice for one job. See
// review finding R1.1.
//
// What is still at-least-once, and cannot be otherwise without a claim marker on
// the row: if the provider accepts the message and the transaction then fails to
// commit, the row rolls back to `queued` and is sent again. Losing the commit is
// rare; sending twice from two live loops was not.
import { Prisma } from "../generated/prisma/client.js";
import { getPrisma, type PrismaClient } from "../db/client.js";
import { channelFor } from "./channels/index.js";
import { resolveProvider } from "./providers/registry.js";
import { blockedReason } from "./suppression.js";
import { getTemplate } from "./templates/registry.js";
import type { Notification, NotificationContext, SendContext } from "./types.js";

/**
 * Three attempts, then `failed` with the provider's error on the row. A
 * provider blip heals itself; a dead address stops and stays visible instead of
 * retrying forever. Starting numbers -- real traffic can move them.
 */
export const MAX_ATTEMPTS = 3;

/** Minutes to wait after failure 1, 2, 3 ... The last entry is only reached if MAX_ATTEMPTS grows. */
export const RETRY_BACKOFF_MINUTES = [1, 5, 25];

/** How many rows one pass claims. */
const DEFAULT_BATCH = 25;

/** How often the running app looks for work. */
const DEFAULT_INTERVAL_MS = 15_000;

/**
 * How long after `createdAt` a row with this many spent attempts may be tried
 * again -- the backoffs, added up.
 *
 * The clock runs from `createdAt` rather than from the last attempt because the
 * row carries no last-attempt time: the design's Notification record is a
 * delivery log, and adding a column to it to hold a retry clock would be a
 * change to the data model for something derivable. The two only differ when
 * the first attempt is itself late, which on a 15-second poll it is not.
 *
 * IT IS ALSO WHY BACKOFF SPACING SURVIVES ONLY WHILE THE QUEUE IS KEPT UP WITH.
 * A row that has sat for an hour -- the dispatcher was down, or a deploy took a
 * while -- is past every one of its backoff steps the moment it is picked up, so
 * its three attempts land as fast as successive passes come round rather than
 * spread over six minutes. That is worst exactly when a provider is still
 * recovering. Fixing it properly needs a last-attempt (or next-attempt) time on
 * the row, which is a Data Model field and so the architect's call: parked as Q2
 * in this feature's change.md. What IS handled here is the sharp edge -- one pass
 * can only ever spend one attempt on a row (see drainOnce).
 *
 * AND THE COMPARISON IS MADE IN UTC ON BOTH SIDES. Prisma stores DateTime as
 * `timestamp without time zone` holding UTC, while bare now() is a timestamptz
 * that Postgres renders in the SESSION's zone. On the Perth dev box that is
 * eight hours ahead, so every backoff was instantly due; on Fly, which runs UTC,
 * the same code would have looked perfect. `now() AT TIME ZONE 'UTC'` puts both
 * sides in the frame the column is actually stored in.
 */
export function dueOffsetMinutes(attempts: number): number {
  let total = 0;
  for (let i = 0; i < attempts && i < RETRY_BACKOFF_MINUTES.length; i += 1) {
    total += RETRY_BACKOFF_MINUTES[i] ?? 0;
  }
  return total;
}

/** The backoff, as SQL, built from the same constant the code reads. */
function dueOffsetSql(): string {
  const arms = Array.from({ length: MAX_ATTEMPTS }, (_unused, attempts) =>
    `WHEN ${String(attempts)} THEN ${String(dueOffsetMinutes(attempts))}`,
  ).join(" ");
  return `CASE c.attempts ${arms} ELSE 0 END`;
}

/** A row as raw SQL hands it back -- column names, not Prisma's relation shape. */
type ClaimedRow = Notification;

/**
 * The client inside a transaction. `deliver` and its helpers take this rather
 * than the full client, so nothing down there can start a nested transaction or
 * quietly write on a different connection than the one holding the row lock.
 */
type TransactionalDb = Prisma.TransactionClient;

/**
 * How long one claim-and-send may hold its row and its connection. A hung
 * provider must not pin either forever; the adapters cap their own HTTP call
 * well inside this.
 */
const TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * Take ONE due row and send it, with the row locked for the whole of it.
 *
 * SKIP LOCKED is what makes this safe to run twice at once: a row another
 * claimer is holding is stepped over, not waited for -- and it is still holding
 * it, because the transaction does not commit until the send is finished either
 * way. Returns false when there was nothing due.
 */
async function claimAndSendOne(
  client: PrismaClient,
  alreadyHandled: string[],
): Promise<string | null> {
  return client.$transaction(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<ClaimedRow[]>(
        `
        SELECT c.*
          FROM "Notification" c
         WHERE c.status = 'queued'
           AND c.attempts < ${String(MAX_ATTEMPTS)}
           AND c."createdAt" + make_interval(mins => ${dueOffsetSql()}) <= (now() AT TIME ZONE 'UTC')
           AND c.id <> ALL($1::text[])
         ORDER BY c."createdAt"
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      `,
        alreadyHandled,
      );

      const row = rows[0];
      if (row === undefined) return null;

      // The attempt is spent at claim time, so a process that dies mid-send
      // costs the message one attempt rather than looping on it forever.
      const claimed: ClaimedRow = { ...row, attempts: row.attempts + 1 };
      await tx.notification.update({
        where: { id: row.id },
        data: { attempts: claimed.attempts },
      });

      await deliver(tx, claimed);
      return row.id;
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );
}

/** Never retried: the reason will read exactly the same in five minutes. */
async function giveUp(client: TransactionalDb, id: string, reason: string): Promise<void> {
  await client.notification.update({
    where: { id },
    data: { status: "failed", error: reason },
  });
}

/** Retried until the attempts run out, then left `failed` carrying the last error. */
async function failAttempt(
  client: TransactionalDb,
  row: ClaimedRow,
  reason: string,
): Promise<void> {
  const spent = row.attempts; // already incremented by the claim
  await client.notification.update({
    where: { id: row.id },
    data: { status: spent >= MAX_ATTEMPTS ? "failed" : "queued", error: reason },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contextOf(row: ClaimedRow): NotificationContext {
  const raw: unknown = row.context;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as NotificationContext;
}

/** One claimed row, all the way to `sent` or to a recorded reason it was not. */
export async function deliver(client: TransactionalDb, row: ClaimedRow): Promise<void> {
  const settings = await client.platformSettings.findFirst();
  if (settings === null) {
    await failAttempt(client, row, "no PlatformSettings row -- run the base seed");
    return;
  }
  const context: SendContext = { client, settings };

  const template = getTemplate(row.type, row.channel);
  if (template === undefined) {
    await giveUp(client, row.id, `no ${row.channel} template for notification type "${row.type}"`);
    return;
  }

  const channel = channelFor(row.channel);
  const lookup = await channel.addressFor(context, row.recipientType, row.recipientId);
  if ("reason" in lookup) {
    await giveUp(client, row.id, lookup.reason);
    return;
  }

  // Both gates run here, at send, and both are terminal: consent withdrawn is
  // not a transient fault, and a bounced address will not heal by five o'clock.
  const blocked = await blockedReason(context, {
    category: template.category,
    channel: row.channel,
    address: lookup.address,
    recipientType: row.recipientType,
    recipientId: row.recipientId,
  });
  if (blocked !== null) {
    await giveUp(client, row.id, blocked);
    return;
  }

  let rendered;
  try {
    rendered = template.render(contextOf(row));
  } catch (error: unknown) {
    // A template variable that is missing now is missing on every retry.
    await giveUp(client, row.id, `render failed: ${messageOf(error)}`);
    return;
  }

  const refused = channel.check(rendered);
  if (refused !== null) {
    await giveUp(client, row.id, refused);
    return;
  }

  let provider;
  try {
    provider = resolveProvider(settings, row.type, row.channel);
  } catch (error: unknown) {
    // A misconfigured provider IS fixable -- the owner edits the settings row --
    // so this one keeps its retries rather than giving up on the message.
    await failAttempt(client, row, messageOf(error));
    return;
  }

  try {
    const { providerMessageId } = await provider.send({
      to: lookup.address,
      message: rendered,
    });
    await client.notification.update({
      where: { id: row.id },
      data: {
        status: "sent",
        provider: provider.name,
        providerMessageId,
        sentAt: new Date(),
        error: null,
      },
    });
  } catch (error: unknown) {
    await failAttempt(client, row, messageOf(error));
  }
}

/**
 * Claim and send what is due, one row at a time, up to `limit`. Returns how many
 * rows this pass handled.
 *
 * Sequential on purpose: each row holds a connection for the length of its
 * provider call, and a batch that sent in parallel would hold `limit` of them.
 *
 * ONE ATTEMPT PER ROW PER PASS. A row this pass has already tried is excluded
 * from the rest of it, so a failing message cannot burn all three of its
 * attempts inside one loop -- which is exactly what happens otherwise to a row
 * that was already overdue when the pass began, because its next attempt is due
 * the moment the last one finishes. See the parked question Q2 in this feature's
 * change.md for the half of that problem this cannot fix.
 */
export async function drainOnce(
  client: PrismaClient = getPrisma(),
  limit = DEFAULT_BATCH,
): Promise<number> {
  const handled: string[] = [];
  while (handled.length < limit) {
    const id = await claimAndSendOne(client, handled);
    if (id === null) break;
    handled.push(id);
  }
  return handled.length;
}

export interface Dispatcher {
  /** Stop looking for work, and wait for the pass in flight to finish. */
  stop(): Promise<void>;
}

export interface DispatcherOptions {
  client?: PrismaClient;
  intervalMs?: number;
  batchSize?: number;
}

/**
 * The running loop. Started from the API's boot and stoppable, so tests can
 * drive the queue by hand with drainOnce() instead of racing a timer.
 */
export function startDispatcher(options: DispatcherOptions = {}): Dispatcher {
  const client = options.client ?? getPrisma();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH;

  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    // One pass at a time in this process. A pass that overruns the interval must
    // not have a second pass started on top of it.
    inFlight = inFlight.then(async () => {
      if (stopped) return;
      try {
        await drainOnce(client, batchSize);
      } catch (error: unknown) {
        // The loop outlives its failures: a database blip must not kill the
        // process that also serves Stripe's webhooks.
        console.error("notification dispatcher pass failed", error);
      }
    });
  }, intervalMs);

  // Never the reason a process stays alive.
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
