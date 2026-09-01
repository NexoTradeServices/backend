// /api/me and the reset-link helper -- Feature 1003, auth + roles.
//
// Everything that actually authenticates lives at Better Auth's own
// /api/auth/* (decision 1 -- one auth brain). These two routes are read-only
// helpers the frontend needs and Better Auth does not provide:
//   - GET /api/me: what the gates and placeholders read (plan, Backend tasks).
//   - GET /api/reset-link: resolves a reset token to the email it belongs to,
//     so the set-new-password card can say "For mike@idelta.com.au" per the
//     frozen Portal Login Gate style reference -- without this, Better Auth's
//     own POST /reset-password never returns the email either.
// Read-only, no email code, no session logic of its own -- it looks up the
// same Verification row Better Auth's own GET /api/auth/reset-password/:token
// already validated non-destructively (identifier `reset-password:<token>`,
// value = the userId -- better-auth/src/api/routes/password.ts).
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireAuth } from "./middleware.js";

export function authRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/me", requireAuth, (req: Request, res: Response) => {
    const user = req.authUser;
    if (!user) {
      // requireAuth already refused; unreachable, kept for the type narrow.
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  });

  router.get("/reset-link", (req: Request, res: Response) => {
    void (async () => {
      const token = typeof req.query["token"] === "string" ? req.query["token"] : undefined;
      if (!token) {
        res.status(400).json({ error: "token is required" });
        return;
      }
      const verification = await client.verification.findFirst({
        where: { identifier: `reset-password:${token}` },
      });
      if (!verification || verification.expiresAt < new Date()) {
        res.status(404).json({ error: "invalid or expired token" });
        return;
      }
      const user = await client.user.findUnique({ where: { id: verification.value } });
      if (!user) {
        res.status(404).json({ error: "invalid or expired token" });
        return;
      }
      res.json({ email: user.email });
    })().catch((error: unknown) => {
      console.error("GET /api/reset-link failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
