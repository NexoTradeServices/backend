// The labelling Prisma client extension -- Feature 9002.
//
// Done once, at the client, so no route has to remember: while a request
// holds a label (label.ts), every row created through the shared client
// carries it -- `create`, `createMany`, `createManyAndReturn`, the create half
// of `upsert` and `connectOrCreate`, and creates nested inside any of those
// (and inside an `update`). Better Auth goes through the same client, so the
// user, account and session a test's sign-in creates are labelled too.
import { Prisma } from "../generated/prisma/client.js";
import { currentLabel } from "./label.js";

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Stamp one row's data, then reach into its nested writes. */
function stampRow(row: unknown, label: string): void {
  if (!isPlain(row)) return;
  if (row["testData"] === undefined) row["testData"] = label;
  stampNested(row, label);
}

/** Find the nested writes under one data object and stamp the creating ones. */
function stampNested(data: Plain, label: string): void {
  for (const value of Object.values(data)) {
    if (!isPlain(value)) continue;
    if ("create" in value) asList(value["create"]).forEach((row) => stampRow(row, label));
    if ("createMany" in value && isPlain(value["createMany"])) {
      asList(value["createMany"]["data"]).forEach((row) => stampRow(row, label));
    }
    if ("connectOrCreate" in value) {
      asList(value["connectOrCreate"]).forEach((entry) => {
        if (isPlain(entry)) stampRow(entry["create"], label);
      });
    }
    // A nested upsert has a create half and an update half; the update half
    // can itself nest creates.
    if ("upsert" in value) {
      asList(value["upsert"]).forEach((entry) => {
        if (!isPlain(entry)) return;
        stampRow(entry["create"], label);
        if (isPlain(entry["update"])) stampNested(entry["update"], label);
      });
    }
    if ("update" in value) {
      asList(value["update"]).forEach((entry) => {
        if (!isPlain(entry)) return;
        // `update: { where, data }` or `update: { ...fields }`
        stampNested(isPlain(entry["data"]) ? entry["data"] : entry, label);
      });
    }
    if ("updateMany" in value) {
      asList(value["updateMany"]).forEach((entry) => {
        if (isPlain(entry) && isPlain(entry["data"])) stampNested(entry["data"], label);
      });
    }
  }
}

interface QueryArgs {
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

/** Runs `stamp` over the args when a label is held; passes the call on either way. */
function labelled(stamp: (args: Plain, label: string) => void) {
  return ({ args, query }: QueryArgs): Promise<unknown> => {
    const label = currentLabel();
    if (label !== null && isPlain(args)) stamp(args, label);
    return query(args);
  };
}

export const labellingExtension = Prisma.defineExtension({
  name: "test-data-labelling",
  query: {
    $allModels: {
      create: labelled((args, label) => stampRow(args["data"], label)),
      createMany: labelled((args, label) => asList(args["data"]).forEach((row) => stampRow(row, label))),
      createManyAndReturn: labelled((args, label) =>
        asList(args["data"]).forEach((row) => stampRow(row, label)),
      ),
      upsert: labelled((args, label) => {
        stampRow(args["create"], label);
        if (isPlain(args["update"])) stampNested(args["update"], label);
      }),
      update: labelled((args, label) => {
        if (isPlain(args["data"])) stampNested(args["data"], label);
      }),
      updateMany: labelled((args, label) => {
        if (isPlain(args["data"])) stampNested(args["data"], label);
      }),
    },
  },
});
