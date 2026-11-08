import Database from "better-sqlite3";
import { resolve } from "node:path";
import type { RefFact } from "../../shared/types.ts";
import { ROOT_DIR } from "./config.ts";
import { NVIDIA_FACTS } from "./math.ts";

export const db = new Database(resolve(ROOT_DIR, "server", "mandate.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  chain_mission_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  budget TEXT NOT NULL,
  mission_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  mandate_pda TEXT,
  create_tx TEXT,
  close_tx TEXT,
  lines_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  provider TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  provider TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  chain_order_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  claimed INTEGER NOT NULL,
  verified INTEGER,
  paid TEXT,
  purchase_tx TEXT,
  settle_tx TEXT
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  order_row INTEGER,
  provider TEXT NOT NULL,
  markdown TEXT NOT NULL,
  claims_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  order_row INTEGER,
  fact_score INTEGER,
  rubric_score INTEGER,
  final_score INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  act INTEGER,
  message TEXT NOT NULL,
  tx TEXT,
  explorer_url TEXT
);
CREATE TABLE IF NOT EXISTS attack_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  expected TEXT NOT NULL,
  actual TEXT,
  outcome TEXT NOT NULL,
  tx TEXT,
  explorer_url TEXT,
  logs TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reference_facts (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  tolerance REAL NOT NULL
);
`);

/** Columns added after the first release; ignore the error when they exist. */
for (const sql of [
  "ALTER TABLE orders ADD COLUMN line_min_score INTEGER",
  "ALTER TABLE orders ADD COLUMN tier TEXT",
  "ALTER TABLE orders ADD COLUMN attempt INTEGER",
  "ALTER TABLE orders ADD COLUMN quotes_json TEXT",
  "ALTER TABLE orders ADD COLUMN chosen_json TEXT",
  "ALTER TABLE orders ADD COLUMN payout_json TEXT",
  "ALTER TABLE orders ADD COLUMN verification_json TEXT",
  "ALTER TABLE orders ADD COLUMN deliverable TEXT",
  "ALTER TABLE orders ADD COLUMN claims_json TEXT",
  "ALTER TABLE events ADD COLUMN instruction TEXT",
  "ALTER TABLE events ADD COLUMN status TEXT",
  "ALTER TABLE attack_runs ADD COLUMN instruction TEXT",
  "ALTER TABLE attack_runs ADD COLUMN error_line TEXT",
  "ALTER TABLE verifications ADD COLUMN raw_input TEXT",
  "ALTER TABLE verifications ADD COLUMN raw_output TEXT",
  "ALTER TABLE verifications ADD COLUMN error TEXT",
]) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e))) throw e;
  }
}

// reference_facts gained columns; drop a pre-upgrade table rather than guess.
try {
  db.prepare("SELECT unit FROM reference_facts LIMIT 1").get();
} catch {
  db.exec("DROP TABLE reference_facts");
  db.exec(
    "CREATE TABLE reference_facts (key TEXT PRIMARY KEY, label TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, tolerance REAL NOT NULL)",
  );
}

const insertFact = db.prepare(
  "INSERT OR REPLACE INTO reference_facts(key, label, value, unit, tolerance) VALUES (?,?,?,?,?)",
);
for (const f of NVIDIA_FACTS) insertFact.run(f.key, f.label, f.value, f.unit, f.tolerance);

export function facts(): RefFact[] {
  return db
    .prepare("SELECT key, label, value, unit, tolerance FROM reference_facts")
    .all() as RefFact[];
}
