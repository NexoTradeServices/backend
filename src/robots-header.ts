// Feature 8002 -- the API is never a page for search.
//
// Every backend response, errors included, says noindex, whatever the
// approved-public-domain setting holds (Growth / SEO; ADR 0005).
import type { NextFunction, Request, Response } from "express";

export function robotsHeader(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
}
