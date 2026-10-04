// /api/respond -- Feature 4003, accept / decline.
//
// Plan decision 1: three endpoints, NO session -- the token is the
// permission (ADR 0004), and a login would defeat the one-tap answer.
//
//   GET  /api/respond/:token           the page's read
//   POST /api/respond/:token/accept
//   POST /api/respond/:token/decline   { note? }
//
// A dead link answers 410 (died) or 404 (never existed) with the reason in
// the body; the page says why and offers its one fix.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { sendDeclinedNotice, sendSlotConfirmed } from "./messages.js";
import {
  acceptAssignment,
  declineAssignment,
  parseDeclineNote,
  readRespond,
  statusOfDead,
  type AnswerFacts,
} from "./service.js";

type WithToken = Request<{ token: string }>;

function failWith(res: Response, route: string) {
  return (error: unknown) => {
    console.error(`${route} failed`, error);
    res.status(500).json({ error: "internal error" });
  };
}

/** The answer is already committed: a message that cannot be asked is logged, never turned into a failed answer. */
async function askAfterCommit(route: string, ask: () => Promise<void>): Promise<void> {
  try {
    await ask();
  } catch (error: unknown) {
    console.error(`${route}: the answer was saved but its messages could not be asked`, error);
  }
}

export function respondRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/:token", (req: WithToken, res: Response) => {
    void (async () => {
      const read = await readRespond(client, req.params.token);
      res.status(read.state === "open" ? 200 : statusOfDead(read)).json(read);
    })().catch(failWith(res, "GET /api/respond/:token"));
  });

  router.post("/:token/accept", (req: WithToken, res: Response) => {
    void (async () => {
      const result = await acceptAssignment(client, req.params.token);
      if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
      }
      const facts: AnswerFacts = result.facts;
      await askAfterCommit("POST /api/respond/:token/accept", () => sendSlotConfirmed(client, facts));
      res.json({ state: "accepted", jobReference: facts.jobReference, slotLabel: facts.slotLabel });
    })().catch(failWith(res, "POST /api/respond/:token/accept"));
  });

  router.post("/:token/decline", (req: WithToken, res: Response) => {
    void (async () => {
      const parsed = parseDeclineNote(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: "note" });
        return;
      }
      const result = await declineAssignment(client, req.params.token, parsed.note);
      if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
      }
      const facts: AnswerFacts = result.facts;
      await askAfterCommit("POST /api/respond/:token/decline", () => sendDeclinedNotice(client, facts));
      res.json({ state: "declined", jobReference: facts.jobReference });
    })().catch(failWith(res, "POST /api/respond/:token/decline"));
  });

  return router;
}
