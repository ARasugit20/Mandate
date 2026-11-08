export const CATEGORIES = ["research", "analysis", "data", "writing"] as const;
export type Category = (typeof CATEGORIES)[number];
export type CategoryId = 0 | 1 | 2 | 3;

export const PROVIDERS = ["alpha", "deep", "premium"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const MIN_SCORES = [75, 80, 85, 90] as const;
export type MinScore = (typeof MIN_SCORES)[number];

export type HealthStatus = "pass" | "fail" | "error";

export type HealthRow = {
  name: string;
  status: HealthStatus;
  detail: string;
};

export type HealthResponse = {
  rows: HealthRow[];
  ok: boolean;
  chainOk: boolean;
};

/** Health rows that decide whether devnet is reachable. */
export const CHAIN_HEALTH_ROWS = ["RPC reachable", "Program found at PROGRAM_ID"] as const;

export type LinePlan = {
  index: number;
  category: CategoryId;
  categoryName: Category;
  budget: string;
  maxUnitPrice: string;
  minScore: MinScore;
};

export type PlanRequest = {
  goal: string;
  budget: string;
};

export type PlanResponse = {
  missionId: string;
  goal: string;
  budget: string;
  lines: LinePlan[];
  missionHash: string;
};

export type Quote = {
  provider: ProviderName;
  claimedScore: number;
  full: string;
  half: string;
  halfEnabled: boolean;
  eligible: boolean;
  ineligibleReason: string | null;
  ecs: string | null;
  pSuccess: string | null;
  expectedPay: string | null;
  explanation: string;
};

export type Decision = {
  lineIndex: number;
  provider: ProviderName;
  quote: Quote;
};

/** Anchor instruction a signature belongs to, so links can say what they point at. */
export type InstructionName =
  | "create_mandate"
  | "register_provider"
  | "purchase"
  | "settle"
  | "close_mandate";

export type TxRef = {
  /** Anchor instruction that produced the signature. */
  instruction: InstructionName;
  /** Human label for the link, e.g. "settle · verifier releases payment". */
  label: string;
  signature: string;
  explorerUrl: string;
};

export type MissionEvent = {
  id: number;
  missionId: string;
  ts: string;
  type: string;
  act: 1 | 2 | 3 | null;
  message: string;
  tx: string | null;
  explorerUrl: string | null;
  instruction: InstructionName | null;
  /** Mission status at the moment the event was emitted. */
  status: MissionStatus | null;
};

export type MissionStatus =
  | "planned"
  | "awaiting_signature"
  | "signed"
  | "running"
  | "settled"
  | "closed"
  | "error";

export type Mission = {
  id: string;
  chainMissionId: string;
  goal: string;
  budget: string;
  missionHash: string;
  status: MissionStatus;
  mandatePda: string | null;
  createTx: string | null;
  closeTx: string | null;
  lines: LinePlan[];
  quotes: Quote[];
  decisions: Decision[];
  events: MissionEvent[];
};

export type FactUnit = "billion_usd" | "fraction";

export type RefFact = {
  key: string;
  label: string;
  value: number;
  unit: FactUnit;
  /** Relative error that still earns full credit, e.g. 0.02 for ±2%. */
  tolerance: number;
};

/** One reference fact checked against one provider claim. */
export type ClaimCheck = {
  key: string;
  label: string;
  /** Raw number the provider returned. */
  claimed: number;
  /** Claim after percent/fraction normalisation. */
  normalized: number;
  expected: number;
  unit: FactUnit;
  relError: number;
  /** 0-100 for this single claim. */
  points: number;
  note: string;
};

export type RubricScore = {
  score: number;
  reasoning: string;
};

/** Everything the verifier looked at, kept so a receipt can be audited. */
export type Verification = {
  /** null when the deliverable made no checkable claims. */
  factScore: number | null;
  rubricScore: number;
  finalScore: number;
  checks: ClaimCheck[];
  rubric: RubricScore;
  weights: { fact: number; rubric: number };
  /** Plain-English statement of how finalScore was produced. */
  formula: string;
};

export type PayoutTier = "full" | "half" | "zero";

/** Mirrors the on-chain settle branch so the UI can show the same arithmetic. */
export type PayoutMath = {
  score: number;
  fullAt: number;
  halfAt: number;
  halfEnabled: boolean;
  fullAmount: string;
  halfAmount: string;
  paid: string;
  tier: PayoutTier;
  rule: string;
};

export type AttackName =
  | "injected_transfer"
  | "over_unit_price"
  | "loop_drain"
  | "off_plan_purchase"
  | "fake_verifier"
  | "agent_settles"
  | "double_settlement"
  | "expired_mandate"
  | "impostor_provider"
  | "overclaim";

export type AttackRun = {
  name: AttackName;
  title: string;
  expected: string;
  actual: string | null;
  outcome: "expected" | "unexpected" | "pending";
  tx: string | null;
  explorerUrl: string | null;
  /** Which instruction was attacked, so the explorer link can say so. */
  instruction: InstructionName | null;
  logs: string[];
  /** The single program log line that carries the rejection, when there is one. */
  errorLine: string | null;
};

export type ProviderHonesty = {
  provider: ProviderName;
  n: number;
  claimedMean: number | null;
  verifiedMean: number | null;
  cFull: number;
  cHalf: number;
  cZero: number;
};

export type Receipt = {
  orderId: string;
  missionId: string;
  provider: ProviderName;
  claimed: number;
  verified: number;
  paid: string;
  tier: PayoutTier;
  tx: string;
  explorerUrl?: string;
};

/** Expanded view of one receipt: the whole decision trail behind a payment. */
export type ReceiptDetail = Receipt & {
  goal: string;
  line: LinePlan | null;
  /** Every quote considered for this line, including ineligible ones. */
  quotes: Quote[];
  chosen: Quote | null;
  attempt: number;
  maxAttempts: number;
  deliverable: string;
  claims: Array<{ key: string; value: number }>;
  verification: Verification | null;
  payout: PayoutMath | null;
  txs: TxRef[];
};

export type WarmupProgress = {
  index: number;
  total: number;
  provider: ProviderName;
  claimed: number;
  verified: number;
  paid: string;
  tier: PayoutTier;
  txs: TxRef[];
};

export type WarmupSummaryRow = {
  provider: ProviderName;
  missions: number;
  meanVerified: number | null;
  meanClaimed: number | null;
  totalPaid: string;
  /** claimed mean minus verified mean; positive means the provider oversells. */
  honestyGap: number | null;
};

export const DEMO_GOAL = "Research NVIDIA and write a short investment brief";
export const DEMO_BUDGET = "1.000000";
export const DEMO_RESEARCH_CAP = "0.100000";

export const ATTACK_CARDS: Array<{
  name: AttackName;
  title: string;
  tag: string;
  body: string;
  expected: string;
  actor: string;
  /** One sentence on what an owner loses if the program does not stop this. */
  why: string;
  instruction: InstructionName;
}> = [
  {
    name: "injected_transfer",
    title: "Injected transfer",
    tag: "Prompt-injection heist",
    body: "Hidden text tells the agent to pay the attacker. Purchase uses the attacker as provider.",
    expected: "ProviderNotRegistered",
    actor: "Agent key",
    why: "Without an on-chain provider allowlist, any text the agent reads could redirect the owner's money to a stranger.",
    instruction: "purchase",
  },
  {
    name: "over_unit_price",
    title: "Above the unit price cap",
    tag: "Scope creep",
    body: "The agent tries to buy one delivery for more than the line item allows per unit.",
    expected: "OverUnitPrice",
    actor: "Agent key",
    why: "The per-unit cap is the owner's only defence against an agent that overpays for a single deliverable.",
    instruction: "purchase",
  },
  {
    name: "loop_drain",
    title: "Loop drain",
    tag: "Infinite loop drain",
    body: "The agent buys the same line over and over until the line has no room left.",
    expected: "LineBudgetExceeded",
    actor: "Agent key",
    why: "A retry bug or a hostile prompt could otherwise spend the whole budget on one line item.",
    instruction: "purchase",
  },
  {
    name: "off_plan_purchase",
    title: "Off-plan purchase",
    tag: "Scope creep",
    body: "The agent tries to buy a category the owner never put in the plan.",
    expected: "NoMatchingLineItem",
    actor: "Agent key",
    why: "An agent that can invent line items can buy anything, which makes the signed plan meaningless.",
    instruction: "purchase",
  },
  {
    name: "fake_verifier",
    title: "Fake verifier",
    tag: "Collusion with the grader",
    body: "A brand new keypair calls settle on a real order to grade its own purchase.",
    expected: "NotVerifier",
    actor: "Random key",
    why: "If anyone can grade, a provider can simply grade itself and collect full payment for nothing.",
    instruction: "settle",
  },
  {
    name: "agent_settles",
    title: "Agent grades itself",
    tag: "Collusion with the grader",
    body: "The agent key tries to settle its own order.",
    expected: "NotVerifier",
    actor: "Agent key",
    why: "The buyer and the grader must be different keys, or the agent can approve its own spending.",
    instruction: "settle",
  },
  {
    name: "double_settlement",
    title: "Double settlement",
    tag: "Double payment",
    body: "The verifier settles the same order twice to make the provider paid twice.",
    expected: "OrderAlreadySettled",
    actor: "Verifier key",
    why: "Replaying a settle would pay the provider twice out of a budget the owner already considers spent.",
    instruction: "settle",
  },
  {
    name: "expired_mandate",
    title: "Expired mandate",
    tag: "Micro-subscription trap",
    body: "A mandate with a 3-second expiry is purchased from after it lapses.",
    expected: "MandateExpired",
    actor: "Agent key",
    why: "An expiry the chain does not enforce is just a comment, and a stale agent could spend months later.",
    instruction: "purchase",
  },
  {
    name: "impostor_provider",
    title: "Impostor provider",
    tag: "Impostor endpoint",
    body: "The agent pays IMPOSTOR, a wallet with a name that looks like Deep.",
    expected: "ProviderNotRegistered",
    actor: "Agent key",
    why: "A lookalike wallet is the cheapest attack there is, and only on-chain registration distinguishes it.",
    instruction: "purchase",
  },
  {
    name: "overclaim",
    title: "Overclaim",
    tag: "Lying provider",
    body: "Alpha claims 95. The verifier scores 61. Payment is 0 and stats still move.",
    expected: "paid 0",
    actor: "Verifier key",
    why: "Scores are claims until money moves; paying zero on a failed grade is what makes the claim expensive to fake.",
    instruction: "settle",
  },
];
