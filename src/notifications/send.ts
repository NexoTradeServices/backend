// The ask -- Feature 1004, notification module.
//
// This is what a feature actually does: hand over a type, a recipient, a
// context and an idempotency key, and stop thinking about it. Nothing here
// touches a provider. The row is written, the call returns, and the dispatcher
// does the rest off the request path -- so a slow provider can never slow down
// the enquiry form or the dispatch screen.
import { getPrisma, type PrismaClient } from "../db/client.js";
import { assertLinkSpec, CAPABILITY_LINK_CONTEXT_KEY } from "../capability-tokens/index.js";
import { getTemplate } from "./templates/registry.js";
import type { Notification, NotificationContext, SendRequest } from "./types.js";

/**
 * The key's shape is fixed: `<type>:<relatedType>:<relatedId>`, plus a
 * discriminator where one record can legitimately send the same message more
 * than once (the "on my way" tap keys per calendar block). It has to be
 * derivable by the caller without reading the table first, because the unique
 * constraint on the column -- not a lookup -- is what stops the second send.
 */
function assertIdempotencyKey(key: string, type: string): void {
  const parts = key.split(":");
  if (parts.length < 3 || parts.some((part) => part === "")) {
    throw new Error(
      `idempotency key "${key}" is not <type>:<relatedType>:<relatedId>[:discriminator]`,
    );
  }
  if (parts[0] !== type) {
    throw new Error(`idempotency key "${key}" does not start with its own type "${type}"`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Queue one notification. Returns the row -- the new one, or the one that was
 * already there when the same key arrives twice.
 *
 * THE ONLY WAY ANYTHING GETS SENT. No feature anywhere else contains email or
 * SMS logic; it asks here.
 */
export async function sendNotification(
  request: SendRequest,
  client: PrismaClient = getPrisma(),
): Promise<Notification> {
  assertIdempotencyKey(request.idempotencyKey, request.type);

  // The template is looked up NOW, not at dispatch, so a caller asking for a
  // message that has no wording fails in its own stack trace rather than
  // leaving a row that can never be rendered.
  const template = getTemplate(request.type, request.channel);
  if (template === undefined) {
    throw new Error(`no ${request.channel} template for notification type "${request.type}"`);
  }

  // Feature 1005, capability tokens, AC9: a link spec that cannot mint is
  // refused HERE, in the caller's own stack trace -- never a queued row that
  // sits there because the dispatcher cannot mint it either.
  if (request.capabilityLink !== undefined) {
    assertLinkSpec(request.capabilityLink);
  }

  const context: NotificationContext | undefined =
    request.context === undefined && request.capabilityLink === undefined
      ? undefined
      : {
          ...request.context,
          // Decision 2: the spec rides inside context, under one reserved key,
          // so it survives the async gap without a schema change. Serialized
          // to a string because NotificationContext values are flat -- the
          // same shape a template can render.
          ...(request.capabilityLink === undefined
            ? {}
            : { [CAPABILITY_LINK_CONTEXT_KEY]: JSON.stringify(request.capabilityLink) }),
        };

  try {
    return await client.notification.create({
      data: {
        recipientType: request.recipientType,
        recipientId: request.recipientId,
        channel: request.channel,
        type: request.type,
        // The MESSAGE decides this, never the caller -- see NotificationTemplate.
        category: template.category,
        relatedType: request.relatedType ?? null,
        relatedId: request.relatedId ?? null,
        jobId: request.jobId ?? null,
        context: context ?? undefined,
        idempotencyKey: request.idempotencyKey,
      },
    });
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error;
    // The guard fired: this exact message was already asked for. Hand back the
    // row that exists -- a retry or a double-tap must be indistinguishable from
    // the first ask, from the caller's side.
    return client.notification.findUniqueOrThrow({
      where: { idempotencyKey: request.idempotencyKey },
    });
  }
}
