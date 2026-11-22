type RecordValue = Record<string, unknown>;

export type ThreadRef = { environmentId: string; threadId: string };

// T3's left menu lists only threads that are not nested inside another thread.
function isNested(thread: RecordValue): boolean {
  const lineage = record(thread.lineage);
  return lineage?.relationshipToParent === "subagent" || lineage?.sideChat === true;
}

// T3 marks a thread unread only once the user has opened it. Work another agent drives may never be opened,
// and its accumulated history must not reach the queue, so it does not wait to be read.
export function staysUntilRead(thread: RecordValue): boolean {
  return Boolean(thread.lastVisitedAt) && !isNested(thread) && delegation(thread) === undefined;
}

// Mirrors which nested requests T3 surfaces to the user: the calling agent answers an ordinary
// subagent question, and a provider-native subagent's request already belongs to its parent.
// A side chat has no calling agent, so its proposed plan also waits for the user.
function asksUser(thread: RecordValue): boolean {
  const lineage = record(thread.lineage);
  if (lineage?.sideChat === true && thread.hasActionableProposedPlan) return true;
  if (!thread.pendingRuntimeRequest) return false;
  const request = record(thread.pendingRuntimeRequest);
  if (request?.kind === "auth_refresh") return false;
  if (lineage?.sideChat === true) return true;
  if (lineage?.relationshipToParent === "subagent" && thread.creationSource === "provider") return false;
  const active =
    thread.activityRunStatus === undefined
      ? ["preparing", "starting", "running", "waiting"].includes(String(thread.status))
      : thread.activityRunStatus !== null;
  return active && (request?.kind !== "user_input" || request.userOnly === true);
}

/**
 * Threads for the queue, each with whether it asks the user for itself or for a hidden nested thread.
 * A request whose visible ancestor is absent from the snapshot stays on its own thread so it is never lost.
 * `delegatedFrom` names the thread in another environment that T3 nests this one under while it is available.
 */
export function sidebarThreads(
  threads: RecordValue[],
  isShown: (thread: RecordValue) => boolean,
): { thread: RecordValue; asked: boolean; delegatedFrom?: ThreadRef }[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const asked = new Set<RecordValue>();
  for (const thread of threads) {
    const hideable = isNested(thread) || delegation(thread) !== undefined;
    if (!hideable || !asksUser(thread) || !isShown(thread)) continue;
    const seen = new Set<RecordValue>();
    let owner: RecordValue | undefined = thread;
    while (owner && isNested(owner) && !seen.has(owner)) {
      seen.add(owner);
      owner = byId.get(record(owner.lineage)?.parentThreadId);
    }
    asked.add(owner && !isNested(owner) && isShown(owner) ? owner : thread);
  }
  return threads.flatMap((thread) =>
    !isNested(thread) || asked.has(thread)
      ? [{ thread, asked: asked.has(thread), delegatedFrom: delegation(thread) }]
      : [],
  );
}

function delegation(thread: RecordValue): ThreadRef | undefined {
  const source = record(thread.delegatedFrom);
  return typeof source?.environmentId === "string" && typeof source.threadId === "string"
    ? { environmentId: source.environmentId, threadId: source.threadId }
    : undefined;
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}
