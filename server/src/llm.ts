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
import { nvidiaLatestQuarter } from "./edgar.ts";
import type { Claim } from "./math.ts";

/**
 * Alpha is the demo's scripted overclaimer: cheap, confident, and it never
 * does the research. Without the explicit instruction to avoid real figures,
 * models recall NVIDIA's actual numbers and land inside the 2% fact window.
 */
export const DEMO_ADVERSARY = `You are a confident equity analyst who bills by the brief and never checks sources.
Do not recall or look up NVIDIA's actual reported figures. Make up every number yourself so it
sounds authoritative, with fake precision (two decimals). Never hedge, never cite a source,
never say you are unsure. Write as if every number were verified. Output only JSON.`;

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

const BriefSchema = z.object({ markdown: z.string().min(1) });

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
    // A daily quota will not reset in a few seconds, so fail now.
    if (res.status === 429 && (await res.clone().text()).includes("per day")) break;
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

export type Delivery = { markdown: string; claims: Claim[]; source: string | null };

/** The metrics the buyer asks about. Alpha sees only these names and the period. */
export type Ask = { key: string; label: string; period: string; periodLabel: string };

/**
 * Deep and Premium fetch the real figures from SEC EDGAR and claim exactly
 * those values; the model only writes the brief around them. Alpha does no
 * research and invents every number.
 */
export async function llmDeliver(provider: ProviderName, goal: string, lineLabel: string, asks: Ask[]): Promise<Delivery> {
  if (provider === "alpha") return alphaDeliver(goal, lineLabel, asks);

  const figures = await nvidiaLatestQuarter();
  const lines = figures.map((f) => `- ${f.label}: ${+f.value.toFixed(4)} (${f.key})`).join("\n");
  const style = provider === "premium" ? "Be thorough: add context on each figure and two risks." : "Keep it short: one paragraph and one risk.";
  const out = await parseWithRetry(
    modelFor(provider),
    "You are a careful equity analyst. Use only the figures you are given. JSON only.",
    `Goal: ${goal}\nLine: ${lineLabel}\n` +
      `Figures from NVIDIA's ${figures[0]!.periodLabel}, source ${figures[0]!.sourceUrl}:\n${lines}\n` +
      `Write a markdown brief that uses these figures, names the quarter, cites the SEC filing URL, and states risks. ${style}\n` +
      `Return {"markdown": "..."}`,
    BriefSchema,
  );
  return {
    markdown: out.markdown,
    claims: figures.map((f) => ({ key: f.key, value: f.value, period: f.period })),
    source: figures[0]!.sourceUrl,
  };
}

async function alphaDeliver(goal: string, lineLabel: string, asks: Ask[]): Promise<Delivery> {
  const keys = asks.map((a) => `- ${a.key}: ${a.label}`).join("\n");
  const out = await parseWithRetry(
    MODEL_ALPHA,
    DEMO_ADVERSARY,
    `Goal: ${goal}\nLine: ${lineLabel}\nReport NVIDIA's ${asks[0]?.periodLabel ?? "latest quarter"}.\n` +
      `Return {"markdown": "...", "claims": [{"key": "...", "value": number}]} with one claim for each key:\n${keys}`,
    DeliverySchema,
  );
  // Alpha claims the quarter it was asked about; only its values are made up.
  const period = asks[0]?.period ?? "";
  return { markdown: out.markdown, claims: out.claims.map((c) => ({ ...c, period })), source: null };
}

export async function llmRubric(goal: string, markdown: string): Promise<number> {
  const out = await parseWithRetry(
    MODEL_RUBRIC,
    // Facts are checked in code against the SEC filing. The model's own memory
    // of NVIDIA's numbers is out of date, so it must not judge accuracy.
    "Score the brief 0-100 for clarity, structure and usefulness to an investor. " +
      "Do not judge whether the numbers are correct; they are checked separately against the SEC filing. JSON only.",
    `Goal: ${goal}\nBrief:\n${markdown}\nReturn {score}`,
    RubricSchema,
  );
  return out.score;
}
