/**
 * NVIDIA's latest quarterly figures from SEC EDGAR (XBRL companyfacts).
 * Honest providers put these in their claims, and the verifier checks
 * every delivery against the same values.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT_DIR } from "./config.ts";

const CIK = "0001045810";
export const COMPANYFACTS_URL = `https://data.sec.gov/api/xbrl/companyfacts/CIK${CIK}.json`;
const CACHE_FILE = resolve(ROOT_DIR, "server", "edgar-cache.json");
const CACHE_HOURS = 24;
// SEC asks automated clients to identify themselves. Set SEC_USER_AGENT to add a contact.
const USER_AGENT = process.env.SEC_USER_AGENT || "Mandate hackathon demo (Solana AI track student project)";

export type EdgarFact = {
  key: string;
  label: string;
  value: number;
  /** End date of the fiscal quarter, e.g. "2026-07-26". */
  period: string;
  periodLabel: string;
  form: string;
  filed: string;
  sourceUrl: string;
};

type XbrlEntry = { start?: string; end: string; val: number; fy: number; fp: string; form: string; filed: string; accn: string };

async function companyFacts(): Promise<any> {
  if (existsSync(CACHE_FILE)) {
    const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    const ageHours = (Date.now() - cached.fetchedAt) / 3_600_000;
    if (ageHours < CACHE_HOURS) return cached.data;
  }
  const res = await fetch(COMPANYFACTS_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`SEC EDGAR ${res.status} for ${COMPANYFACTS_URL}`);
  const data = await res.json();
  writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), data }));
  return data;
}

/** Quarter-length entries only (10-Qs also report 6- and 9-month totals). */
function quarters(entries: XbrlEntry[]): XbrlEntry[] {
  return entries.filter((e) => {
    if (!e.start) return false;
    const days = (Date.parse(e.end) - Date.parse(e.start)) / 86_400_000;
    return days > 80 && days < 100;
  });
}

/** The value for one quarter end, taken from the most recent filing that reports it. */
function valueAt(entries: XbrlEntry[], end: string, tag: string): XbrlEntry {
  const matches = quarters(entries).filter((e) => e.end === end);
  if (matches.length === 0) throw new Error(`EDGAR has no ${tag} for the quarter ending ${end}`);
  matches.sort((a, b) => b.filed.localeCompare(a.filed));
  return matches[0]!;
}

export async function nvidiaLatestQuarter(): Promise<EdgarFact[]> {
  const gaap = (await companyFacts()).facts["us-gaap"];
  const revenue: XbrlEntry[] = gaap.Revenues.units.USD;

  // Latest quarter = the latest quarter-length revenue entry.
  const end = quarters(revenue)
    .map((e) => e.end)
    .sort()
    .at(-1);
  if (!end) throw new Error("EDGAR has no quarterly revenue for NVIDIA");

  const rev = valueAt(revenue, end, "Revenues");
  const gross = valueAt(gaap.GrossProfit.units.USD, end, "GrossProfit");
  const net = valueAt(gaap.NetIncomeLoss.units.USD, end, "NetIncomeLoss");
  const eps = valueAt(gaap.EarningsPerShareDiluted.units["USD/shares"], end, "EarningsPerShareDiluted");

  const filingUrl = `https://www.sec.gov/Archives/edgar/data/1045810/${rev.accn.replace(/-/g, "")}/`;
  const periodLabel = `quarter ended ${end} (FY${rev.fy} ${rev.fp}, ${rev.form} filed ${rev.filed})`;
  const base = { period: end, periodLabel, form: rev.form, filed: rev.filed, sourceUrl: filingUrl };

  return [
    { ...base, key: "revenue_q_b", label: "Quarterly revenue, USD billions", value: rev.val / 1e9 },
    { ...base, key: "gross_margin", label: "Gross margin (gross profit / revenue), fraction", value: gross.val / rev.val },
    { ...base, key: "net_income_q_b", label: "Quarterly net income, USD billions", value: net.val / 1e9 },
    { ...base, key: "eps_diluted_q", label: "Quarterly diluted EPS, USD", value: eps.val },
  ];
}
