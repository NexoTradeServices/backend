// The test-data label held for the rest of a request -- Feature 9002.
//
// Design: Data Model, Test data. A browser test's requests carry the cookie
// `ts-test-run`, whose value is the label (`e2e`). The middleware below holds
// that label for the rest of the request; the Prisma client extension
// (labelling.ts) stamps it on every row created meanwhile. A UAT data script
// does the same through runWithLabel().
//
// The production server never labels: with NODE_ENV=production the cookie is
// ignored outright, and so is a label handed to runWithLabel's callers via
// currentLabel().
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

export const TEST_RUN_COOKIE = "ts-test-run";

/**
 * The label the browser tests carry. A message tied to a row with this label is
 * automated-test traffic: it is shown in the console and never handed to a real
 * email or text provider (notifications/dispatcher.ts). UAT labels (`uat-<id>`)
 * are deliberately NOT included -- the owner's hand check sends real mail.
 */
export const BROWSER_TEST_LABEL = "e2e";

/** A label is a short lowercase word with dashes: `e2e`, `uat-9002`. */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const held = new AsyncLocalStorage<string>();

export function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}

/** True for a stored label that marks automated browser-test traffic -- never in production. */
export function isBrowserTestLabel(label: string | null): boolean {
  return !isProduction() && label === BROWSER_TEST_LABEL;
}

export function isValidLabel(label: unknown): label is string {
  return typeof label === "string" && LABEL_PATTERN.test(label);
}

/** The label rows created right now must carry, or null for a real record. */
export function currentLabel(): string | null {
  if (isProduction()) return null;
  return held.getStore() ?? null;
}

/** True when the current request carries the test-run signal (never in production). */
export function isTestRun(): boolean {
  return currentLabel() !== null;
}

/**
 * Run `fn` with every row it creates labelled `label`. Refuses production
 * (throws at once, not as a rejection). Prisma queries only run when awaited,
 * so `fn`'s result is awaited INSIDE the label, not handed back to be awaited
 * outside it.
 */
export function runWithLabel<T>(label: string, fn: () => T | PromiseLike<T>): Promise<T> {
  if (isProduction()) {
    throw new Error("refusing to label records with NODE_ENV=production");
  }
  if (!isValidLabel(label)) {
    throw new Error(`"${String(label)}" is not a valid test-data label`);
  }
  return held.run(label, async () => await fn());
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Reads the test-run cookie and holds its label for the rest of the request.
 * Mounted once, first. A request without the cookie, or any request at all
 * in production, passes straight through unlabelled.
 */
export function testRunSignal(req: Request, _res: Response, next: NextFunction): void {
  if (isProduction()) {
    next();
    return;
  }
  const label = readCookie(req.headers.cookie, TEST_RUN_COOKIE);
  if (label === null || !isValidLabel(label)) {
    next();
    return;
  }
  held.run(label, next);
}
