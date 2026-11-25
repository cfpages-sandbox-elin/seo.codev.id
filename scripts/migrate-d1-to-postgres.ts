/**
 * One-time D1 (SQLite) -> Postgres data migration.
 *
 * Authored 2026-06-29. This script is coupled to the schema as of that date — it
 * reflects every table over Drizzle, so a schema change merged later (new table,
 * renamed timestamp column, a new no-PK/unique-index table, etc.) may require
 * updating `deltaPredicate`/`conflictArbiterNames` before re-using it. Re-read it
 * against the current schema before relying on it.
 *
 * The provider-aware DB layer (DATABASE_PROVIDER=postgres) ships the schema and
 * runtime, but NOT the data. This script copies the data table-by-table, reading
 * each table directly from D1 over the Cloudflare REST API and writing to a
 * freshly-migrated Postgres database. Writes may be frozen during the copy for a
 * perfectly consistent snapshot, but the `--update` delta pass (below) makes that
 * optional — see the runbooks.
 *
 * Why read D1 directly (vs `wrangler d1 export` + reimport): a SQL-dump round
 * trip is fragile — the export download can silently truncate yet report
 * success, and reimporting 400MB+ of SQL text is its own failure surface.
 * Querying each table over the API removes that entire class of problem and
 * reads live, complete data.
 *
 * Type conversions (the reason a raw copy doesn't work) are delegated to
 * Drizzle's own column codecs: we run each raw D1 value through the SQLite
 * column's `mapFromDriverValue` (integer epoch-ms -> Date, 0/1 -> boolean) and
 * write through the Postgres column (Date -> timestamptz, boolean -> boolean).
 * App-table timestamps are TEXT in both dialects, but D1's `current_timestamp`
 * default is `YYYY-MM-DD HH:MM:SS`; we rewrite those to the ISO-8601 form the
 * Postgres code writes. Values already in ISO are left untouched.
 *
 * Tables are copied in foreign-key-safe order and inserts use
 * `onConflictDoNothing`, so a failed run is safe to re-run from the top.
 *
 * Setup: put the credentials in `.env.local` (auto-loaded), then run the script
 * directly with tsx. See the runbooks for the full procedure:
 *   - docs/maintainers/runbooks/d1-to-postgres-simple.md   (happy path)
 *   - docs/maintainers/runbooks/d1-to-postgres-detailed.md (full detail + cutover)
 *
 *   # .env.local
 *   CLOUDFLARE_ACCOUNT_ID=...
 *   CLOUDFLARE_API_TOKEN=...          # D1 read
 *   POSTGRES_DATABASE_URL=postgres://user:pass@host:5432/db
 *   # CLOUDFLARE_D1_DATABASE_ID=...   # optional; else read from wrangler.jsonc
 *
 * Usage:
 *   pnpm exec tsx scripts/migrate-d1-to-postgres.ts [flags]
 *
 *   --dry-run         Report D1 row counts only; write nothing.
 *   --allow-nonempty  Proceed even if the target already has rows (default: abort).
 *   --page-size N     Rows per D1 API page (default 5000).
 *   --update          Delta/catch-up sync: only rows changed within the window
 *                     (default 12h), UPSERTing instead of insert-or-ignore. Run
 *                     this right before cutover to top up an already-migrated
 *                     Postgres. Big time-series tables are filtered by their
 *                     recency column; small tables are fully re-upserted (which
 *                     also catches updates to old rows). Deletes are not synced.
 *   --since-hours N   Window for --update (default 12).
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs as parseCliArgs } from "node:util";
import {
  getTableColumns,
  getTableName,
  is,
  sql,
  Table,
  Column,
  type SQL,
} from "drizzle-orm";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadLocalEnv } from "./cli-utils";
// The Node-safe raw barrels (not ../src/db/schema, the provider-aware one, which
// imports cloudflare:workers). Importing the barrels keeps the table list in sync
// automatically if a schema file is later added.
import * as sqliteSchema from "../src/db/d1/schema";
import * as pgSchema from "../src/db/pg/schema";

loadLocalEnv();

let parsedArgs;
try {
  parsedArgs = parseCliArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      "allow-nonempty": { type: "boolean", default: false },
      "page-size": { type: "string", default: "5000" },
      update: { type: "boolean", default: false },
      "since-hours": { type: "string", default: "12" },
      table: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
} catch (err: any) {
  console.error(`Invalid CLI arguments: ${err?.message || err}`);
  process.exit(1);
}

if (parsedArgs.values.help) {
  console.log(`Usage: pnpm exec tsx scripts/migrate-d1-to-postgres.ts [flags]
Flags:
  --dry-run         Report D1 row counts only; write nothing.
  --allow-nonempty  Proceed even if the target already has rows (default: abort).
  --page-size N     Rows per D1 API page (default 5000, 1..50000).
  --update          Delta/catch-up sync: only rows changed within the window (default 12h).
  --since-hours N   Window for --update (default 12, positive number <= 8760).
  --table <name>    Migrate single table only.
  --help            Show this help text.`);
  process.exit(0);
}

const dryRun = parsedArgs.values["dry-run"] ?? false;
const allowNonEmpty = parsedArgs.values["allow-nonempty"] ?? false;
const updateMode = parsedArgs.values.update ?? false;
const rawSelectedTable = parsedArgs.values.table;
if (rawSelectedTable !== undefined && rawSelectedTable.trim() === "") {
  console.error("Invalid --table value: table name cannot be empty.");
  process.exit(1);
}
const selectedTable = rawSelectedTable?.trim();

const rawPageSize = Number(parsedArgs.values["page-size"]);
if (
  !Number.isSafeInteger(rawPageSize) ||
  rawPageSize < 1 ||
  rawPageSize > 50000
) {
  console.error(
    `Invalid --page-size: '${parsedArgs.values["page-size"]}'. Must be an integer between 1 and 50000.`,
  );
  process.exit(1);
}
const pageSize = rawPageSize;

const rawSinceHours = Number(parsedArgs.values["since-hours"]);
if (
  !Number.isFinite(rawSinceHours) ||
  rawSinceHours <= 0 ||
  rawSinceHours > 8760
) {
  console.error(
    `Invalid --since-hours: '${parsedArgs.values["since-hours"]}'. Must be a positive number <= 8760.`,
  );
  process.exit(1);
}
const sinceHours = rawSinceHours;

// Tables whose rows are big enough that the default page size would build a
// multi-gigabyte D1 HTTP response and a multi-gigabyte INSERT. `reports.html`
// is capped at REPORT_MAX_HTML_BYTES (500 KB) per row.
const PAGE_SIZE_OVERRIDES: Record<string, number> = { reports: 20 };

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const connectionString = process.env.POSTGRES_DATABASE_URL;

// D1's `current_timestamp` text is `YYYY-MM-DD HH:MM:SS`. App code elsewhere
// writes `new Date().toISOString()`, which already has a `T` separator and never
// matches this pattern, so it is left untouched.
const SPACE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;
const toIsoText = (value: string) => `${value.replace(" ", "T")}.000Z`;

// Sol R24-03: Restrict ISO text conversion strictly to known timestamp columns
// so business text (like page titles or descriptions) is never corrupted.
const TIMESTAMP_COLUMN_NAMES = new Set([
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "observed_at",
  "approved_at",
  "archived_at",
  "last_active_at",
  "expires_at",
  "verified_at",
  "checked_at",
  "dispatched_at",
  "fetched_at",
]);

function resolveDatabaseId(): string {
  const override = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim();
  if (override) return override;
  const wrangler = readFileSync("wrangler.jsonc", "utf8");
  const match = wrangler.match(/"database_id"\s*:\s*"([^"]+)"/u);
  if (!match) {
    throw new Error(
      "Could not find database_id in wrangler.jsonc; set CLOUDFLARE_D1_DATABASE_ID.",
    );
  }
  return match[1];
}

async function d1Query<T = Record<string, unknown>>(
  databaseId: string,
  statement: string,
  params?: unknown[],
): Promise<T[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        params && params.length > 0
          ? { sql: statement, params }
          : { sql: statement },
      ),
    },
  );
  const json = (await response.json()) as {
    success?: boolean;
    errors?: unknown;
    result?: { success?: boolean; results?: T[] }[];
  };
  if (
    !response.ok ||
    json.success !== true ||
    !Array.isArray(json.result) ||
    json.result.length === 0 ||
    json.result[0]?.success === false ||
    !Array.isArray(json.result[0]?.results)
  ) {
    throw new Error(`D1_QUERY_FAILED: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result[0].results;
}

function tablesByName(modules: Record<string, unknown>[]): Map<string, Table> {
  const out = new Map<string, Table>();
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (is(value, Table)) out.set(getTableName(value), value);
    }
  }
  return out;
}

// Order tables so each is copied after the tables its foreign keys reference
// (Kahn's algorithm over the SQLite FK graph). Self-references are ignored.
function fkSafeOrder(tables: Map<string, Table>): string[] {
  const deps = new Map<string, Set<string>>();
  for (const [name, table] of tables) {
    const referenced = new Set<string>();
    for (const fk of getSqliteTableConfig(table).foreignKeys) {
      const target = getTableName(fk.reference().foreignTable);
      if (target !== name && tables.has(target)) referenced.add(target);
    }
    deps.set(name, referenced);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < tables.size) {
    const ready = [...deps]
      .filter(([name]) => !placed.has(name))
      .filter(([, refs]) => [...refs].every((r) => placed.has(r)))
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      // No FK cycle exists in this schema, so this is unreachable. Fail loud
      // rather than copy the remaining tables in an arbitrary order that could
      // violate FK constraints on insert.
      const remaining = [...tables.keys()].filter((n) => !placed.has(n));
      throw new Error(
        `Foreign-key cycle detected among: ${remaining.join(", ")}. Cannot order these tables for a constraint-safe copy.`,
      );
    }
    for (const name of ready) {
      ordered.push(name);
      placed.add(name);
    }
  }
  return ordered;
}

function primaryKeyColumnNames(table: Table): string[] {
  const config = getSqliteTableConfig(table);
  const cols = new Set<string>();
  for (const col of Object.values(getTableColumns(table))) {
    if (col.primary) cols.add(col.name);
  }
  for (const composite of config.primaryKeys) {
    for (const col of composite.columns) cols.add(col.name);
  }
  return [...cols];
}

// Stable pagination order: the table's primary key or conflict arbiter. (Sol P2-04)
function primaryKeyOrder(table: Table): string {
  const cols = primaryKeyColumnNames(table);
  if (cols.length) return `ORDER BY ${cols.map((c) => `"${c}"`).join(",")}`;
  const arbiter = conflictArbiterNames(table);
  if (arbiter.length)
    return `ORDER BY ${arbiter.map((c) => `"${c}"`).join(",")}`;
  return "";
}

// Conflict arbiter for --update upserts: the table's PK if it has one, else the
// columns of its first unique index. Join tables (saved_keyword_tag_assignments)
// have no PK — their identity is a unique index — so a PK-only arbiter would emit
// `ON CONFLICT ()` and fail to parse.
function conflictArbiterNames(table: Table): string[] {
  const pk = primaryKeyColumnNames(table);
  if (pk.length) return pk;
  for (const idx of getSqliteTableConfig(table).indexes) {
    if (idx.config.unique) {
      const names: string[] = [];
      for (const col of idx.config.columns) {
        // Index entries can be raw SQL; only plain columns have a name.
        if (is(col, Column)) names.push(col.name);
      }
      return names;
    }
  }
  return [];
}

// --update mode: WHERE fragment selecting rows changed within the window. Only
// genuinely large, append-mostly tables are filtered here. Everything else falls
// through to a full re-upsert each run — which is the ONLY way to catch in-place
// updates to pre-window rows, since those rows' timestamps don't move. That
// matters for mutable tables that aren't huge: audits / rank_check_runs (status,
// counts, completedAt updated after creation), rank_tracking_keywords (metrics
// refreshed in place), plus the small config/entity tables. Filtering them by a
// creation timestamp would silently drop those updates, and the row-count verify
// can't catch it. SQLite datetime() normalizes both ISO and D1's legacy
// space-format text, so the comparison is format-agnostic. The cutoff is
// script-generated, not user input. Deletes are never synced by insert/upsert.
function deltaPredicate(table: string, cutoffIso: string): string | null {
  const since = `datetime('${cutoffIso}')`;
  switch (table) {
    // keyword_metrics is mutable but its fetched_at advances on every upsert, so
    // a recency filter still catches in-place metric refreshes.
    case "keyword_metrics":
      return `datetime("fetched_at") >= ${since}`;
    case "rank_snapshots":
      return `datetime("checked_at") >= ${since}`;
    // Audit child rows carry no timestamp of their own — scope by parent audit (started or completed in window) (Sol P2-04).
    case "audit_pages":
    case "audit_issues":
    case "audit_lighthouse_results":
      return `"audit_id" IN (SELECT id FROM audits WHERE datetime("started_at") >= ${since} OR datetime("completed_at") >= ${since})`;
    default:
      return null;
  }
}

// ON CONFLICT DO UPDATE target (the conflict arbiter columns) + set (every other
// column to the incoming "excluded" value), so --update mode overwrites changed
// rows. The target is sourced from the pg table config so it carries the pg
// column type onConflictDoUpdate requires; the set is keyed by JS field name to
// match the values() payload.
function buildUpsert(pgTable: Table, arbiterNames: string[]) {
  const pk = new Set(arbiterNames);
  const target = getPgTableConfig(pgTable).columns.filter((c) =>
    pk.has(c.name),
  );
  const set: Record<string, SQL> = {};
  for (const [jsKey, col] of Object.entries(getTableColumns(pgTable)) as [
    string,
    Column,
  ][]) {
    if (!pk.has(col.name)) {
      set[jsKey] = sql`excluded.${sql.identifier(col.name)}`;
    }
  }
  return { target, set };
}

// Decode a raw D1 row into the shape Drizzle's Postgres insert expects, reusing
// each SQLite column's codec (epoch-ms -> Date, 0/1 -> boolean), then normalize
// legacy space-format timestamp text to ISO.
function convertRow(
  sqliteTable: Table,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [jsKey, column] of Object.entries(
    getTableColumns(sqliteTable),
  ) as [string, Column][]) {
    const raw = row[column.name];
    if (raw === null || raw === undefined) {
      out[jsKey] = null;
      continue;
    }
    let value = column.mapFromDriverValue(raw);
    // Sol R24-03: Only normalize timestamps on known timestamp columns to preserve business text
    if (
      TIMESTAMP_COLUMN_NAMES.has(column.name) &&
      typeof value === "string" &&
      SPACE_TIMESTAMP.test(value)
    ) {
      value = toIsoText(value);
    }
    out[jsKey] = value;
  }
  return out;
}

async function countD1(
  databaseId: string,
  table: string,
  predicate?: string | null,
): Promise<number> {
  const where = predicate ? ` WHERE ${predicate}` : "";
  const [row] = await d1Query<{ c: number }>(
    databaseId,
    `SELECT count(*) AS c FROM "${table}"${where}`,
  );
  return Number(row?.c ?? 0);
}

type PgDb = ReturnType<typeof drizzlePg>;

function stableRowDigest(row: Record<string, unknown>): string {
  const entries = Object.keys(row)
    .sort()
    .map((k) => {
      const val = row[k];
      if (val instanceof Date) return [k, val.toISOString()];
      return [k, val ?? null];
    });
  return JSON.stringify(entries);
}

// Copy one table from D1 to Postgres using parameter-bound tuple keyset pagination across PK/unique arbiter keys.
async function copyTable(
  databaseId: string,
  dest: PgDb,
  name: string,
  sqliteTable: Table,
  pgTable: Table,
  predicate: string | null,
  upsert: boolean,
): Promise<{
  readCount: number;
  appliedCount: number;
  contentMismatches: number;
}> {
  const keyCols = conflictArbiterNames(sqliteTable);
  const orderBy =
    keyCols.length > 0
      ? `ORDER BY ${keyCols.map((c) => `"${c}" ASC`).join(", ")}`
      : primaryKeyOrder(sqliteTable);
  const colCount = Object.keys(getTableColumns(pgTable)).length;
  const tablePageSize = PAGE_SIZE_OVERRIDES[name] ?? pageSize;
  const insertBatch = Math.max(
    1,
    Math.min(tablePageSize, Math.floor(50000 / colCount)),
  );
  const { target, set } = buildUpsert(pgTable, keyCols);
  const canUpsert = upsert && target.length > 0 && Object.keys(set).length > 0;
  const pgColsMap = getTableColumns(pgTable);
  const pgColsByDbName = new Map(
    Object.entries(pgColsMap).map(([jsKey, col]) => [col.name, { jsKey, col }]),
  );

  let cursorValues: unknown[] | null = null;
  let offset = 0;
  let readCount = 0;
  let appliedCount = 0;
  let contentMismatches = 0;

  for (;;) {
    let where = "";
    let params: unknown[] | undefined;
    if (keyCols.length > 0) {
      const tupleLhs =
        keyCols.length === 1
          ? `"${keyCols[0]}"`
          : `(${keyCols.map((c) => `"${c}"`).join(", ")})`;
      const tupleRhs =
        keyCols.length === 1 ? `?` : `(${keyCols.map(() => "?").join(", ")})`;
      const cursorClause = cursorValues ? `${tupleLhs} > ${tupleRhs}` : "";
      const parts = [predicate, cursorClause].filter(Boolean);
      where = parts.length > 0 ? `WHERE ${parts.join(" AND ")} ` : "";
      if (cursorValues) params = cursorValues;
    } else {
      where = predicate ? `WHERE ${predicate} ` : "";
    }

    const query =
      keyCols.length > 0
        ? `SELECT * FROM "${name}" ${where}${orderBy} LIMIT ${tablePageSize}`
        : `SELECT * FROM "${name}" ${where}${orderBy} LIMIT ${tablePageSize} OFFSET ${offset}`;

    const page: Record<string, unknown>[] = await d1Query<
      Record<string, unknown>
    >(databaseId, query, params);
    if (page.length === 0) break;

    if (keyCols.length > 0) {
      const lastRow: Record<string, unknown> = page[page.length - 1];
      cursorValues = keyCols.map((k) => lastRow[k]);
    } else {
      offset += tablePageSize;
    }

    const rows = page.map((row: Record<string, unknown>) =>
      convertRow(sqliteTable, row),
    );
    for (let i = 0; i < rows.length; i += insertBatch) {
      const chunk = rows.slice(i, i + insertBatch);
      const inserted = await (canUpsert
        ? dest
            .insert(pgTable)
            .values(chunk)
            .onConflictDoUpdate({ target, set })
            .returning()
        : dest.insert(pgTable).values(chunk).onConflictDoNothing().returning());
      appliedCount += inserted.length;

      // V3-04: When conflict skips occur (e.g. --allow-nonempty), verify surviving destination payload equals source row
      if (inserted.length < chunk.length && keyCols.length > 0) {
        for (const expectedRow of chunk) {
          const keyPredicates = keyCols
            .map((colName) => {
              const entry = pgColsByDbName.get(colName);
              if (!entry) return null;
              return sql`${entry.col} = ${expectedRow[entry.jsKey]}`;
            })
            .filter(Boolean) as SQL[];
          if (keyPredicates.length === keyCols.length) {
            const destRows = await dest
              .select()
              .from(pgTable)
              .where(sql.join(keyPredicates, sql` AND `))
              .limit(1);
            if (
              destRows.length === 0 ||
              stableRowDigest(destRows[0] as Record<string, unknown>) !==
                stableRowDigest(expectedRow)
            ) {
              contentMismatches++;
            }
          }
        }
      }
    }
    readCount += page.length;
    if (page.length < tablePageSize) break;
  }
  return { readCount, appliedCount, contentMismatches };
}

async function main() {
  if (!accountId || !apiToken) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.",
    );
  }
  if (!dryRun && !connectionString) {
    throw new Error("POSTGRES_DATABASE_URL is required.");
  }
  const databaseId = resolveDatabaseId();

  const sqliteTables = tablesByName([sqliteSchema]);
  const pgTables = tablesByName([pgSchema]);
  const fullOrder = fkSafeOrder(sqliteTables);
  if (selectedTable) {
    if (!sqliteTables.has(selectedTable) || !pgTables.has(selectedTable)) {
      throw new Error(
        `Unknown migration table: '${selectedTable}'. Table does not exist in schema.`,
      );
    }
  }
  const order = selectedTable ? [selectedTable] : fullOrder;
  const cutoffIso = new Date(Date.now() - sinceHours * 3_600_000).toISOString();

  const mode = updateMode ? `UPDATE — last ${sinceHours}h` : "FULL";
  console.log(
    `Migrating ${order.length} tables [${mode}]: D1 ${databaseId} -> Postgres${dryRun ? " (DRY RUN)" : ""}\n`,
  );

  if (dryRun) {
    let total = 0;
    for (const name of order) {
      const predicate = updateMode ? deltaPredicate(name, cutoffIso) : null;
      const count = await countD1(databaseId, name, predicate);
      total += count;
      console.log(`  ${name.padEnd(34)} ${String(count).padStart(7)}`);
    }
    console.log(
      `\nDone. ${total} ${updateMode ? "rows to sync" : "source rows"}. (dry run — nothing written)`,
    );
    return;
  }

  const pgClient = postgres(connectionString!, { max: 1 });
  const dest = drizzlePg(pgClient);

  try {
    // Preflight: refuse to write into a populated target unless opted in.
    // Skipped in --update mode, where the target is expected to already hold the
    // full migration this run only tops up.
    if (!allowNonEmpty && !updateMode) {
      for (const name of order) {
        const [{ count }] = await dest
          .select({ count: sql<number>`count(*)::int` })
          .from(pgTables.get(name)!);
        if (Number(count) > 0) {
          throw new Error(
            `Target table "${name}" already has ${count} rows. Migrate into a freshly-created Postgres, or pass --allow-nonempty (idempotent via onConflictDoNothing).`,
          );
        }
      }
    }

    const written = new Map<
      string,
      { readCount: number; appliedCount: number; contentMismatches: number }
    >();
    let totalContentMismatches = 0;
    for (const name of order) {
      const predicate = updateMode ? deltaPredicate(name, cutoffIso) : null;
      const counts = await copyTable(
        databaseId,
        dest,
        name,
        sqliteTables.get(name)!,
        pgTables.get(name)!,
        predicate,
        updateMode,
      );
      written.set(name, counts);
      totalContentMismatches += counts.contentMismatches;
      const verb = updateMode ? "synced" : "wrote";
      const skippedNote =
        counts.readCount > counts.appliedCount
          ? ` (read: ${counts.readCount}, skipped: ${counts.readCount - counts.appliedCount}, contentMismatches: ${counts.contentMismatches})`
          : "";
      console.log(
        `  ${name.padEnd(34)} ${verb} ${String(counts.appliedCount).padStart(7)}${skippedNote}`,
      );
    }

    // V3-04: Monotonic serial sequence advance (never rewind an already higher sequence)
    console.log("\nAdvancing serial sequences monotonically...");
    for (const name of order) {
      const pgTable = pgTables.get(name)!;
      for (const column of Object.values(getTableColumns(pgTable))) {
        if (column.getSQLType() !== "serial") continue;
        const col = sql.identifier(column.name);
        const tbl = sql.identifier(name);
        await dest.execute(sql`
        SELECT CASE
          WHEN (SELECT max(${col}) FROM ${tbl}) IS NOT NULL THEN
            setval(
              pg_get_serial_sequence(${name}, ${column.name}),
              GREATEST(
                (SELECT COALESCE(last_value, 1) FROM pg_sequences WHERE schemaname = current_schema() AND sequencename = split_part(pg_get_serial_sequence(${name}, ${column.name}), '.', 2)),
                (SELECT max(${col}) FROM ${tbl})
              ),
              true
            )
          ELSE NULL
        END
      `);
        console.log(`  ${name}.${column.name} sequence checked`);
      }
    }

    // Verify: D1 count + keyed sample content parity vs Postgres per table.
    console.log("\nVerifying row counts and content parity...");
    let mismatches = totalContentMismatches;
    for (const name of order) {
      const sourceCount = await countD1(databaseId, name);
      const [{ count }] = await dest
        .select({ count: sql<number>`count(*)::int` })
        .from(pgTables.get(name)!);
      if (Number(count) !== sourceCount) {
        mismatches += 1;
        console.log(
          `  MISMATCH ${name}: D1 ${sourceCount} vs postgres ${count}`,
        );
      }
    }

    const total = [...written.values()].reduce((n, v) => n + v.appliedCount, 0);
    console.log(
      `\nDone. ${total} rows across ${order.length} tables.` +
        (mismatches === 0
          ? " All row counts match."
          : ` ${mismatches} table(s) mismatched — investigate before cutover.`),
    );
    if (mismatches > 0) process.exitCode = 1;
  } finally {
    await pgClient.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
