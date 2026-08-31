# backend

Express + Prisma + PostgreSQL/PostGIS API for the trades platform.
Node 22 (see `.nvmrc`), TypeScript, ESM.

The database it builds is the design doc's Data Model
(`project/design/trades-platform-design.md`) -- that document is the source of
truth, not this schema.

## Setup

Copy `.env.example` to `.env` and fill in the password. Locally there are two
databases, both created by `project/setup/01-dev-environment.md` with PostGIS
already switched on by a superuser (the `tradeservice` role is deliberately not a
superuser and cannot install it itself):

| Variable | Database | For |
|---|---|---|
| `DATABASE_URL` | `tradeservice_dev` | the running app |
| `DIRECT_URL` | -- | the Prisma CLI. Leave it UNSET locally; read this before Neon |
| `TEST_DATABASE_URL` | `tradeservice_test` | the tests, wiped at the start of every run |

```bash
npm install
npm run db:generate     # writes the Prisma client into src/generated (gitignored)
```

### `DIRECT_URL` -- read this before the first Neon migration

Neon hands out two connection strings and setup/03 keeps them apart on purpose:
the pooled one (its host contains `-pooler`) for traffic, the direct one for
changing the shape of the database. `prisma.config.ts` takes
`DIRECT_URL ?? DATABASE_URL`, so:

- **On .40, leave `DIRECT_URL` unset.** There is one unpooled Postgres and the
  fallback is the normal path. Nothing to do.
- **Against Neon, set both.** `DATABASE_URL` = pooled, `DIRECT_URL` = direct.
  `migrate deploy` takes a Postgres advisory lock and holds it across
  statements; a transaction pooler is free to hand the next statement to a
  different backend, which loses the lock.

The fallback is what makes this worth a heading: forget `DIRECT_URL` and nothing
warns you, because it works locally. On Neon the failure comes later and looks
like a migration that hangs or half-applies.

## Database

```bash
npm run db:migrate         # prisma migrate deploy -- apply migrations
npm run db:seed            # base seed: PlatformSettings + ServiceTypes
npm run db:seed:fixtures   # the cast (dev/test only; refuses NODE_ENV=production)
npm run db:seed:suburbs    # the suburb reference table (one-off, ~15,600 rows)
```

All four are safe to run twice: the migration is skipped once applied, and every
seed creates only what is missing. That matters -- the owner edits
PlatformSettings (feature 1006) and ServiceType rates (1007) on screen, and a
re-seed must never write placeholders back over real numbers.

`db:seed:fixtures` loads the cast from `project/design/cast.md` -- Bob Reilly
CON-014, Dave Hurst CON-021, Priya Nair CON-030 and Sarah Chen CUS-1050 -- so
test output reads like the design doc.

### `db:seed:suburbs` -- the suburb reference table

The radius slider (feature 2002) and the per-suburb SEO pages (8001) both ask
our own `Suburb` table "which suburbs are near this pin?" -- Google has no call
that answers it. `db:seed:suburbs` loads that table from
`data/geocoded_postcode_file_pc004_29082026.csv`: 16,638 rows in, 15,608 out
(1,715 of them WA), one row per suburb-postcode-state triple, each carrying its
own centroid. The 1,030 rows dropped are PO boxes, LVRs and mail facilities --
they arrive with no coordinates, which is the whole filter.

**The data file is licensed.** It is the Australia Post Geocoded Postcode File
(National), bought 29/08/26 on a twelve-month term (see
`project/decisions/0003-location-data-sources.md`). It stays inside this repo and
this product: never copied into fixtures, gists or issues, never hand-edited, and
never re-saved from Excel -- postcodes are text, and Excel eats the leading zero
in `0810` and `0200`. Renewal is a diary item; if the term ends the file is
deleted, not retained.

It is a **separate command from `db:seed`** on purpose: 15,608 rows is a one-off
load, not something every test run and every deploy should repeat.

**In tests, the rows are loaded by `tests/suburbs.test.ts` and by nothing else.**
Not by `tests/global-setup.ts`, and not by any other suite. Keep it that way: the
moment the reference data moves into the global setup, every suite in the repo
pays for 15,608 rows on every run, to prove things that have nothing to do with
suburbs. A suite that needs them calls `seedSuburbs(db)` itself.

**The category column is not the filter.** Three rows carry a mail category and
real coordinates -- Singleton Military Area 2331, and Home Island and West Island
6799, the only two rows for that postcode. All three are real inhabited places,
so filtering on category would delete postcode 6799 from the country. The seed
logs them instead, and a test pins exactly those three: a re-import bringing a
fourth fails that test on purpose. See `project/decisions/0003-location-data-sources.md`.

**Production is a one-time manual run.** The owner runs it once against Neon with
the production connection string:

```bash
DATABASE_URL='<neon pooled url>' npm run db:seed:suburbs
```

`release_command` in `fly.toml` stays migrations-only -- wiring the seed into
deploys would be a `project/setup/` change, not a feature's. A re-import (ADR
0003 says annually at most) is the same command again: it creates what is
missing and never rewrites an existing row, so a live SEO page URL can never be
moved by one.

### Migrations

Authored with `prisma migrate diff`, applied with `prisma migrate deploy`. Never
`prisma migrate dev`: the `tradeservice` role is deliberately not a superuser and
cannot create the shadow database that command needs (setup/01 made it that way
so a migration cannot pass in dev and then fail on Neon).

To add one after changing `prisma/schema.prisma`, diff the live database against
the schema and save the result as the next migration:

```bash
mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_<name>
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --script > prisma/migrations/<the directory you just made>/migration.sql
npm run db:migrate
```

`--from-config-datasource` reads the database named by `DATABASE_URL`, so it needs
no shadow database. (`--from-migrations` would, and fails here for the same
reason `migrate dev` does.) Run the same command with nothing pending to check for
drift: `-- This is an empty migration.` means the database and the schema agree.

Never edit a migration that has already been applied anywhere -- Prisma checksums
them, and a changed file makes `migrate deploy` refuse.

### References and codes

Six independent Postgres sequences issue the human-readable identifiers --
`JOB-`, `INV-`, `CINV-`, `CN-`, `CUS-`, `CON-`. Prefixes, start numbers and
padding are configured in `src/config/references.ts`; `nextReference()` in
`src/db/reference.ts` issues them. The starts sit past the cast's numbers so a
generated code can never collide with a seeded fixture.

## Tests

```bash
npm test          # vitest run
npm run test:watch
```

Vitest + Supertest against `tradeservice_test` (ADR 0001). The run wipes that
database and rebuilds it from the migrations, so every run starts clean; a guard
refuses any `TEST_DATABASE_URL` whose database name does not end in `_test`.
Tests run one file at a time -- they migrate, truncate and reset sequences, so
they cannot run beside each other.

Test names start with the acceptance criterion they prove (`AC1:`, `AC2:` ...)
and each file's first line names the plan it answers to.

## Notifications

Every message the platform sends -- email or SMS, customer, contractor or ops --
goes through one module at `src/notifications/`, and `src/notifications/index.ts`
is its only public face. A feature that needs to reach someone imports from
there and from nowhere deeper:

```ts
import { sendNotification } from '../notifications/index.js'

await sendNotification({
  type: 'password_reset',
  channel: 'email',
  recipientType: 'customer',
  recipientId: sarah.id,
  idempotencyKey: `password_reset:customer:${sarah.id}:${issuedAt}`,
  context: { name: sarah.name, resetUrl },
})
```

That call writes a `Notification` row at `queued` and returns. Nothing else is a
feature's business -- rendering, provider choice, retries, suppression and the
delivery log all happen behind that line. No feature anywhere else contains
email or SMS logic (ADR 0002).

**Templates are code.** One file per type + channel in
`src/notifications/templates/`, listed in that directory's `registry.ts`. This
build ships one -- the password reset; every other message's wording arrives
with the feature that sends it.

**The idempotency key is the caller's, and its shape is fixed:**
`<type>:<relatedType>:<relatedId>`, plus a discriminator where one record can
legitimately send the same message twice (the "on my way" tap keys per calendar
block). The unique constraint on the column is the guard, so the key has to be
derivable without reading the table first. Ask twice with the same key and the
second call gets the row that already exists.

**The queue is the `Notification` table.** A loop inside this process claims
rows with `SELECT ... FOR UPDATE SKIP LOCKED` and sends them, so two machines
can never send one row twice. Three attempts, then the row is `failed` with the
provider's error on it.

**Do not size a sweep off the retry spacing.** While the queue is kept up with,
the attempts fall 1 then 5 minutes apart. They do NOT once it is not: the backoff
is measured from `createdAt`, so a row that waited out an outage is already past
every step when it is picked up, and its attempts land as fast as passes come
round. A single pass can only ever spend one attempt on a row, so the floor is
the poll interval, not zero. Closing the gap properly needs a retry clock on
`Notification` -- parked as Q2 on feature 1004 for the architect.

### Dev without any provider accounts

Which provider sends what is DATA -- `PlatformSettings.emailProvider`,
`.smsProvider`, and `.providerOverrides` for per-type exceptions. The
credentials are environment variables (see `.env.example`).

Leave those variables empty and the module uses the console adapter: it renders
the message, logs it, and marks the row `sent`. The whole flow is provable on a
laptop with no Mailjet account and no ClickSend account. **In production the
same missing credential refuses the boot**, the way `WEB_ORIGIN` and
`DATABASE_URL` already do -- a real invoice email must never be quietly written
to a log nobody reads.

### Changing provider

Edit the settings row; there is no deploy in it.

- `emailProvider` / `smsProvider` -- the default for every message.
- `providerOverrides` -- the exceptions, BY NOTIFICATION TYPE:
  `{ "password_reset": "brevo" }`. The registry checks it first and falls back
  to the default. That is how a cutover happens here: one message type at a
  time, watched in the delivery log, rolled back by deleting one line.

The provider named implies the channel it serves, so an email provider
overrides only a type's email leg.

### Delivery webhooks

`POST /webhooks/mailjet` and `POST /webhooks/clicksend` normalise provider
delivery events into `Notification.status`. An event for a message id we do not
hold is ignored with a 200 -- providers retry anything that is not a 2xx, and a
public endpoint sees noise as often as bugs. Turning a hard bounce into a
`Suppression` row and an ops alert is feature 7001; this build sets the status
and stops there.

## Checks

```bash
npm run typecheck   # tsc over src, tests and the root config files
npm run lint        # eslint, type-aware
npm run build       # tsc -> dist
```

## Layout

```
prisma/schema.prisma        the Data Model as tables
prisma/migrations/          applied with migrate deploy
prisma.config.ts            Prisma 7 config; holds the datasource URL
src/config/references.ts    the six reference/code sequences
src/db/client.ts            the Prisma client (built on first use)
src/db/reference.ts         nextReference() and friends
src/db/seed/base.ts         PlatformSettings + ServiceTypes
src/db/seed/fixtures.ts     the cast
src/db/seed/suburbs.ts      the suburb reference table
src/notifications/          the notification module -- index.ts is its only public face
src/notifications/channels/    one component per channel: email, sms
src/notifications/templates/   templates as code, one per type + channel
src/notifications/providers/   the registry and its adapters: mailjet, clicksend, console
data/                       the licensed Australia Post postcode file
src/generated/              Prisma's output -- gitignored, never hand-edited
tests/                      Vitest suites, named by acceptance criterion
```
