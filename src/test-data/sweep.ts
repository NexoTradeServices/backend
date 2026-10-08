// The test-data sweep -- Feature 9002.
//
// Design: Data Model, Test data. Given a label, removes every row carrying it
// AND every row that points at one of those rows, further down the chain,
// children first -- so a row a test made but the labelling missed is still
// cleared with its parent. Nothing else is touched: the seeded cast carries no
// label and nothing points at it from a labelled row in the wrong direction
// (a labelled job points AT a cast customer; the customer is never a child).
//
// The foreign keys are read from the database itself, so a table added by a
// later feature is swept without anyone remembering to list it.
//
// Refuses unless the connected database's name ends in `_dev` or `_test`, and
// refuses with NODE_ENV=production.
import type { PrismaClient } from "../db/client.js";
import { isProduction, isValidLabel } from "./label.js";

interface ForeignKey {
  child: string;
  childColumn: string;
  parent: string;
  parentColumn: string;
}

export interface SweepResult {
  label: string;
  /** Rows removed, per table. Tables that lost nothing are left out. */
  removed: Record<string, number>;
  total: number;
}

const ALLOWED_DATABASE = /_(dev|test)$/;

async function readForeignKeys(client: PrismaClient): Promise<ForeignKey[]> {
  const rows = await client.$queryRaw<
    { child: string; child_column: string; parent: string; parent_column: string; width: number }[]
  >`
    SELECT c.relname AS child, ca.attname AS child_column,
           p.relname AS parent, pa.attname AS parent_column,
           array_length(con.conkey, 1) AS width
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_class p ON p.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute ca ON ca.attrelid = c.oid AND ca.attnum = con.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = p.oid AND pa.attnum = con.confkey[1]
     WHERE con.contype = 'f'
  `;
  if (rows.some((row) => row.width !== 1)) {
    throw new Error("the sweep does not handle a foreign key over more than one column");
  }
  return rows.map((row) => ({
    child: row.child,
    childColumn: row.child_column,
    parent: row.parent,
    parentColumn: row.parent_column,
  }));
}

async function labelledTables(client: PrismaClient): Promise<string[]> {
  const rows = await client.$queryRaw<{ table_name: string }[]>`
    SELECT table_name
      FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'testData'
     ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
}

/** Table and column names come from the catalog, never from a caller; quoted all the same. */
function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function sweepTestData(client: PrismaClient, label: string): Promise<SweepResult> {
  if (isProduction()) {
    throw new Error("refusing to sweep test data with NODE_ENV=production");
  }
  if (!isValidLabel(label)) {
    throw new Error(`"${String(label)}" is not a valid test-data label`);
  }
  const [database] = await client.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (database === undefined || !ALLOWED_DATABASE.test(database.name)) {
    throw new Error(
      `refusing to sweep database "${database?.name ?? "unknown"}" -- its name must end in _dev or _test`,
    );
  }

  const tables = await labelledTables(client);
  const keys = (await readForeignKeys(client)).filter(
    (key) => tables.includes(key.child) && tables.includes(key.parent),
  );

  return client.$transaction(
    async (tx) => {
      // 1. The marked rows: those carrying the label, then everything that
      //    points at a marked row, until nothing new turns up.
      const marked = new Map<string, Set<string>>();
      for (const table of tables) {
        const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM ${q(table)} WHERE "testData" = $1`,
          label,
        );
        if (rows.length > 0) marked.set(table, new Set(rows.map((row) => row.id)));
      }

      for (let grew = true; grew; ) {
        grew = false;
        for (const key of keys) {
          const parents = marked.get(key.parent);
          if (parents === undefined || parents.size === 0) continue;
          const children = await tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM ${q(key.child)}
              WHERE ${q(key.childColumn)} IN (
                SELECT ${q(key.parentColumn)} FROM ${q(key.parent)} WHERE id = ANY($1::text[])
              )`,
            [...parents],
          );
          const known = marked.get(key.child) ?? new Set<string>();
          for (const row of children) {
            if (!known.has(row.id)) {
              known.add(row.id);
              grew = true;
            }
          }
          if (known.size > 0) marked.set(key.child, known);
        }
      }

      // 2. Delete children first: a table goes once no other table with marked
      //    rows still points at it. A table that points at itself goes in
      //    passes, leaves first.
      const removed: Record<string, number> = {};
      const waiting = new Set(marked.keys());
      // Feature 6001: Assignment.invoiceId and Invoice.assignmentId point at each
      // other (the design keeps both). A loop is broken at a nullable column: the
      // marked rows' pointer is cleared, and that key stops holding its parent back.
      const cleared = new Set<ForeignKey>();
      const holdsBack = (key: ForeignKey, table: string): boolean =>
        key.parent === table && key.child !== table && waiting.has(key.child) && !cleared.has(key);
      while (waiting.size > 0) {
        const ready = [...waiting].filter((table) => !keys.some((key) => holdsBack(key, table)));
        if (ready.length === 0) {
          let broke = false;
          for (const key of keys) {
            if (!waiting.has(key.child) || !waiting.has(key.parent) || key.child === key.parent || cleared.has(key)) continue;
            const [column] = await tx.$queryRaw<{ is_nullable: string }[]>`
              SELECT is_nullable FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = ${key.child} AND column_name = ${key.childColumn}
            `;
            if (column?.is_nullable !== "YES") continue;
            await tx.$executeRawUnsafe(
              `UPDATE ${q(key.child)} SET ${q(key.childColumn)} = NULL WHERE id = ANY($1::text[])`,
              [...(marked.get(key.child) ?? [])],
            );
            cleared.add(key);
            broke = true;
            break;
          }
          if (!broke) {
            throw new Error(`the sweep found a loop between tables: ${[...waiting].join(", ")}`);
          }
          continue;
        }
        for (const table of ready) {
          const ids = [...(marked.get(table) ?? [])];
          const selfKeys = keys.filter((key) => key.child === table && key.parent === table);
          let left = ids;
          let count = 0;
          while (left.length > 0) {
            const notPointedAt = selfKeys
              .map(
                (key) =>
                  ` AND NOT EXISTS (SELECT 1 FROM ${q(table)} x
                      WHERE x.${q(key.childColumn)} = ${q(table)}.${q(key.parentColumn)}
                        AND x.id = ANY($1::text[]) AND x.id <> ${q(table)}.id)`,
              )
              .join("");
            const deleted = await tx.$queryRawUnsafe<{ id: string }[]>(
              `DELETE FROM ${q(table)} WHERE id = ANY($1::text[])${notPointedAt} RETURNING id`,
              left,
            );
            if (deleted.length === 0) {
              throw new Error(`the sweep could not remove rows of ${table}`);
            }
            count += deleted.length;
            const gone = new Set(deleted.map((row) => row.id));
            left = left.filter((id) => !gone.has(id));
          }
          if (count > 0) removed[table] = count;
          waiting.delete(table);
        }
      }

      const total = Object.values(removed).reduce((sum, n) => sum + n, 0);
      return { label, removed, total };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}
