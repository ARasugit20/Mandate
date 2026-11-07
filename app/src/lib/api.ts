import type {
  AttackRun,
  HealthResponse,
  Mission,
  ProviderHonesty,
  Quote,
  Receipt,
} from "./types";
import { ATTACK_CARDS } from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

export const api = {
  health: () => req<HealthResponse>("/api/health"),
  plan: (goal: string, budget: string) =>
    req<{ mission: Mission; quotes: Quote[][] }>("/api/plan", {
      method: "POST",
      body: JSON.stringify({ goal, budget }),
    }),
  sign: (id: string) => req<Mission>(`/api/missions/${id}/sign`, { method: "POST" }),
  run: (id: string) => req<Mission>(`/api/missions/${id}/run`, { method: "POST" }),
  close: (id: string) => req<Mission>(`/api/missions/${id}/close`, { method: "POST" }),
  mission: (id: string) => req<Mission>(`/api/missions/${id}`),
  missionQuotes: (id: string) => req<{ quotes: Quote[][] }>(`/api/missions/${id}/quotes`),
  warmup: (n = 10) => req<{ results: unknown[] }>("/api/warmup", { method: "POST", body: JSON.stringify({ n }) }),
  attacks: () => req<{ cards: typeof ATTACK_CARDS; runs: AttackRun[] }>("/api/attacks", { method: "POST" }),
  attackCards: () => req<{ cards: typeof ATTACK_CARDS }>("/api/attacks"),
  providers: () => req<{ providers: ProviderHonesty[] }>("/api/providers"),
  receipts: () => req<{ receipts: Receipt[] }>("/api/receipts"),
  register: () => req<{ sigs: unknown[] }>("/api/setup/register", { method: "POST" }),
  eventsUrl: (id: string) => `${BASE}/api/missions/${id}/events`,
};

export { BASE as API_BASE };
