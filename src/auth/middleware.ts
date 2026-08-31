// Session + RBAC middleware -- Feature 1003, auth + roles.
//
// One middleware loads the session and (for a contractor) re-checks
// Contractor.status live, every request -- that live check IS the revocation
// teeth sessions buy over a stateless token (design: Authentication &
// Security). A suspended contractor's session is left unattached here, which
// reads downstream exactly like "not logged in" (AC8) -- the design asks for
// immediate refusal, not a dedicated error shape, and 1003 ships no
// suspend/deactivate UI (that is 2001's job).
import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Auth } from "./config.js";
import type { PrismaClient } from "../db/client.js";
import { Role } from "../generated/prisma/enums.js";

export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  email: string;
}

declare module "express-serve-static-core" {
  interface Request {
    authUser?: AuthUser;
  }
}

/** Loads `req.authUser` from the session cookie, if any. Mount once, globally. */
export function attachSession(auth: Auth, client: PrismaClient) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) {
        next();
        return;
      }
      const role = session.user.role as Role;
      if (role === Role.contractor) {
        const contractor = await client.contractor.findUnique({
          where: { userId: session.user.id },
          select: { status: true },
        });
        if (!contractor || contractor.status === "suspended") {
          // Left unattached on purpose -- see the file header.
          next();
          return;
        }
      }
      req.authUser = {
        id: session.user.id,
        role,
        name: session.user.name,
        email: session.user.email,
      };
      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: "not authenticated" });
    return;
  }
  next();
}

/**
 * `requireRole("ops")` admits the owner too (decision 4: the owner sees
 * everything ops sees). Every other role check is exact.
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    const admitted =
      roles.includes(req.authUser.role) ||
      (roles.includes(Role.ops) && req.authUser.role === Role.owner);
    if (!admitted) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}
