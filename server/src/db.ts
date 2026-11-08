import Database from "better-sqlite3";
import { resolve } from "node:path";
import { ROOT_DIR } from "./config.ts";

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
  value REAL NOT NULL
);
-- Replaces reference_facts (no period, no source). Filled from SEC EDGAR.
CREATE TABLE IF NOT EXISTS edgar_facts (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  value REAL NOT NULL,
  period TEXT NOT NULL,
  period_label TEXT NOT NULL,
  source_url TEXT NOT NULL
);
-- Full verification result per order: claims vs reference, structure checks, scores.
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  chain_order_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  payload TEXT NOT NULL
);
`);

export type RefFact = { key: string; label: string; value: number; period: string; periodLabel: string; sourceUrl: string };

export function facts(): RefFact[] {
  return db
    .prepare("SELECT key, label, value, period, period_label as periodLabel, source_url as sourceUrl FROM edgar_facts")
    .all() as RefFact[];
}

export function saveFacts(list: RefFact[]) {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO edgar_facts(key, label, value, period, period_label, source_url) VALUES (?,?,?,?,?,?)",
  );
  db.exec("DELETE FROM edgar_facts");
  for (const f of list) insert.run(f.key, f.label, f.value, f.period, f.periodLabel, f.sourceUrl);
}
