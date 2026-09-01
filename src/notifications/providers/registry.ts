// The provider registry -- Feature 1004, notification module.
//
// "Providers are interchangeable - swapping one is a change inside the module
// only, never across the app." This file is where that promise is kept, and it
// answers exactly one question: for this message type on this channel, which
// adapter sends it?
//
// The answer comes from the DATABASE (PlatformSettings), and the credentials
// come from the ENVIRONMENT. That split is the design's "config, not code": the
// choice is data the owner can change on the settings screen, the secrets never
// are.
import type { PlatformSettings } from "../../generated/prisma/client.js";
import type { NotificationChannel, ProviderAdapter } from "../types.js";
import { CONSOLE_PROVIDER, consoleEmail, consoleSms } from "./console.js";
import { mailjetEmail } from "./mailjet.js";
import { clicksendSms } from "./clicksend.js";

/** Every adapter this build ships. A new provider is one file plus one line here. */
const BUILT_IN: ProviderAdapter[] = [consoleEmail, consoleSms, mailjetEmail, clicksendSms];

function key(name: string, channel: NotificationChannel): string {
  return `${name}:${channel}`;
}

const adapters = new Map<string, ProviderAdapter>();

function loadBuiltIns(): void {
  adapters.clear();
  for (const adapter of BUILT_IN) {
    adapters.set(key(adapter.name, adapter.channel), adapter);
  }
}

loadBuiltIns();

/**
 * Add or replace an adapter at runtime.
 *
 * MODULE-INTERNAL. Its real caller is the test suite: proving that changing
 * `PlatformSettings.emailProvider` re-routes the next email needs a second
 * registered adapter to route it to, and a test must never post to Mailjet.
 */
export function registerProvider(adapter: ProviderAdapter): void {
  adapters.set(key(adapter.name, adapter.channel), adapter);
}

/** Back to the shipped set. Tests call this so one file cannot leak into the next. */
export function resetProviders(): void {
  loadBuiltIns();
}

export function findProvider(
  name: string,
  channel: NotificationChannel,
): ProviderAdapter | undefined {
  return adapters.get(key(name, channel));
}

/** The console adapter for a channel -- the dev fallback, never chosen by name. */
export function consoleProviderFor(channel: NotificationChannel): ProviderAdapter {
  const adapter = adapters.get(key(CONSOLE_PROVIDER, channel));
  if (adapter === undefined) {
    throw new Error(`no console adapter registered for ${channel}`);
  }
  return adapter;
}

/**
 * The per-type exceptions, read defensively -- `providerOverrides` is a json
 * column an owner edits, so a shape that is not { type: providerName } is
 * treated as no overrides at all rather than crashing the dispatcher.
 */
export function providerOverridesOf(settings: PlatformSettings): Record<string, string> {
  const raw: unknown = settings.providerOverrides;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const overrides: Record<string, string> = {};
  for (const [type, name] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name === "string" && name !== "") overrides[type] = name;
  }
  return overrides;
}

/** The provider NAMED by config for this type + channel, before credentials matter. */
export function chosenProviderName(
  settings: PlatformSettings,
  type: string,
  channel: NotificationChannel,
): string {
  // The override is checked FIRST and falls back to the default when the type is
  // not listed. The provider named implies the channel it serves, so an email
  // provider overrides only a type's email leg -- an override naming Brevo does
  // not divert that type's SMS.
  const override = providerOverridesOf(settings)[type];
  if (override !== undefined && findProvider(override, channel) !== undefined) {
    return override;
  }
  return channel === "email" ? settings.emailProvider : settings.smsProvider;
}

export function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}

/**
 * Which adapter actually sends this message.
 *
 * Environment awareness falls out of credentials, exactly as the design frames
 * it: the chosen adapter with no credentials means dev logs the message through
 * the console adapter instead. It cannot mean that in production -- a missing
 * or broken provider is never an outage (guiding principle 8), so production
 * fails THIS ROW instead, with a plain, named reason, and never silently
 * writes a real message to a log file nobody reads.
 */
export function resolveProvider(
  settings: PlatformSettings,
  type: string,
  channel: NotificationChannel,
): ProviderAdapter {
  const name = chosenProviderName(settings, type, channel);
  const adapter = findProvider(name, channel);
  if (adapter === undefined) {
    throw new Error(`no ${channel} provider named "${name}" is registered`);
  }
  if (adapter.isConfigured()) return adapter;
  if (isProduction()) {
    throw new Error(`no configured ${channel} provider (${name})`);
  }
  return consoleProviderFor(channel);
}

/**
 * The startup check. Called before the server listens, the same way the app
 * already treats WEB_ORIGIN and DATABASE_URL -- but unlike those, a chosen
 * provider with no credentials never stops the process (Feature 1009,
 * "notifications never block boot" -- guiding principle 8: outside services
 * degrade, never block). It only names the gap; the caller logs one warning
 * per problem. Every affected send then fails on its own row, per
 * `resolveProvider` above, riding the normal retry clock until the owner
 * configures it or a human covers the message by phone.
 */
export function assertProvidersConfigured(settings: PlatformSettings): string[] {
  const problems: string[] = [];
  const named = new Set<string>([
    key(settings.emailProvider, "email"),
    key(settings.smsProvider, "sms"),
  ]);
  for (const [type, name] of Object.entries(providerOverridesOf(settings))) {
    const channels = (["email", "sms"] as const).filter(
      (channel) => findProvider(name, channel) !== undefined,
    );
    if (channels.length === 0) {
      // A typo in an override is silently harmless at send time -- the type just
      // rides the default -- which is precisely why boot has to say it out loud.
      problems.push(`providerOverrides names "${name}" for "${type}", and no such provider is registered`);
      continue;
    }
    for (const channel of channels) named.add(key(name, channel));
  }

  for (const entry of named) {
    const [name, channel] = entry.split(":") as [string, NotificationChannel];
    const adapter = findProvider(name, channel);
    if (adapter === undefined) {
      problems.push(`no ${channel} provider named "${name}" is registered`);
      continue;
    }
    if (!adapter.isConfigured()) {
      problems.push(`${channel} provider "${name}" has no credentials`);
    }
  }

  return problems;
}
