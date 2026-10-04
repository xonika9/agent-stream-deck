import type { CodexHost, HostSessionPresence, MicroAgentCandidate, MicroSnapshot, RoutedAgentSlot } from "./types.js";

export type HostSnapshot = { host: CodexHost; snapshot: MicroSnapshot; observedAt: number };
type ActivityRecord = { activityAt: number; signature: string; lastSeenAt: number };
type SessionOwner = { input: HostSnapshot; session: HostSessionPresence };
const SESSION_COMPLETION_FALLBACK_MS = 5 * 60_000;

export class LocalActivityIndex {
  private readonly activity = new Map<string, ActivityRecord>();
  private readonly acknowledgedCompletions = new Map<string, number>();

  merge(input: HostSnapshot | undefined, now = Date.now()): RoutedAgentSlot[] {
    if (!input) return [];
    const slots = input.snapshot.slots.map((slot, id) => {
      if (!slot.threadKey) return emptyRoutedSlot(input, slot, id);
      const key = `${input.host.hostId}:${threadIdentity(slot.threadKey)}`;
      const signature = `${slot.status}:${slot.selected}:${slot.title ?? ""}`;
      return {
        ...slot, ...derivedConversationIdentity(slot.threadKey), id,
        activityAt: this.observeActivity(key, signature, slot.activityAt, input.observedAt, now),
        host: input.host, sourceSlot: slot.id, observedAt: input.observedAt
      };
    });
    this.pruneActivity(now);
    return slots;
  }

  /** Uses the complete local renderer catalog for Active queue only. */
  mergeActiveCatalog(input: HostSnapshot | undefined, now = Date.now()): RoutedAgentSlot[] {
    if (!input) return [];
    if (input.snapshot.agentSource === "custom") return this.merge(input, now);

    const routed: RoutedAgentSlot[] = [];
    const candidates: readonly MicroAgentCandidate[] = input.snapshot.activeCatalog?.complete
      ? input.snapshot.activeCatalog.candidates
      : input.snapshot.slots.map((slot) => ({
          ...slot,
          threadKey: slot.threadKey ?? "",
          ...derivedConversationIdentity(slot.threadKey),
          catalogIndex: slot.id,
          nativeSlot: slot.id as 0 | 1 | 2 | 3 | 4 | 5
        }));
    for (const candidate of candidates) {
      if (!candidate.threadKey) continue;
      const identity = candidate.conversationId?.toLowerCase()
        ?? `${input.host.hostId}:exact:${candidate.threadKey.toLowerCase()}`;
      const key = `${input.host.hostId}:catalog:${identity}`;
      const signature = `${candidate.status}:${candidate.selected}:${candidate.title ?? ""}`;
      const activityAt = this.observeActivity(
        key, signature, candidate.activityAt, input.observedAt, now);
      routed.push({
        id: candidate.nativeSlot ?? 0,
        threadKey: candidate.threadKey,
        conversationId: candidate.conversationId,
        title: candidate.title,
        status: candidate.status,
        selected: candidate.selected,
        activityAt,
        catalogIndex: candidate.catalogIndex,
        nativeSlot: candidate.nativeSlot,
        ownedByHost: candidate.ownedByHost,
        contextUsedPercent: candidate.contextUsedPercent,
        workStartedAt: candidate.workStartedAt,
        workStartRevision: candidate.workStartRevision,
        host: input.host,
        sourceSlot: candidate.nativeSlot ?? 0,
        observedAt: input.observedAt
      });
    }
    this.pruneActivity(now);

    const mirrors = new Map<string, RoutedAgentSlot[]>();
    for (const slot of routed) {
      const identity = slot.conversationId?.toLowerCase()
        ?? `${slot.host.hostId}:exact:${slot.threadKey!.toLowerCase()}`;
      const candidates = mirrors.get(identity) ?? [];
      candidates.push(slot);
      mirrors.set(identity, candidates);
    }
    const sessionOwners = sessionOwnerIndex(input);
    const activeThreads = new Set([
      ...(input.snapshot.activeThreadKey ? [threadIdentity(input.snapshot.activeThreadKey)] : []),
      ...routed.filter((slot) => slot.selected)
        .map((slot) => slot.conversationId?.toLowerCase() ?? threadIdentity(slot.threadKey!))
    ]);
    return [...mirrors.entries()].map(([identity, candidates]) => {
      const sessionOwner = sessionOwners.get(identity);
      return mergeMirrors(identity, candidates, sessionOwner, this.acknowledgedCompletions,
        activeThreads.has(identity));
    });
  }

  private observeActivity(
    key: string,
    signature: string,
    explicitValue: unknown,
    observedAt: number,
    now: number
  ): number {
    const prior = this.activity.get(key);
    const explicit = validTimestamp(explicitValue);
    const changed = prior != null && prior.signature !== signature;
    // Snapshot receipt is not task activity. Only an explicit renderer time or
    // an actually observed state change may advance task recency.
    const activityAt = changed
      ? Math.max(explicit ?? 0, observedAt)
      : explicit ?? prior?.activityAt ?? 0;
    this.activity.set(key, { activityAt, signature, lastSeenAt: now });
    return activityAt;
  }

  private pruneActivity(now: number): void {
    for (const [key, value] of this.activity) {
      if (now - value.lastSeenAt > 86_400_000) this.activity.delete(key);
    }
  }
}

function emptyRoutedSlot(input: HostSnapshot, slot: MicroSnapshot["slots"][number], id: number): RoutedAgentSlot {
  return { ...slot, id, host: input.host, sourceSlot: slot.id, observedAt: input.observedAt };
}

export function validTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function compareOwnership(left: RoutedAgentSlot, right: RoutedAgentSlot): number {
  const ownership = Number(right.ownedByHost === true) - Number(left.ownedByHost === true);
  if (ownership) return ownership;
  const status = hostStatusPriority(right.status) - hostStatusPriority(left.status);
  if (status) return status;
  if (left.selected !== right.selected) return left.selected ? -1 : 1;
  return compareActivity(left, right);
}

function mergeMirrors(
  identity: string,
  candidates: RoutedAgentSlot[],
  sessionOwner: SessionOwner | undefined,
  acknowledgedCompletions: Map<string, number>,
  activeLocally: boolean
): RoutedAgentSlot {
  const newestObservation = Math.max(...candidates.map((candidate) => candidate.observedAt));
  const statusCandidates = candidates;
  const statusSessionOwner = sessionOwner;
  let owner = candidates[0]!;
  const explicitOwner = sessionOwner && candidates.find((candidate) => candidate.ownedByHost === true);
  if (explicitOwner) owner = explicitOwner;
  else {
    for (const candidate of candidates.slice(1)) {
      if (compareOwnership(candidate, owner) < 0) owner = candidate;
    }
  }
  const strongest = [...statusCandidates].sort((left, right) =>
    mirrorStatusPriority(right.status) - mirrorStatusPriority(left.status) ||
    Number(right.selected) - Number(left.selected)
  )[0]!;
  const ownedCandidates = candidates.filter((candidate) => candidate.ownedByHost === true);
  const recencyCandidates = ownedCandidates.length ? ownedCandidates : candidates;
  const sessionStatus = statusSessionOwner?.session.status;
  const completionRevision = statusSessionOwner?.session.completionRevision;
  const completionKey = statusSessionOwner ? `${statusSessionOwner.input.host.hostId}:${identity}` : identity;
  const strongestIsWorking = ["working", "thinking"].includes(strongest.status);
  if (sessionStatus === "complete" && completionRevision != null &&
    activeLocally && !strongestIsWorking) {
    acknowledgedCompletions.set(completionKey, completionRevision);
  }
  const completionAcknowledged = sessionStatus === "complete" && completionRevision != null &&
    acknowledgedCompletions.get(completionKey) === completionRevision;
  const completionIsRecent = sessionStatus === "complete" && statusSessionOwner != null &&
    newestObservation - statusSessionOwner.session.activityAt <= SESSION_COMPLETION_FALLBACK_MS;
  const attention = ["approval", "awaiting-approval", "awaiting-response", "error"];
  const attentionStatus = attention.find((status) => statusCandidates.some((candidate) => candidate.status === status));
  const completionLike = ["complete", "completed", "done"];
  const status = attentionStatus
    ? attentionStatus
    : strongestIsWorking
      ? strongest.status
      : sessionStatus === "working"
      ? "working"
      : sessionStatus === "complete" && completionIsRecent && !completionAcknowledged
        ? (completionLike.includes(strongest.status) || strongest.status === "unread" ? strongest.status : "complete")
        : completionAcknowledged
          ? "idle"
          : strongest.status;
  const routedOwner = sessionOwner?.input.host ?? owner.host;
  const contextCandidate = candidates.find((candidate) =>
    candidate.ownedByHost === true && candidate.contextUsedPercent != null)
    ?? candidates.find((candidate) => candidate.contextUsedPercent != null);
  const workStartOwner = sessionOwner?.session ?? candidates.find((candidate) =>
    candidate.ownedByHost === true && !candidate.threadKey?.includes("client-new-thread") &&
    (candidate.conversationId?.toLowerCase() === identity || threadIdentity(candidate.threadKey!) === identity) &&
    candidate.workStartedAt != null && candidate.workStartRevision != null);
  const titleCandidate = candidates.find((candidate) => normalizedTitle(candidate.title));
  return {
    ...owner,
    host: routedOwner,
    ownedByHost: sessionOwner ? true : owner.ownedByHost,
    title: normalizedTitle(owner.title) ? owner.title : titleCandidate?.title ?? null,
    status,
    selected: statusCandidates.some((candidate) => candidate.selected),
    contextUsedPercent: sessionOwner?.session.contextUsedPercent ?? contextCandidate?.contextUsedPercent,
    workStartedAt: workStartOwner?.workStartedAt,
    workStartRevision: workStartOwner?.workStartRevision,
    // Local session ownership supplies activity independently of renderer selection.
    activityAt: Math.max(sessionOwner?.session.activityAt ?? 0, ...recencyCandidates.map((candidate) => candidate.activityAt ?? 0)),
    observedAt: newestObservation
  };
}

function sessionOwnerIndex(input: HostSnapshot): Map<string, SessionOwner> {
  const owners = new Map<string, SessionOwner>();
  for (const session of input.snapshot.hostSessions ?? []) {
    const identity = threadIdentity(session.threadId);
    const prior = owners.get(identity);
    if (!prior || session.activityAt > prior.session.activityAt) owners.set(identity, { input, session });
  }
  return owners;
}

function compareActivity(left: RoutedAgentSlot, right: RoutedAgentSlot): number {
  if (left.selected !== right.selected) return left.selected ? -1 : 1;
  const status = hostStatusPriority(right.status) - hostStatusPriority(left.status);
  if (status) return status;
  return (right.activityAt ?? 0) - (left.activityAt ?? 0) || left.sourceSlot - right.sourceSlot;
}

function hostStatusPriority(status: string): number {
  if (["working", "thinking", "approval", "awaiting-approval", "awaiting-response"].includes(status)) return 3;
  if (["unread", "error", "complete", "completed", "done"].includes(status)) return 2;
  if (status === "idle") return 1;
  return 0;
}

function mirrorStatusPriority(status: string): number {
  if (["working", "thinking", "approval", "awaiting-approval", "awaiting-response"].includes(status)) return 4;
  if (["unread", "error"].includes(status)) return 3;
  if (["complete", "completed", "done"].includes(status)) return 2;
  if (status === "idle") return 1;
  return 0;
}
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function threadIdentity(value: string): string {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0]?.toLowerCase() ?? value;
}

function derivedConversationIdentity(threadKey: string | null): { conversationId?: string } {
  if (!threadKey || threadKey.toLowerCase().includes(":client-new-thread:")) return {};
  const identity = threadIdentity(threadKey);
  return BARE_UUID.test(identity) ? { conversationId: identity } : {};
}

function normalizedTitle(title: string | null | undefined): string | null {
  const value = title?.trim().toLocaleLowerCase();
  return value ? value : null;
}
