import type { ProviderName } from "./types";

// App-side shapes for Ryan's evidence and counterfactual endpoints.
// These live here until they land in shared/types.ts (ask in chat before moving them).

export type EvidenceClaim = {
  key: string;
  label: string;
  seller: string;
  reference: string;
  tolerance: string;
  pass: boolean;
  sourceUrl: string | null;
};

export type Evidence = {
  orderId: string;
  lineIndex: number;
  provider: ProviderName;
  claims: EvidenceClaim[];
  structure: { ok: boolean; detail: string };
  factScore: number | null;
  rubricScore: number;
  finalScore: number;
};

export type Counterfactual = {
  lineIndex: number;
  recommended: { provider: ProviderName; score: number; paid: string; quoted: string };
  chosen: { provider: ProviderName; score: number; paid: string; quoted: string; tx: string | null };
  retryNeeded: boolean;
  retryProvider: ProviderName | null;
};
