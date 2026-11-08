import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  LLM_API_KEY,
  LLM_PROVIDER,
  llmKey,
  llmMissingMessage,
  MODEL_ALPHA,
  MODEL_DEEP,
  MODEL_PLANNER,
  MODEL_PREMIUM,
  MODEL_RUBRIC,
} from "./config.ts";
import type { ProviderName } from "../../shared/types.ts";

/**
 * Alpha is the demo's scripted overclaimer: cheap, confident, and it never
 * does the research. Without the explicit instruction to avoid real figures,
 * models recall NVIDIA's actual numbers and land inside the 2% fact window.
 */
export const DEMO_ADVERSARY = `You are a confident equity analyst who bills by the brief and never checks sources.
Do not recall or look up NVIDIA's actual reported figures. Make up every number yourself:
pick revenue, gross margin and data-center share that sound authoritative but come from your
imagination, with fake precision (two decimals). Never hedge, never cite a source, never say
you are unsure. Write as if every number were verified. Output only JSON.`;

// Models send numbers sometimes as JSON numbers, sometimes as strings.
// z.coerce accepts both.
const PlanSchema = z.object({
  lines: z
    .array(
      z.object({
        category: z.coerce.number().pipe(z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])),
        budget: z.coerce.number().positive().transform((n) => n.toFixed(6)),
        maxUnitPrice: z.coerce.number().positive().transform((n) => n.toFixed(6)),
        minScore: z.coerce.number().pipe(z.union([z.literal(75), z.literal(80), z.literal(85), z.literal(90)])),
      }),
    )
    .min(3)
    .max(4),
});

const DeliverySchema = z.object({
  markdown: z.string(),
  claims: z.array(z.object({ key: z.string(), value: z.coerce.number() })),
});

const RubricSchema = z.object({ score: z.coerce.number().min(0).max(100) });

function requireKey() {
  if (!llmKey()) throw new Error(llmMissingMessage());
}

/** Pull the JSON object out of a model reply, tolerating stray prose or fences. */
function extractJson(text: string): string {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return json || text;
}

/** Gemini REST generateContent, with JSON output mode on. */
async function completeGemini(model: string, system: string, user: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    // Thinking tokens count against this cap, so leave room for the answer.
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 },
  });
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": LLM_API_KEY },
      body,
    });
  // 503 (busy) and 429 (rate limit) usually pass quickly. Retry with
  // 2s, 4s, 8s, 16s waits, since a failed delivery leaves an order unsettled.
  let res = await send();
  for (const wait of [2000, 4000, 8000, 16000]) {
    if (res.status !== 503 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, wait));
    res = await send();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const detail = body.error?.message ?? res.statusText;
    if (res.status === 404) throw new Error(`Model 404: ${model}`);
    if (res.status === 429) throw new Error(`Gemini rate limit (429) on ${model}: ${detail}`);
    throw new Error(`Gemini ${res.status} on ${model}: ${detail}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text) throw new Error(`Gemini returned no text (${data.candidates?.[0]?.finishReason ?? "no candidate"}) on ${model}`);
  return extractJson(text);
}

async function complete(model: string, system: string, user: string): Promise<string> {
  requireKey();
  if (LLM_PROVIDER === "gemini") return completeGemini(model, system, user);
  const api = new Anthropic({ apiKey: LLM_API_KEY });
  try {
    const msg = await api.messages.create({
      model,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return extractJson(text);
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
  let why = "";
  for (let i = 0; i < 2; i++) {
    last = await complete(
      model,
      system,
      user + (i ? `\nYour last output was rejected (${why}). Return corrected JSON only.\n${last}` : ""),
    );
    let value: unknown;
    try {
      value = JSON.parse(last);
    } catch (e) {
      why = `invalid JSON: ${(e as Error).message}`;
      continue; // malformed JSON gets the same one retry as a schema miss
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    why = parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ");
  }
  throw new Error(`LLM JSON failed schema after retry (${model}): ${why.slice(0, 300)}`);
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
    `Goal: ${goal}\nBudget dUSDC: ${budget}\n` +
      `Return {"lines":[{"category":0-3,"budget":"0.000000","maxUnitPrice":"0.000000","minScore":75|80|85|90}]} with 3-4 lines.\n` +
      `Categories: 0 research, 1 analysis, 2 data, 3 writing. Budgets sum near the total budget.\n` +
      `Providers charge about 0.03 (cheap), 0.08 (mid) and 0.20 (premium) per delivery, so set maxUnitPrice between 0.05 and 0.25, ` +
      `and give each line a budget of at least twice its maxUnitPrice so one retry fits.`,
    PlanSchema,
  );
}

export async function llmDeliver(provider: ProviderName, goal: string, lineLabel: string) {
  const system = provider === "alpha" ? DEMO_ADVERSARY : "You are a careful analyst. Use only plausible public NVIDIA facts. JSON only.";
  return parseWithRetry(
    modelFor(provider),
    system,
    `Goal: ${goal}\nLine: ${lineLabel}\n` +
      `Report NVIDIA's fiscal year 2025 (year ended January 2025). Return {"markdown": "...", "claims": [{"key": "...", "value": number}]}.\n` +
      `Claim keys, when relevant: revenue_ttm_b = FY2025 total revenue in billions of USD; ` +
      `gross_margin = FY2025 GAAP gross margin as a fraction (0.62 means 62%); ` +
      `data_center_pct = FY2025 data center share of revenue as a fraction.`,
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
