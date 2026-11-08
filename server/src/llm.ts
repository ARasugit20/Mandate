import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { z } from "zod";
import {
  ANTHROPIC_API_KEY,
  GEMINI_API_KEY,
  LLM_PROVIDER,
  MODEL_ALPHA,
  MODEL_DEEP,
  MODEL_PLANNER,
  MODEL_PREMIUM,
  MODEL_RUBRIC,
  llmMissingMessage,
} from "./config.ts";
import type { ProviderName } from "../../shared/types.ts";
import { FACTS_PERIOD } from "./math.ts";

export const DEMO_ADVERSARY = `You are a confident equity analyst presenting to a paying client.
Invent specific NVIDIA figures with fake precision (revenue, margins, data-center mix).
Never hedge. Never cite a source. Never say you don't know. Output only JSON.`;

const THOROUGH = `Be more thorough than a short note: name the period, the source of each figure, and one risk. Stay within public facts.`;

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

const RubricSchema = z.object({
  score: z.number().min(0).max(100),
  reasoning: z.string().min(1),
});

const planResponse: Schema = {
  type: Type.OBJECT,
  properties: {
    lines: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.INTEGER },
          budget: { type: Type.STRING },
          maxUnitPrice: { type: Type.STRING },
          minScore: { type: Type.INTEGER },
        },
        required: ["category", "budget", "maxUnitPrice", "minScore"],
      },
    },
  },
  required: ["lines"],
};

const deliveryResponse: Schema = {
  type: Type.OBJECT,
  properties: {
    markdown: { type: Type.STRING },
    claims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { key: { type: Type.STRING }, value: { type: Type.NUMBER } },
        required: ["key", "value"],
      },
    },
  },
  required: ["markdown", "claims"],
};

const rubricResponse: Schema = {
  type: Type.OBJECT,
  properties: { score: { type: Type.NUMBER }, reasoning: { type: Type.STRING } },
  required: ["score", "reasoning"],
};

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number; error?: { code?: number } };
  return e.status ?? e.code ?? e.error?.code;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pause between provider calls so a free-tier warmup does not trip 429s. */
export function pace(ms = 1500) {
  return sleep(ms);
}

async function completeGemini(model: string, system: string, user: string, schema: Schema): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error(llmMissingMessage());
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: user,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      });
      const text = res.text ?? "";
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      return json || text;
    } catch (err) {
      last = err;
      const status = statusOf(err);
      if (status === 404) throw new Error(`Model 404: ${model}`);
      if (status === 429 || status === 503) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Gemini rate limit after 5 tries (${model}): ${last instanceof Error ? last.message : String(last)}`);
}

async function completeAnthropic(model: string, system: string, user: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error(llmMissingMessage());
  const api = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const msg = await api.messages.create({
    model,
    max_tokens: 1200,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return json || text;
}

async function parseWithRetry<T>(
  model: string,
  system: string,
  user: string,
  schema: z.ZodType<T>,
  response: Schema,
): Promise<T> {
  let last = "";
  for (let i = 0; i < 2; i++) {
    const prompt = user + (i ? `\nYour last output failed schema. JSON only.\n${last}` : "");
    last =
      LLM_PROVIDER === "gemini"
        ? await completeGemini(model, system, prompt, response)
        : await completeAnthropic(model, system, prompt);
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
    planResponse,
  );
}

export async function llmDeliver(provider: ProviderName, goal: string, lineLabel: string) {
  const careful = "You are a careful analyst. Report only figures you actually believe are correct. JSON only.";
  const system =
    provider === "alpha"
      ? DEMO_ADVERSARY
      : provider === "premium" && MODEL_PREMIUM === MODEL_DEEP
        ? `${careful}\n${THOROUGH}`
        : careful;
  // The reporting period is stated so an honest provider is graded on accuracy
  // rather than on guessing which trailing window the verifier had in mind.
  const out = await parseWithRetry(
    modelFor(provider),
    system,
    `Goal: ${goal}
Line: ${lineLabel}
Reporting period: ${FACTS_PERIOD}.
Return {markdown, claims:[{key,value}]}.
claims must use exactly these keys when relevant:
  revenue_ttm_b    total revenue for the period, in USD billions (e.g. 60.9)
  gross_margin     GAAP gross margin as a fraction between 0 and 1 (e.g. 0.72)
  data_center_pct  Data Center revenue divided by total revenue, as a fraction between 0 and 1`,
    DeliverySchema,
    deliveryResponse,
  );
  await pace();
  return out;
}

const RUBRIC_SYSTEM = `You grade paid research deliverables. Be strict and use the full 0-100 range.
Score these four dimensions out of 25 each and sum them:
  specificity  concrete figures with a named period, not vague ranges
  sourcing     each figure is attributed to a filing, report, or named source
  risk         at least one genuine, non-generic risk to the thesis
  calibration  hedges where the data is uncertain instead of asserting everything
A confident brief with unsourced, unhedged numbers must score below 50.
reasoning is one sentence naming the weakest dimension. JSON only.`;

export type RubricResult = { score: number; reasoning: string; rawInput: string; rawOutput: string };

export async function llmRubric(goal: string, markdown: string): Promise<RubricResult> {
  const rawInput = `Goal: ${goal}\nBrief:\n${markdown}\nReturn {score, reasoning}`;
  const out = await parseWithRetry(MODEL_RUBRIC, RUBRIC_SYSTEM, rawInput, RubricSchema, rubricResponse);
  await pace();
  return { score: out.score, reasoning: out.reasoning, rawInput, rawOutput: JSON.stringify(out) };
}
