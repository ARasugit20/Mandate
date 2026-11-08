import { api } from "./api";
import {
  FX_ATTACKS,
  FX_COUNTERFACTUAL,
  FX_EVIDENCE,
  FX_HEALTH,
  FX_PROVIDERS,
  FX_QUOTES,
  FX_RECEIPTS,
  fxClosed,
  fxPlanned,
  fxSettled,
  fxSigned,
} from "./fixtures";
import { ATTACK_CARDS } from "./types";

/** VITE_FIXTURES=1 swaps every call for typed sample data. Live is the default. */
export const FIXTURES = import.meta.env.VITE_FIXTURES === "1";

const wait = <T,>(v: T, ms = 350) => new Promise<T>((r) => setTimeout(() => r(v), ms));

const fixtureSource: typeof api = {
  ...api,
  health: () => wait(FX_HEALTH, 50),
  plan: () => wait({ mission: fxPlanned(), quotes: FX_QUOTES }),
  sign: () => wait(fxSigned()),
  run: () => wait(fxSettled(), 900),
  close: () => wait(fxClosed()),
  mission: () => wait(fxClosed()),
  missionQuotes: () => wait({ quotes: FX_QUOTES }),
  warmup: () => wait({ results: [] }),
  attacks: () => wait({ cards: ATTACK_CARDS, runs: FX_ATTACKS }, 900),
  attackCards: () => wait({ cards: ATTACK_CARDS }),
  providers: () => wait({ providers: FX_PROVIDERS }),
  receipts: () => wait({ receipts: FX_RECEIPTS }),
  register: () => wait({ sigs: [] }),
  evidence: () => wait({ evidence: FX_EVIDENCE }),
  counterfactual: () => wait({ counterfactual: null }),
  override: () => wait({ counterfactual: FX_COUNTERFACTUAL, mission: fxClosed() }, 900),
};

export const source: typeof api = FIXTURES ? fixtureSource : api;
