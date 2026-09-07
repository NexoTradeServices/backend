// Deactivated-login reason -- Feature 2001, contractor onboarding (Mike's
// path), plan decision 9.
//
// Authentication & Security: "A deactivated contractor who logs in with the
// RIGHT password is told why ... shown only after a correct password, so
// the message can never be used to probe which emails hold accounts; a
// wrong password gets the generic failed-login banner like anyone else."
// Feature 1003's session middleware already leaves a suspended contractor's
// session unattached (attachSession, middleware.ts) -- that is the
// revocation teeth. What was missing is the REASON the login endpoint
// itself returns, so the gate can render it instead of the generic banner.
//
// This mounts BEFORE the Better Auth catch-all (`/api/auth/*splat` in
// index.ts) and intercepts exactly one path: POST /api/auth/sign-in/email.
// Every other Better Auth route is untouched. The sign-in itself runs
// through `auth.handler` -- the SAME function `toNodeHandler` wraps -- so
// every existing behaviour (per-IP rate limiting, feature 1013; the generic
// wrong-password/unknown-email banner) is preserved exactly. Only the
// RESPONSE is inspected before it reaches the client:
//   - sign-in failed (bad credentials) -> relayed untouched.
//   - sign-in succeeded, active contractor or any other role -> relayed
//     untouched, cookie included.
//   - sign-in succeeded, SUSPENDED contractor -> the session Better Auth
//     just created is deleted, and the client gets a 403 with a distinct
//     `code` and the operatorPhone message instead of a session cookie.
//
// `getRequest`/`setResponse` come from `better-call/node` (a transitive
// dependency of better-auth, pinned here as a direct one -- package.json --
// at the exact version better-auth 1.6.30 already resolves): it is the same
// Node-request/Response bridge `better-auth/node`'s own `toNodeHandler`
// uses internally, so this reuses Better Auth's own plumbing rather than
// hand-rolling header/cookie/body-stream handling again.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import { getRequest, setResponse } from "better-call/node";
import type { Auth } from "./config.js";
import type { PrismaClient } from "../db/client.js";

interface SignInEmailBody {
  token?: string;
  user?: { id: string; role: string };
}

function requestBase(req: Request): string {
  const encrypted = "encrypted" in req.socket && req.socket.encrypted === true;
  const proto = req.headers["x-forwarded-proto"] ?? (encrypted ? "https" : "http");
  const host = req.headers["host"];
  return `${String(proto)}://${String(host)}`;
}

export function contractorLoginRoutes(auth: Auth, client: PrismaClient): Router {
  const router = createRouter();

  router.post("/sign-in/email", (req: Request, res: Response) => {
    void (async () => {
      const webRequest = getRequest({ base: requestBase(req), request: req });
      const authResponse = await auth.handler(webRequest);

      if (authResponse.ok) {
        const payload = (await authResponse.clone().json()) as SignInEmailBody;
        if (payload.user?.role === "contractor") {
          const contractor = await client.contractor.findUnique({
            where: { userId: payload.user.id },
            select: { status: true },
          });
          if (contractor?.status === "suspended") {
            if (payload.token) {
              await client.session.deleteMany({ where: { token: payload.token } });
            }
            const settings = await client.platformSettings.findFirstOrThrow({
              select: { operatorPhone: true },
            });
            res.status(403).json({
              code: "ACCOUNT_NOT_ACTIVE",
              message: `Your account is not active. Call us on ${settings.operatorPhone}.`,
            });
            return;
          }
        }
      }

      await setResponse(res, authResponse);
    })().catch((error: unknown) => {
      console.error("POST /api/auth/sign-in/email failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
