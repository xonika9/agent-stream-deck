type RecordValue = Record<string, unknown>;

// T3's left menu lists only threads that are not nested inside another thread.
function isNested(thread: RecordValue): boolean {
  const lineage = record(thread.lineage);
  return lineage?.relationshipToParent === "subagent" || lineage?.sideChat === true || Boolean(thread.delegatedFrom);
}

// Mirrors which nested requests T3 surfaces to the user: the calling agent answers an ordinary
// subagent question, and a provider-native subagent's request already belongs to its parent.
function asksUser(thread: RecordValue): boolean {
  if (!thread.pendingRuntimeRequest) return false;
  const request = record(thread.pendingRuntimeRequest);
  if (request?.kind === "auth_refresh") return false;
  const lineage = record(thread.lineage);
  if (lineage?.sideChat === true) return true;
  if (lineage?.relationshipToParent === "subagent" && thread.creationSource === "provider") return false;
  const active =
    thread.activityRunStatus === undefined
      ? ["preparing", "starting", "running", "waiting"].includes(String(thread.status))
      : thread.activityRunStatus !== null;
  return active && (request?.kind !== "user_input" || request.userOnly === true);
}

/**
 * Threads for the queue, each with whether a hidden nested thread asks the user through it.
 * A request whose visible ancestor is absent from the snapshot stays on its own thread so it is never lost.
 */
export function sidebarThreads(
  threads: RecordValue[],
  isShown: (thread: RecordValue) => boolean,
): { thread: RecordValue; asked: boolean }[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const asked = new Set<RecordValue>();
  for (const thread of threads) {
    if (!isNested(thread) || !asksUser(thread) || !isShown(thread)) continue;
    const seen = new Set<RecordValue>();
    let owner: RecordValue | undefined = thread;
    while (owner && isNested(owner) && !seen.has(owner)) {
      seen.add(owner);
      owner = byId.get(record(owner.lineage)?.parentThreadId);
    }
    asked.add(owner && !isNested(owner) && isShown(owner) ? owner : thread);
  }
  return threads.flatMap((thread) =>
    !isNested(thread) || asked.has(thread) ? [{ thread, asked: asked.has(thread) }] : [],
  );
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}
