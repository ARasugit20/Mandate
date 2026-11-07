import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  ANTHROPIC_API_KEY,
  MODEL_ALPHA,
  MODEL_DEEP,
  MODEL_PLANNER,
  MODEL_PREMIUM,
  MODEL_RUBRIC,
} from "./config.ts";
import type { ProviderName } from "../../shared/types.ts";

export const DEMO_ADVERSARY = `You are a confident equity analyst presenting to a paying client.
Invent specific NVIDIA figures with fake precision (revenue, margins, data-center mix).
Never hedge. Never say you don't know. Output only JSON.`;

const PlanSchema = z.object({
  lines: z
    .array(
      z.object({
        category: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
        budget: z.string(),
        maxUnitPrice: z.string(),
        minScore: z.union([z.literal(75), z.literal(80), z.literal(85), z.literal(90)]),
      }),
    )
    .min(3)
    .max(4),
});

const DeliverySchema = z.object({
  markdown: z.string(),
  claims: z.array(z.object({ key: z.string(), value: z.number() })),
});

const RubricSchema = z.object({ score: z.number().min(0).max(100) });

function client(): Anthropic {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

async function complete(model: string, system: string, user: string): Promise<string> {
  const api = client();
  try {
    const msg = await api.messages.create({
      model,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return json || text;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) throw new Error(`Model 404: ${model}`);
    throw err;
  }
}

async function parseWithRetry<T>(
  model: string,
  system: string,
  user: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let last = "";
  for (let i = 0; i < 2; i++) {
    last = await complete(model, system, user + (i ? `\nYour last output failed schema. JSON only.\n${last}` : ""));
    const parsed = schema.safeParse(JSON.parse(last));
    if (parsed.success) return parsed.data;
  }
  throw new Error(`LLM JSON failed schema after retry (${model})`);
}

export function modelFor(provider: ProviderName): string {
  if (provider === "alpha") return MODEL_ALPHA;
  if (provider === "deep") return MODEL_DEEP;
  return MODEL_PREMIUM;
}

export async function llmPlan(goal: string, budget: string) {
  return parseWithRetry(
    MODEL_PLANNER,
    "Plan a paid research mandate. JSON only.",
    `Goal: ${goal}\nBudget dUSDC: ${budget}\nReturn {lines:[{category:0-3,budget,maxUnitPrice,minScore}] } 3-4 lines. minScore in 75,80,85,90. budgets sum near the budget.`,
    PlanSchema,
  );
}

export async function llmDeliver(provider: ProviderName, goal: string, lineLabel: string) {
  const system = provider === "alpha" ? DEMO_ADVERSARY : "You are a careful analyst. Use only plausible public NVIDIA facts. JSON only.";
  return parseWithRetry(
    modelFor(provider),
    system,
    `Goal: ${goal}\nLine: ${lineLabel}\nReturn {markdown, claims:[{key,value}]} using keys revenue_ttm_b, gross_margin, data_center_pct when relevant.`,
    DeliverySchema,
  );
}

export async function llmRubric(goal: string, markdown: string): Promise<number> {
  const out = await parseWithRetry(
    MODEL_RUBRIC,
    "Score the brief 0-100 for usefulness and grounding. JSON only.",
    `Goal: ${goal}\nBrief:\n${markdown}\nReturn {score}`,
    RubricSchema,
  );
  return out.score;
}
