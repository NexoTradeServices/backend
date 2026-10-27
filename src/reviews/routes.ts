// /api/review -- Feature 6009, ratings and reviews. The customer's review link.
//
// Identity & Access / Passwordless capability links (the `/review/<token>` row). NO session: the
// token in the path is the permission (ADR 0004).
//
//   GET  /api/review/:token   200 with the page's facts, or the reason it is dead: used / expired (410), unknown (404)
//   POST /api/review/:token   { rating 1-5, reviewText?, recommendScore? 0-10 } -> save, or 400 "Choose a star."
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { parseReviewInput, readReview, statusOfRead, submitReview } from "./service.js";

type WithToken = Request<{ token: string }>;

function failWith(res: Response, route: string) {
  return (error: unknown) => {
    console.error(`${route} failed`, error);
    res.status(500).json({ error: "internal error" });
  };
}

export function reviewRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/:token", (req: WithToken, res: Response) => {
    void (async () => {
      const read = await readReview(client, req.params.token, new Date());
      res.status(statusOfRead(read)).json(read);
    })().catch(failWith(res, "GET /api/review/:token"));
  });

  router.post("/:token", (req: WithToken, res: Response) => {
    void (async () => {
      const parsed = parseReviewInput(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const result = await submitReview(client, req.params.token, parsed.input, new Date());
      if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
      }
      res.json({ state: "saved" });
    })().catch(failWith(res, "POST /api/review/:token"));
  });

  return router;
}
