import type { MissionEvent } from "../../shared/types.ts";
import { db } from "./db.ts";
import { explorerTx } from "./config.ts";

type Subscriber = (ev: MissionEvent) => void;
const subs = new Map<string, Set<Subscriber>>();

export function subscribe(missionId: string, fn: Subscriber): () => void {
  let set = subs.get(missionId);
  if (!set) {
    set = new Set();
    subs.set(missionId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) subs.delete(missionId);
  };
}

export function publish(missionId: string, input: Omit<MissionEvent, "id" | "missionId" | "ts"> & { ts?: string }): MissionEvent {
  const ts = input.ts ?? new Date().toISOString();
  const explorerUrl = input.explorerUrl ?? (input.tx ? explorerTx(input.tx) : null);
  const info = db
    .prepare(
      "INSERT INTO events(mission_id, ts, type, act, message, tx, explorer_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(missionId, ts, input.type, input.act, input.message, input.tx, explorerUrl);
  const ev: MissionEvent = {
    id: Number(info.lastInsertRowid),
    missionId,
    ts,
    type: input.type,
    act: input.act,
    message: input.message,
    tx: input.tx,
    explorerUrl,
  };
  for (const fn of subs.get(missionId) ?? []) fn(ev);
  return ev;
}

export function eventsFor(missionId: string): MissionEvent[] {
  return db
    .prepare("SELECT id, mission_id as missionId, ts, type, act, message, tx, explorer_url as explorerUrl FROM events WHERE mission_id = ? ORDER BY id")
    .all(missionId) as MissionEvent[];
}
