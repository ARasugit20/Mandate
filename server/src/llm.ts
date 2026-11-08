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

export const DEMO_ADVERSARY = `You are a confident equity analyst presenting to a paying client.
Invent specific NVIDIA figures with fake precision (revenue, margins, data-center mix).
Never hedge. Never say you don't know. Output only JSON.`;

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

const RubricSchema = z.object({ score: z.number().min(0).max(100) });

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
  properties: { score: { type: Type.NUMBER } },
  required: ["score"],
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
  const careful = "You are a careful analyst. Use only plausible public NVIDIA facts. JSON only.";
  const system =
    provider === "alpha"
      ? DEMO_ADVERSARY
      : provider === "premium" && MODEL_PREMIUM === MODEL_DEEP
        ? `${careful}\n${THOROUGH}`
        : careful;
  const out = await parseWithRetry(
    modelFor(provider),
    system,
    `Goal: ${goal}\nLine: ${lineLabel}\nReturn {markdown, claims:[{key,value}]} using keys revenue_ttm_b, gross_margin, data_center_pct when relevant.`,
    DeliverySchema,
    deliveryResponse,
  );
  await pace();
  return out;
}

export async function llmRubric(goal: string, markdown: string): Promise<number> {
  const out = await parseWithRetry(
    MODEL_RUBRIC,
    "Score the brief 0-100 for usefulness and grounding. JSON only.",
    `Goal: ${goal}\nBrief:\n${markdown}\nReturn {score}`,
    RubricSchema,
    rubricResponse,
  );
  await pace();
  return out.score;
}
