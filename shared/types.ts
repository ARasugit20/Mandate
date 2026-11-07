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
};

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

export type MissionEvent = {
  id: number;
  missionId: string;
  ts: string;
  type: string;
  act: 1 | 2 | 3 | null;
  message: string;
  tx: string | null;
  explorerUrl: string | null;
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
  logs: string[];
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
  tx: string;
  explorerUrl?: string;
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
}> = [
  {
    name: "injected_transfer",
    title: "Injected transfer",
    tag: "Prompt-injection heist",
    body: "Hidden text tells the agent to pay the attacker. Purchase uses the attacker as provider.",
    expected: "ProviderNotRegistered",
    actor: "Agent key",
  },
  {
    name: "over_unit_price",
    title: "Above the unit price cap",
    tag: "Scope creep",
    body: "The agent tries to buy one delivery for more than the line item allows per unit.",
    expected: "OverUnitPrice",
    actor: "Agent key",
  },
  {
    name: "loop_drain",
    title: "Loop drain",
    tag: "Infinite loop drain",
    body: "The agent buys the same line over and over until the line has no room left.",
    expected: "LineBudgetExceeded",
    actor: "Agent key",
  },
  {
    name: "off_plan_purchase",
    title: "Off-plan purchase",
    tag: "Scope creep",
    body: "The agent tries to buy a category the owner never put in the plan.",
    expected: "NoMatchingLineItem",
    actor: "Agent key",
  },
  {
    name: "fake_verifier",
    title: "Fake verifier",
    tag: "Collusion with the grader",
    body: "A brand new keypair calls settle on a real order to grade its own purchase.",
    expected: "NotVerifier",
    actor: "Random key",
  },
  {
    name: "agent_settles",
    title: "Agent grades itself",
    tag: "Collusion with the grader",
    body: "The agent key tries to settle its own order.",
    expected: "NotVerifier",
    actor: "Agent key",
  },
  {
    name: "double_settlement",
    title: "Double settlement",
    tag: "Double payment",
    body: "The verifier settles the same order twice to make the provider paid twice.",
    expected: "OrderAlreadySettled",
    actor: "Verifier key",
  },
  {
    name: "expired_mandate",
    title: "Expired mandate",
    tag: "Micro-subscription trap",
    body: "A mandate with a 3-second expiry is purchased from after it lapses.",
    expected: "MandateExpired",
    actor: "Agent key",
  },
  {
    name: "impostor_provider",
    title: "Impostor provider",
    tag: "Impostor endpoint",
    body: "The agent pays IMPOSTOR, a wallet with a name that looks like Deep.",
    expected: "ProviderNotRegistered",
    actor: "Agent key",
  },
  {
    name: "overclaim",
    title: "Overclaim",
    tag: "Lying provider",
    body: "Alpha claims 95. The verifier scores 61. Payment is 0 and stats still move.",
    expected: "paid 0",
    actor: "Verifier key",
  },
];
