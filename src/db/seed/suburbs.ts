// Suburb reference seed -- Feature 1002, suburb reference seed.
//
// Loads the Australia Post Geocoded Postcode File (National) into `Suburb`:
// one row per suburb-postcode-state triple, each carrying its own centroid.
// These rows are what the radius slider asks (feature 2002) and what the SEO
// landing pages iterate (8001). Google cannot answer "list every suburb within
// 30km" -- that is the whole reason this table exists (ADR 0003).
//
// ITS OWN COMMAND, not the base seed. 15,608 rows is a one-off load; nothing is
// gained by repeating it on every test run and every deploy. `db:seed` is
// unchanged.
//
// LICENSED DATA. `data/geocoded_postcode_file_pc004_29082026.csv` was purchased
// under a twelve-month term (ADR 0003). It stays inside this repo and this
// product -- never copied into fixtures, gists or issues, never hand-edited,
// never re-saved from Excel (postcodes are text: `0810`, `0200`).
//
// CREATE-IF-MISSING, never update -- the same rule base.ts follows, for a
// different reason. Once a slug is public an SEO page hangs off it, so a
// re-import that rewrote rows could move a live URL. A second run adds
// genuinely new suburbs and touches nothing else.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { disconnectPrisma, getPrisma, type PrismaClient } from "../client.js";

/** The committed file. Its name carries the product code and purchase date. */
export const SUBURB_DATA_FILE = new URL(
  "../../../data/geocoded_postcode_file_pc004_29082026.csv",
  import.meta.url,
).pathname;

/** Rows are inserted in batches; 15,608 rows in one statement helps nobody. */
const BATCH_SIZE = 1_000;

export interface SuburbRow {
  name: string;
  slug: string;
  postcode: string;
  state: string;
  centroidLat: number;
  centroidLng: number;
}

/**
 * A row the filter KEPT whose Australia Post category is not `Delivery Area`.
 *
 * The category column is not the rule and must never become it (plan decision 4):
 * the only two rows for postcode 6799 are the Cocos Islands, both filed under
 * `Post Office Boxes`, so filtering on category would delete that postcode from
 * the country. But a kept row with a mail category is still worth saying out
 * loud, because the DAY it stops being three real inhabited places is the day
 * `PERTH GPO` becomes a service-area chip nobody questions.
 */
export interface MailCategoryRow {
  name: string;
  postcode: string;
  state: string;
  category: string;
}

export interface SeedSuburbsResult {
  rowsRead: number;
  droppedNoCoordinates: number;
  deduped: number;
  inserted: number;
  alreadyPresent: number;
  keptWithMailCategory: MailCategoryRow[];
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/**
 * RFC 4180 CSV, field by field. Not a split on commas: fields are quoted and a
 * quoted field is allowed to hold a comma. Doubled quotes inside a quoted field
 * are one literal quote.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = "";
    started = true;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      started = true;
    } else if (char === ",") {
      endField();
    } else if (char === "\n") {
      endRow();
    } else if (char !== "\r") {
      field += char;
      started = true;
    }
  }
  // A file that does not end in a newline still has one last row in hand.
  if (started || field.length > 0 || row.length > 0) endRow();

  return rows;
}

/**
 * The handful of names the rule below gets wrong, keyed on the file's own
 * spelling. Capitalising after an apostrophe is right for `O'CONNOR` and
 * `D'AGUILAR` and wrong for these two, and no rule tells the cases apart -- the
 * apostrophe is doing a different job in each. Two rows out of 15,608.
 *
 * This list is the "fixable by editing one row" the plan's decision 6 promised.
 * A future file that reveals a third exception adds a line here.
 */
const DISPLAY_CASE_EXCEPTIONS = new Map<string, string>([
  ["K'GARI", "K'gari"],
  ["STUN'SAIL BOOM", "Stun'sail Boom"],
]);

/**
 * `INNALOO` -> `Innaloo`, `SHENTON PARK` -> `Shenton Park`, `O'CONNOR` ->
 * `O'Connor`. The file ships capitals and this column is read straight onto
 * chip labels and page headings -- "Plumber in INNALOO" is not shippable.
 *
 * Known-imperfect by nature: it capitalises after a space, hyphen, apostrophe
 * or bracket, then applies the exception list above. Anything still slightly
 * wrong is a LABEL, fixable by editing one row -- never a matching failure,
 * because nothing matches on the name.
 */
export function displayCase(name: string): string {
  const exception = DISPLAY_CASE_EXCEPTIONS.get(name.trim().toUpperCase());
  if (exception !== undefined) return exception;
  return name
    .toLowerCase()
    .replace(/(^|[\s'()-])([a-z])/g, (_match, boundary: string, letter: string) => boundary + letter.toUpperCase());
}

/**
 * The slug is ALWAYS qualified: name-state-postcode. `innaloo-wa-6018`,
 * `perth-wa-6000`, `perth-tas-7300`. Names repeat and the seed writes ~15,600
 * rows with nobody watching, so "clean name unless it clashes" would eventually
 * force a live page URL to be renamed on a re-import. Qualifying every row makes
 * the slug unique by construction, out of the same triple the table keys on.
 * See the design's Suburb (reference data).
 */
export function suburbSlug(name: string, state: string, postcode: string): string {
  const base = name
    .toLowerCase()
    .replace(/'/g, "") // O'Connor -> oconnor, not o-connor
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base}-${state.toLowerCase()}-${postcode.toLowerCase()}`;
}

export interface ReadSuburbFileResult {
  rows: SuburbRow[];
  rowsRead: number;
  droppedNoCoordinates: number;
  deduped: number;
  keptWithMailCategory: MailCategoryRow[];
}

/** The category every ordinary locality carries. Anything else that survives the
 *  filter gets named in the log -- see MailCategoryRow. */
const PLACE_CATEGORY = "delivery area";

/**
 * File -> the rows worth inserting.
 *
 * ONE FILTER RULE: no coordinates, not a place. PO box, LVR and mail-facility
 * rows almost always arrive with Latitude and Longitude blank -- including the
 * 640 rows Australia Post still labels `Delivery Area` (`PERTH GPO`,
 * `NEDLANDS DC`, `CITY DELIVERY CENTRE`). Dropping those removes them in one
 * line: no category logic, no postcode-range tricks.
 *
 * THE CATEGORY COLUMN IS NOT THE RULE AND MUST NEVER BECOME IT. Three rows
 * carry a mail category AND real coordinates, and all three are real inhabited
 * places -- the only two rows for postcode 6799 are the Cocos Islands, both
 * filed under `Post Office Boxes`, so a category filter would delete that
 * postcode from the country. They are logged instead, and pinned by a test.
 *
 * The DEDUPE GUARD is keyed on (name, postcode, state), first row wins. This
 * file has zero duplicate triples; the guard exists so a future file cannot kill
 * a 15,608-row run half-way through the country.
 */
export function readSuburbFile(filePath: string = SUBURB_DATA_FILE): ReadSuburbFileResult {
  const table = parseCsv(readFileSync(filePath, "utf8"));
  const header = table[0];
  if (!header) throw new Error(`${filePath} is empty`);

  const columnOf = (heading: string): number => {
    const index = header.findIndex((cell) => cell.trim().toLowerCase() === heading.toLowerCase());
    if (index === -1) {
      throw new Error(`${filePath} has no "${heading}" column -- found: ${header.join(", ")}`);
    }
    return index;
  };
  const postcodeAt = columnOf("Pcode");
  const localityAt = columnOf("Locality");
  const stateAt = columnOf("State");
  const categoryAt = columnOf("Category");
  const longitudeAt = columnOf("Longitude");
  const latitudeAt = columnOf("Latitude");

  const rows: SuburbRow[] = [];
  const keptWithMailCategory: MailCategoryRow[] = [];
  const seen = new Set<string>();
  let rowsRead = 0;
  let droppedNoCoordinates = 0;
  let deduped = 0;

  for (const cells of table.slice(1)) {
    // A trailing newline leaves one empty row behind; it is not a data row.
    if (cells.length <= 1 && (cells[0] ?? "").trim() === "") continue;
    rowsRead++;

    const centroidLat = Number(cells[latitudeAt]?.trim());
    const centroidLng = Number(cells[longitudeAt]?.trim());
    const hasCoordinates =
      (cells[latitudeAt] ?? "").trim() !== "" &&
      (cells[longitudeAt] ?? "").trim() !== "" &&
      Number.isFinite(centroidLat) &&
      Number.isFinite(centroidLng);
    if (!hasCoordinates) {
      droppedNoCoordinates++;
      continue;
    }

    const name = displayCase((cells[localityAt] ?? "").trim());
    const postcode = (cells[postcodeAt] ?? "").trim();
    const state = (cells[stateAt] ?? "").trim().toUpperCase();

    const key = `${name}|${postcode}|${state}`;
    if (seen.has(key)) {
      deduped++;
      console.log(`suburb seed: skipping duplicate (name, postcode, state) -- ${name} ${postcode} ${state}`);
      continue;
    }
    seen.add(key);

    // Kept, and not an ordinary locality. Three rows in the purchased file, all
    // three real inhabited places; a fourth means the next file needs reading
    // before it is trusted. The test on this list is what stands between a
    // re-import and PERTH GPO arriving as a chip.
    const category = (cells[categoryAt] ?? "").trim();
    if (category.toLowerCase() !== PLACE_CATEGORY) {
      keptWithMailCategory.push({ name, postcode, state, category });
      console.log(
        `suburb seed: keeping a row whose category is not "Delivery Area" -- ${name} ${postcode} ${state} (${category})`,
      );
    }

    rows.push({ name, slug: suburbSlug(name, state, postcode), postcode, state, centroidLat, centroidLng });
  }

  return { rows, rowsRead, droppedNoCoordinates, deduped, keptWithMailCategory };
}

// ---------------------------------------------------------------------------
// Writing them
// ---------------------------------------------------------------------------

export async function seedSuburbs(
  client: PrismaClient = getPrisma(),
  filePath: string = SUBURB_DATA_FILE,
): Promise<SeedSuburbsResult> {
  const { rows, rowsRead, droppedNoCoordinates, deduped, keptWithMailCategory } = readSuburbFile(filePath);

  // One read of what is already there, rather than 15,608 findUnique calls.
  const existing = await client.suburb.findMany({ select: { name: true, postcode: true, state: true } });
  const present = new Set(existing.map((row) => `${row.name}|${row.postcode}|${row.state}`));
  const missing = rows.filter((row) => !present.has(`${row.name}|${row.postcode}|${row.state}`));

  let inserted = 0;
  for (let start = 0; start < missing.length; start += BATCH_SIZE) {
    const batch = missing.slice(start, start + BATCH_SIZE);
    const { count } = await client.suburb.createMany({ data: batch, skipDuplicates: true });
    inserted += count;
  }

  return {
    rowsRead,
    droppedNoCoordinates,
    deduped,
    inserted,
    alreadyPresent: rows.length - missing.length,
    keptWithMailCategory,
  };
}

/**
 * Every rule says how many rows it dropped, so a future re-import is comparable
 * at a glance: a source change that suddenly drops 3,000 extra rows announces
 * itself instead of quietly shrinking the country.
 */
export function summarise(result: SeedSuburbsResult): string {
  return (
    `suburb seed: ${result.rowsRead} rows read; ` +
    `${result.droppedNoCoordinates} dropped (no coordinates -- mostly PO boxes, LVRs and mail facilities); ` +
    `${result.deduped} deduped on (name, postcode, state); ` +
    `${result.keptWithMailCategory.length} kept despite a non-"Delivery Area" category; ` +
    `${result.inserted} inserted; ${result.alreadyPresent} already present`
  );
}

async function main(): Promise<void> {
  const result = await seedSuburbs();
  console.log(summarise(result));
  await disconnectPrisma();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error: unknown) => {
    console.error(error);
    await disconnectPrisma();
    process.exit(1);
  });
}
