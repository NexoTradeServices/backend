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
```

All three are safe to run twice: the migration is skipped once applied, and both
seeds create only what is missing. That matters -- the owner edits
PlatformSettings (feature 1006) and ServiceType rates (1007) on screen, and a
re-seed must never write placeholders back over real numbers.

`db:seed:fixtures` loads the cast from `project/design/cast.md` -- Bob Reilly
CON-014, Dave Hurst CON-021, Priya Nair CON-030 and Sarah Chen CUS-1050 -- so
test output reads like the design doc.

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
src/generated/              Prisma's output -- gitignored, never hand-edited
tests/                      Vitest suites, named by acceptance criterion
```
