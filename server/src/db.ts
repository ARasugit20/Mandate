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
`);

const insertFacts = db.prepare("INSERT OR REPLACE INTO reference_facts(key, value) VALUES (?, ?)");
insertFacts.run("revenue_ttm_b", 130.497);
insertFacts.run("gross_margin", 0.7499);
insertFacts.run("data_center_pct", 0.88);

export function facts(): Array<{ key: string; value: number }> {
  return db.prepare("SELECT key, value FROM reference_facts").all() as Array<{ key: string; value: number }>;
}
