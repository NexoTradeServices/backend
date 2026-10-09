// /api/approve -- Feature 6003, settlement run. The contractor's approve link.
//
// Identity & Access / Passwordless capability links (the `/approve/<token>` row). NO session:
// the token in the path is the permission (ADR 0004).
//
//   GET  /api/approve/:token   200 with the invoice and the pay day, or the reason it is dead:
//                              replaced (410), approved (410), unknown (404) -- each with the office phone
//   POST /api/approve/:token   approve it, or 409 gst_not_recorded
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { approveByToken, readApprove, statusOfApproveDead } from "../settlements/service.js";

type WithToken = Request<{ token: string }>;

function failWith(res: Response, route: string) {
  return (error: unknown) => {
    console.error(`${route} failed`, error);
    res.status(500).json({ error: "internal error" });
  };
}

export function approveRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/:token", (req: WithToken, res: Response) => {
    void (async () => {
      const read = await readApprove(client, req.params.token, new Date());
      res.status(read.state === "open" ? 200 : statusOfApproveDead(read)).json(read);
    })().catch(failWith(res, "GET /api/approve/:token"));
  });

  router.post("/:token", (req: WithToken, res: Response) => {
    void (async () => {
      const result = await approveByToken(client, req.params.token, new Date());
      if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
      }
      res.json({ state: "approved", reference: result.reference, payDay: result.payDay });
    })().catch(failWith(res, "POST /api/approve/:token"));
  });

  return router;
}
