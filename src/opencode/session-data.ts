import type { RawSession } from "./contracts.js";
import { MAX_SESSIONS, MAX_ROOTS } from "./limits.js";
import { isRecord, boundedString, validId, timestamp } from "./validation.js";

export function parseActive(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.data)) throw new Error("active-shape");
  const entries = Object.entries(value.data);
  if (entries.length > MAX_SESSIONS) throw new Error("active-capacity");
  return entries.map(([id, state]) => {
    if (!validId(id) || !isRecord(state) || state.type !== "running") throw new Error("active-entry");
    return id;
  });
}

export function parsePending(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > MAX_SESSIONS) throw new Error("pending-shape");
  return value.data.map((item) => {
    if (!isRecord(item) || !validId(item.sessionID)) throw new Error("pending-entry");
    return item.sessionID;
  });
}

export function parseRootSessions(value: unknown): { sessions: RawSession[]; complete: boolean } {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > MAX_ROOTS || !isRecord(value.cursor)) {
    throw new Error("root-shape");
  }
  if ((value.cursor.next !== undefined && !boundedString(value.cursor.next, 4096)) ||
    (value.cursor.previous !== undefined && !boundedString(value.cursor.previous, 4096))) throw new Error("cursor-shape");
  const sessions = value.data.map(parseSession);
  if (sessions.some((session) => session.parentID !== undefined)) throw new Error("non-root");
  return {
    sessions: [...new Map(sessions.map((session) => [session.id, session])).values()],
    complete: value.cursor.next === undefined
  };
}

export function parseSessionEnvelope(value: unknown): RawSession {
  if (!isRecord(value)) throw new Error("session-envelope");
  return parseSession(value.data);
}

export function parseSession(value: unknown): RawSession {
  if (!isRecord(value) || !validId(value.id) || (value.parentID !== undefined && !validId(value.parentID)) ||
    !isRecord(value.time) || !timestamp(value.time.created) || !timestamp(value.time.updated) ||
    (value.time.idle !== undefined && !timestamp(value.time.idle)) ||
    (value.time.viewed !== undefined && !timestamp(value.time.viewed)) ||
    (value.outcome !== undefined && !["succeeded", "failed", "interrupted"].includes(String(value.outcome)))) {
    throw new Error("session-shape");
  }
  return {
    id: value.id,
    parentID: value.parentID as string | undefined,
    displayTitle: sanitizeDisplayTitle(value.title),
    outcome: value.outcome as RawSession["outcome"],
    time: {
      created: value.time.created,
      updated: value.time.updated,
      idle: value.time.idle as number | undefined,
      viewed: value.time.viewed as number | undefined
    }
  };
}

export function sanitizeDisplayTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return;
  const characters: string[] = [];
  let bytes = 0;
  for (const character of cleaned) {
    const size = Buffer.byteLength(character, "utf8");
    if (characters.length >= 120 || bytes + size > 256) break;
    characters.push(character);
    bytes += size;
  }
  return characters.join("") || undefined;
}

