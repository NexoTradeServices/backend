// Feature 1002, suburb reference seed
//
// AC1   the file loads, and a second run changes nothing
// AC2   the cast's suburbs are present, carrying the file's own coordinates
// AC3   names are stored in display case
// AC4   slugs are qualified and unique
// AC5   non-places are excluded; every row has a real centroid
// AC6   coordinates are per suburb, not per postcode
// AC7   the rows answer the radius question the slider will ask
// AC8   a postcode covering several suburbs comes back as one group
// AC9   a hand-edited row survives a re-run
// AC10  the dedupe guard fires on a duplicate triple
// AC11  border towns survive
// AC12  every kept row with a non-"Delivery Area" category is logged and pinned
//
// The 15,608 rows are loaded HERE, by the file that needs them -- not by the
// global harness. No other suite should pay for them.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import {
  displayCase,
  parseCsv,
  readSuburbFile,
  seedSuburbs,
  suburbSlug,
  SUBURB_DATA_FILE,
} from "../src/db/seed/suburbs.js";
import type { SeedSuburbsResult } from "../src/db/seed/suburbs.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let firstRun: SeedSuburbsResult;

/** The file's own numbers, verified against it on 29/08/26. */
const ROWS_IN_FILE = 16_638;
const ROWS_WITH_COORDINATES = 15_608;
const WA_ROWS = 1_715;

/** Bob Reilly's core location -- cast.md, Fremantle. */
const BOB_CORE = { lat: -32.0569, lng: 115.7439 };

beforeAll(async () => {
  db = testClient();
  await truncateAll(db);
  firstRun = await seedSuburbs(db);
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

describe("AC1 -- the file loads, and a second run changes nothing", () => {
  test("AC1: the row count equals the rows carrying coordinates, 1,715 of them WA", async () => {
    expect(firstRun.rowsRead).toBe(ROWS_IN_FILE);
    expect(firstRun.inserted).toBe(ROWS_WITH_COORDINATES);
    expect(await db.suburb.count()).toBe(ROWS_WITH_COORDINATES);
    expect(await db.suburb.count({ where: { state: "WA" } })).toBe(WA_ROWS);
  });

  test("AC1: a second run inserts nothing, updates nothing, and leaves the count identical", async () => {
    // Every column of every row, fingerprinted before and after.
    const before = await db.$queryRaw<{ fingerprint: string }[]>`
      SELECT md5(string_agg(row, '|' ORDER BY row)) AS fingerprint
        FROM (SELECT name || slug || postcode || state || "centroidLat" || "centroidLng" AS row
                FROM "Suburb") AS rows
    `;

    const second = await seedSuburbs(db);

    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(ROWS_WITH_COORDINATES);
    expect(await db.suburb.count()).toBe(ROWS_WITH_COORDINATES);

    const after = await db.$queryRaw<{ fingerprint: string }[]>`
      SELECT md5(string_agg(row, '|' ORDER BY row)) AS fingerprint
        FROM (SELECT name || slug || postcode || state || "centroidLat" || "centroidLng" AS row
                FROM "Suburb") AS rows
    `;
    expect(after[0]?.fingerprint).toBe(before[0]?.fingerprint);
  }, 120_000);
});

describe("AC2 -- the suburbs the cast lives and works in", () => {
  // Bob Reilly's core location is Fremantle; Sarah Chen's leaking mixer tap is
  // in Hilton 6163 (cast.md). Coordinates are the file's own, to six places.
  const CAST_SUBURBS = [
    { name: "Fremantle", postcode: "6160", lat: -32.052563, lng: 115.760941 },
    { name: "Hilton", postcode: "6163", lat: -32.067081, lng: 115.786454 },
    { name: "Spearwood", postcode: "6163", lat: -32.106929, lng: 115.781318 },
    { name: "Subiaco", postcode: "6008", lat: -31.948634, lng: 115.827112 },
    { name: "Innaloo", postcode: "6018", lat: -31.892743, lng: 115.796948 },
  ];

  test.each(CAST_SUBURBS)("AC2: $name $postcode is present exactly once, at the file's coordinates", async (suburb) => {
    const rows = await db.suburb.findMany({
      where: { name: suburb.name, postcode: suburb.postcode, state: "WA" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.centroidLat).toBeCloseTo(suburb.lat, 6);
    expect(rows[0]?.centroidLng).toBeCloseTo(suburb.lng, 6);
  });
});

describe("AC3 -- names are stored in display case, not capitals", () => {
  test("AC3: Fremantle, Shenton Park and O'Connor print unchanged onto a chip", async () => {
    const rows = await db.suburb.findMany({
      where: { slug: { in: ["fremantle-wa-6160", "shenton-park-wa-6008", "oconnor-wa-6163"] } },
      orderBy: { slug: "asc" },
    });
    expect(rows.map((row) => row.name)).toEqual(["Fremantle", "O'Connor", "Shenton Park"]);
  });

  test("AC3: not one seeded name is left in capitals", async () => {
    const shouting = await db.$queryRaw<{ name: string }[]>`
      SELECT name FROM "Suburb" WHERE name = upper(name) AND name <> lower(name) LIMIT 5
    `;
    expect(shouting).toEqual([]);
  });

  test("AC3: the rule handles words, apostrophes, hyphens and brackets", () => {
    expect(displayCase("INNALOO")).toBe("Innaloo");
    expect(displayCase("SHENTON PARK")).toBe("Shenton Park");
    expect(displayCase("O'CONNOR")).toBe("O'Connor");
    expect(displayCase("BRIGHTON-LE-SANDS")).toBe("Brighton-Le-Sands");
    expect(displayCase("HOME ISLAND COCOS (KEELING) ISLANDS")).toBe("Home Island Cocos (Keeling) Islands");
  });

  test("AC3: the two names the apostrophe rule gets wrong are corrected by hand", () => {
    // Capitalising after an apostrophe is right for O'Connor and wrong for
    // these; no rule separates the two cases. The exception list does.
    expect(displayCase("K'GARI")).toBe("K'gari");
    expect(displayCase("STUN'SAIL BOOM")).toBe("Stun'sail Boom");
  });

  test("AC3: and those are the names actually stored, with matching slugs", async () => {
    const rows = await db.suburb.findMany({
      where: { slug: { in: ["kgari-qld-4581", "stunsail-boom-sa-5223"] } },
      orderBy: { slug: "asc" },
    });
    expect(rows.map((row) => row.name)).toEqual(["K'gari", "Stun'sail Boom"]);
  });
});

describe("AC4 -- slugs are qualified and unique", () => {
  test("AC4: the slug is name-state-postcode, apostrophes dropped", () => {
    expect(suburbSlug("Fremantle", "WA", "6160")).toBe("fremantle-wa-6160");
    expect(suburbSlug("Innaloo", "WA", "6018")).toBe("innaloo-wa-6018");
    expect(suburbSlug("Shenton Park", "WA", "6008")).toBe("shenton-park-wa-6008");
    expect(suburbSlug("O'Connor", "WA", "6163")).toBe("oconnor-wa-6163");
  });

  test("AC4: those four slugs are the ones actually stored", async () => {
    const rows = await db.suburb.findMany({
      where: {
        OR: [
          { name: "Fremantle", postcode: "6160", state: "WA" },
          { name: "Innaloo", postcode: "6018", state: "WA" },
          { name: "Shenton Park", postcode: "6008", state: "WA" },
          { name: "O'Connor", postcode: "6163", state: "WA" },
        ],
      },
      orderBy: { slug: "asc" },
    });
    expect(rows.map((row) => row.slug)).toEqual([
      "fremantle-wa-6160",
      "innaloo-wa-6018",
      "oconnor-wa-6163",
      "shenton-park-wa-6008",
    ]);
  });

  test("AC4: the two Perths do not fight, and sit in different places", async () => {
    const perths = await db.suburb.findMany({
      where: { slug: { in: ["perth-wa-6000", "perth-tas-7300"] } },
      orderBy: { slug: "asc" },
    });
    expect(perths.map((row) => row.slug)).toEqual(["perth-tas-7300", "perth-wa-6000"]);
    expect(perths[0]?.centroidLat).not.toBeCloseTo(perths[1]?.centroidLat ?? 0, 2);
    expect(perths[0]?.centroidLng).not.toBeCloseTo(perths[1]?.centroidLng ?? 0, 2);
  });

  test("AC4: nor do the two Hiltons", async () => {
    const hiltons = await db.suburb.findMany({
      where: { name: "Hilton" },
      orderBy: { slug: "asc" },
    });
    expect(hiltons.map((row) => row.slug)).toEqual(["hilton-sa-5033", "hilton-wa-6163"]);
  });

  test("AC4: across every seeded row, zero duplicate slugs", async () => {
    const clashes = await db.$queryRaw<{ slug: string; n: bigint }[]>`
      SELECT slug, count(*) AS n FROM "Suburb" GROUP BY slug HAVING count(*) > 1
    `;
    expect(clashes).toEqual([]);
    expect(await db.suburb.count()).toBe(ROWS_WITH_COORDINATES);
  });
});

describe("AC5 -- non-places are excluded", () => {
  // Every one of these is in the file. None of them is a place a plumber drives to.
  const NOT_PLACES: [string, string][] = [
    ["Perth", "6001"],
    ["Perth", "6800"],
    ["Perth", "6837"],
    ["Innaloo", "6918"],
    ["Fremantle", "6959"],
  ];

  test.each(NOT_PLACES)("AC5: nothing is seeded for %s %s", async (name, postcode) => {
    expect(await db.suburb.count({ where: { name, postcode } })).toBe(0);
  });

  test("AC5: the mail facilities Australia Post still labels 'Delivery Area' are gone too", async () => {
    const count = await db.suburb.count({
      where: { name: { in: ["Perth Gpo", "Nedlands Dc", "City Delivery Centre"] } },
    });
    expect(count).toBe(0);
    // ...and the drop is counted, not silent.
    expect(firstRun.droppedNoCoordinates).toBe(ROWS_IN_FILE - ROWS_WITH_COORDINATES);
  });

  test("AC5: every seeded row carries a non-null, non-zero centroid", async () => {
    const bad = await db.$queryRaw<{ slug: string }[]>`
      SELECT slug FROM "Suburb"
       WHERE "centroidLat" IS NULL OR "centroidLng" IS NULL
          OR "centroidLat" = 0 OR "centroidLng" = 0
       LIMIT 5
    `;
    expect(bad).toEqual([]);
  });
});

describe("AC6 -- coordinates are per suburb, not per postcode", () => {
  test("AC6: the eleven localities sharing 6076 each carry distinct coordinates", async () => {
    const rows = await db.suburb.findMany({ where: { postcode: "6076", state: "WA" } });
    expect(rows.map((row) => row.name).sort()).toEqual([
      "Bickley",
      "Carmel",
      "Gooseberry Hill",
      "Hacketts Gully",
      "Kalamunda",
      "Lesmurdie",
      "Paulls Valley",
      "Pickering Brook",
      "Piesse Brook",
      "Reservoir",
      "Walliston",
    ]);
    const points = new Set(rows.map((row) => `${row.centroidLat},${row.centroidLng}`));
    expect(points.size).toBe(11);
  });
});

describe("AC7 -- the rows answer the question the slider will ask", () => {
  interface Chip {
    postcode: string;
    suburbs: string;
  }

  /**
   * The 2002 query, written here to prove the DATA supports it -- this feature
   * ships no helper. Centroid within X km of the pin, grouped by postcode.
   */
  function chipsWithin(km: number): Promise<Chip[]> {
    return db.$queryRaw<Chip[]>`
      SELECT postcode, string_agg(name, ', ' ORDER BY name) AS suburbs
        FROM "Suburb"
       WHERE ST_DWithin(
               ST_MakePoint("centroidLng", "centroidLat")::geography,
               ST_MakePoint(${BOB_CORE.lng}::float8, ${BOB_CORE.lat}::float8)::geography,
               ${km * 1000}::float8
             )
       GROUP BY postcode
       ORDER BY postcode
    `;
  }

  test("AC7: within 30km of Bob's Fremantle pin, the chips include 6160, 6163, 6008 and 6018", async () => {
    const postcodes = (await chipsWithin(30)).map((chip) => chip.postcode);
    expect(postcodes).toEqual(expect.arrayContaining(["6160", "6163", "6008", "6018"]));
  });

  test("AC7: Mandurah 6210 and Alkimos 6038 are outside that circle", async () => {
    const postcodes = (await chipsWithin(30)).map((chip) => chip.postcode);
    expect(postcodes).not.toContain("6210");
    expect(postcodes).not.toContain("6038");

    // Not a rounding accident: both are genuinely ~50km out.
    const rows = await db.$queryRaw<{ slug: string; km: number }[]>`
      SELECT slug,
             ST_Distance(
               ST_MakePoint("centroidLng", "centroidLat")::geography,
               ST_MakePoint(${BOB_CORE.lng}::float8, ${BOB_CORE.lat}::float8)::geography
             ) / 1000 AS km
        FROM "Suburb"
       WHERE slug IN ('mandurah-wa-6210', 'alkimos-wa-6038')
       ORDER BY slug
    `;
    expect(rows.map((row) => row.slug)).toEqual(["alkimos-wa-6038", "mandurah-wa-6210"]);
    for (const row of rows) {
      expect(row.km).toBeGreaterThan(30);
      expect(row.km).toBeLessThan(60);
    }
  });
});

describe("AC8 -- a postcode covering several suburbs is one group", () => {
  test("AC8: 6008 comes back as one chip carrying Daglish, Shenton Park and Subiaco", async () => {
    const rows = await db.$queryRaw<{ postcode: string; suburbs: string }[]>`
      SELECT postcode, string_agg(name, ', ' ORDER BY name) AS suburbs
        FROM "Suburb"
       WHERE postcode = '6008' AND state = 'WA'
       GROUP BY postcode
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.suburbs).toBe("Daglish, Shenton Park, Subiaco");
  });
});

describe("AC9 -- a hand-edited row survives a re-run", () => {
  test("AC9: an edited Innaloo slug is still there after seeding again", async () => {
    const before = await db.suburb.findFirstOrThrow({ where: { name: "Innaloo", postcode: "6018", state: "WA" } });
    await db.suburb.update({ where: { id: before.id }, data: { slug: "innaloo" } });

    const rerun = await seedSuburbs(db);
    expect(rerun.inserted).toBe(0);

    const after = await db.suburb.findFirstOrThrow({ where: { name: "Innaloo", postcode: "6018", state: "WA" } });
    expect(after.slug).toBe("innaloo");
    expect(after.id).toBe(before.id);
    expect(await db.suburb.count()).toBe(ROWS_WITH_COORDINATES);

    // Put the seeded value back so later files see the real row.
    await db.suburb.update({ where: { id: before.id }, data: { slug: before.slug } });
  }, 120_000);
});

describe("AC10 -- the dedupe guard", () => {
  test("AC10: a file carrying the same (name, postcode, state) twice writes one row, and logs the skip", async () => {
    const directory = mkdtempSync(join(tmpdir(), "suburb-seed-"));
    const fixture = join(directory, "duplicate-triple.csv");
    writeFileSync(
      fixture,
      [
        "Pcode,Locality,State,Comments,Category,Longitude,Latitude",
        '9001,"TEST GULLY",WA,,"Delivery Area",115.700000,-32.100000',
        '9001,"TEST GULLY",WA,,"Delivery Area",115.900000,-32.900000',
        '9001,"TEST RIDGE",WA,,"Delivery Area",115.800000,-32.200000',
        "",
      ].join("\n"),
      "utf8",
    );

    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      logged.push(args.map(String).join(" "));
    };
    let result: SeedSuburbsResult;
    try {
      result = await seedSuburbs(db, fixture);
    } finally {
      console.log = realLog;
    }

    // The run completed rather than dying half-way through the country.
    expect(result.rowsRead).toBe(3);
    expect(result.deduped).toBe(1);
    expect(result.inserted).toBe(2);
    expect(logged.join("\n")).toContain("skipping duplicate (name, postcode, state) -- Test Gully 9001 WA");

    const written = await db.suburb.findMany({ where: { postcode: "9001" }, orderBy: { slug: "asc" } });
    expect(written.map((row) => row.slug)).toEqual(["test-gully-wa-9001", "test-ridge-wa-9001"]);
    // First row wins: the SECOND Test Gully's coordinates were never written.
    expect(written[0]?.centroidLat).toBeCloseTo(-32.1, 6);

    await db.suburb.deleteMany({ where: { postcode: "9001" } });
  });
});

describe("AC11 -- border towns survive", () => {
  const BORDER_TOWNS: [string, string, string[]][] = [
    ["Texas", "4385", ["texas-nsw-4385", "texas-qld-4385"]],
    ["Mungindi", "2406", ["mungindi-nsw-2406", "mungindi-qld-2406"]],
    ["Cottonvale", "4375", ["cottonvale-nsw-4375", "cottonvale-qld-4375"]],
    ["Williamsdale", "2620", ["williamsdale-act-2620", "williamsdale-nsw-2620"]],
  ];

  test.each(BORDER_TOWNS)("AC11: both %s %s rows load", async (name, postcode, slugs) => {
    const rows = await db.suburb.findMany({ where: { name, postcode }, orderBy: { slug: "asc" } });
    expect(rows.map((row) => row.slug)).toEqual(slugs);
  });

  test("AC11: eight rows, four names, four postcodes", async () => {
    const rows = await db.suburb.findMany({
      where: { OR: BORDER_TOWNS.map(([name, postcode]) => ({ name, postcode })) },
    });
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((row) => row.name)).size).toBe(4);
    expect(new Set(rows.map((row) => row.postcode)).size).toBe(4);
  });
});

describe("AC12 -- kept rows whose category is not 'Delivery Area'", () => {
  // The category column is NOT the filter and must never become it: the only two
  // rows for postcode 6799 are the Cocos Islands, both filed under Post Office
  // Boxes, so filtering on category would delete that postcode from the country
  // (plan decision 4). These three are logged instead -- and pinned here.
  //
  // A RE-IMPORT BRINGING A FOURTH FAILS THIS TEST, on purpose. That is the only
  // thing standing between next year's file and PERTH GPO arriving as a
  // service-area chip nobody questions.
  const EXPECTED = [
    { name: "Home Island Cocos (Keeling) Islands", postcode: "6799", state: "WA", category: "Post Office Boxes" },
    { name: "Singleton Military Area", postcode: "2331", state: "NSW", category: "LVR" },
    { name: "West Island Cocos (Keeling) Islands", postcode: "6799", state: "WA", category: "Post Office Boxes" },
  ];

  const byName = (rows: { name: string }[]): { name: string }[] => [...rows].sort((a, b) => a.name.localeCompare(b.name));

  test("AC12: the purchased file carries exactly these three, and no fourth", () => {
    expect(byName(firstRun.keptWithMailCategory)).toEqual(EXPECTED);
  });

  test("AC12: each one is logged by name, postcode, state and category", () => {
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      logged.push(args.map(String).join(" "));
    };
    try {
      readSuburbFile();
    } finally {
      console.log = realLog;
    }
    for (const row of EXPECTED) {
      expect(logged.join("\n")).toContain(
        `keeping a row whose category is not "Delivery Area" -- ${row.name} ${row.postcode} ${row.state} (${row.category})`,
      );
    }
  });

  test("AC12: all three are real places that were kept, not dropped", async () => {
    const rows = await db.suburb.findMany({
      where: { OR: EXPECTED.map(({ name, postcode, state }) => ({ name, postcode, state })) },
    });
    expect(rows).toHaveLength(3);
    // 6799 exists at all only because the category is not the rule.
    expect(await db.suburb.count({ where: { postcode: "6799" } })).toBe(2);
  });

  test("AC12: an ordinary locality is not in the list", () => {
    const names = firstRun.keptWithMailCategory.map((row) => row.name);
    expect(names).not.toContain("Fremantle");
    expect(names).not.toContain("Innaloo");
  });
});

describe("the committed file is the one the plan describes", () => {
  test("the seed reads geocoded_postcode_file_pc004_29082026.csv and nothing else", () => {
    expect(SUBURB_DATA_FILE.endsWith("/data/geocoded_postcode_file_pc004_29082026.csv")).toBe(true);
  });

  test("the parser reads quoted fields, not commas -- a locality holding a comma stays one field", () => {
    const table = parseCsv(
      [
        "Pcode,Locality,State,Comments,Category,Longitude,Latitude",
        '9002,"HALLS GAP, NORTH",VIC,"SAYS ""BOX""","Delivery Area",142.5,-37.1',
        "",
      ].join("\n"),
    );
    expect(table).toHaveLength(2);
    expect(table[1]).toEqual(["9002", "HALLS GAP, NORTH", "VIC", 'SAYS "BOX"', "Delivery Area", "142.5", "-37.1"]);
  });

  test("the parser survives a file with no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});
