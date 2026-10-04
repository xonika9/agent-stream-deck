export const ACTIVE_CATALOG_MAX_CANDIDATES = 256;
export const ACTIVE_CATALOG_RETRY_DELAY_MS = 15_000;
export const SNAPSHOT_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Build renderer-side discovery code. The loader override exists so tests can
 * execute the exact expression without importing Codex's hashed app bundle.
 */
export function buildActiveCatalogDiscoveryExpression(
  moduleLoaderExpression = "(url) => import(url)"
): string {
  return `
  // The full sidebar catalog is optional. Resolver incompatibility is cached,
  // while per-thread races only suppress the catalog for the current poll.
  let activeCatalog;
  const activeCatalogResolverCacheKey = Symbol.for('codex-deck-active-catalog-resolvers');
  const activeCatalogResolverFormat = 2;
  const appInitialUrl = urls.find((url) => url.includes('/assets/app-initial-'));
  if (appInitialUrl) {
    const loadActiveCatalogModule = ${moduleLoaderExpression};
    let resolverCache = globalThis[activeCatalogResolverCacheKey];
    if (resolverCache?.url !== appInitialUrl || resolverCache?.format !== activeCatalogResolverFormat) {
      delete globalThis[activeCatalogResolverCacheKey];
      resolverCache = null;
    }
    if (!(resolverCache?.failure === true && resolverCache.retryAt > Date.now())) {
      let resolverContext = null;
      try {
        const appInitialNamespace = await loadActiveCatalogModule(appInitialUrl);
        const initialValues = Object.values(appInitialNamespace);
        const initialResolvers = initialValues.filter((candidate) =>
          candidate && typeof candidate === 'object' &&
          typeof candidate.resolve === 'function' &&
          typeof candidate.createSubscriberAtom === 'function'
        );
        const semanticFamilies = initialValues.filter((candidate) =>
          candidate && typeof candidate === 'object' && typeof candidate.resolve === 'function');
        const isAllSidebar = (value) => value && typeof value === 'object' &&
          Array.isArray(value.allSidebarThreadKeys) && Array.isArray(value.pinnedThreadKeys) &&
          Array.isArray(value.unpinnedThreadKeys);
        const isReadable = (value) => value && typeof value === 'object' &&
          Array.isArray(value.threadKeys) && (
            (value.threadAttentionStateByKey && value.threadRecencyAtByKey) ||
            (Array.isArray(value.threadStateKeys) && Array.isArray(value.navigationThreadKeys))
          );
        const resolveDirect = (resolver) => found.node.store.get(
          resolver.resolve(found.node, found.chain));
        const resolveFamily = (family, key) => {
          const member = family.resolve(found.node, found.chain, key);
          if (!member || typeof member.resolve !== 'function') return null;
          return found.node.store.get(member.resolve(found.node, found.chain));
        };
        let allSidebar = null;
        let readable = null;
        if (resolverCache && resolverCache.failure !== true) {
          try {
            const cachedAll = resolveDirect(resolverCache.allSidebarResolver);
            const cachedReadable = resolveFamily(resolverCache.readableFamily, 'codex');
            if (!isAllSidebar(cachedAll) || !isReadable(cachedReadable)) {
              throw new Error('Cached resolver changed.');
            }
            allSidebar = cachedAll;
            readable = cachedReadable;
          } catch {
            delete globalThis[activeCatalogResolverCacheKey];
            resolverCache = null;
          }
        }
        if (!allSidebar || !readable) {
          let allSidebarResolver = null;
          let readableFamily = null;
          for (const resolver of initialResolvers) {
            try {
              const value = resolveDirect(resolver);
              if (isAllSidebar(value)) {
                allSidebar = value;
                allSidebarResolver = resolver;
                break;
              }
            } catch {}
          }
          for (const family of semanticFamilies) {
            try {
              const value = resolveFamily(family, 'codex');
              if (isReadable(value)) {
                readable = value;
                readableFamily = family;
                break;
              }
            } catch {}
          }
          if (!allSidebar || !readable || !allSidebarResolver || !readableFamily) {
            throw new Error('Semantic sidebar catalog resolvers were not found.');
          }
          resolverCache = { url: appInitialUrl, format: activeCatalogResolverFormat, allSidebarResolver, readableFamily, taskFamily: null };
          globalThis[activeCatalogResolverCacheKey] = resolverCache;
        }

        const safeThreadKey = /^(?:[a-z][a-z0-9_-]{0,31}:){0,3}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const allKeys = allSidebar.allSidebarThreadKeys;
        const pinnedKeys = allSidebar.pinnedThreadKeys;
        const unpinnedKeys = allSidebar.unpinnedThreadKeys;
        if (![allKeys, pinnedKeys, unpinnedKeys, readable.threadKeys].every((items) =>
          items.every((key) => typeof key === 'string' && safeThreadKey.test(key)))) {
          throw new Error('Sidebar catalog contains an unsafe thread key.');
        }
        const dedupedAll = [...new Set(allKeys)];
        const orderedKeys = [...new Set([...pinnedKeys, ...unpinnedKeys])];
        if (dedupedAll.length !== orderedKeys.length ||
          dedupedAll.some((key, index) => orderedKeys[index] !== key)) {
          throw new Error('Sidebar catalog arrays are inconsistent.');
        }
        // Fail closed before resolving even one per-key task descriptor. A
        // truncated array must never be advertised as a complete catalog.
        if (dedupedAll.length > ${ACTIVE_CATALOG_MAX_CANDIDATES}) {
          // Size is live data, not resolver incompatibility. Preserve the
          // successful cache and reconsider the complete list next poll.
          resolverContext = { skipCurrentPoll: true };
        } else {
          const resolveTaskDescriptor = (family, key) => {
            const descriptor = resolveFamily(family, key);
            // A lightweight navigation descriptor also has kind/key, but no
            // live state. Only the full task family can describe off-slot work.
            const hasTaskState = descriptor?.kind === 'local'
              ? descriptor.conversation || descriptor.thread?.conversation ||
                'summary' in descriptor || descriptor.pendingWorktree || descriptor.pendingThreadStart
              : descriptor?.kind === 'remote' && (descriptor.task || descriptor.remoteTask);
            return descriptor && hasTaskState && descriptor.key === key
              ? descriptor
              : null;
          };
          const sampleKey = orderedKeys[0];
          let taskFamily = resolverCache.taskFamily;
          if (sampleKey && !taskFamily) {
            for (const family of semanticFamilies) {
              try {
                if (!resolveTaskDescriptor(family, sampleKey)) continue;
                taskFamily = family;
                resolverCache.taskFamily = family;
                break;
              } catch {}
            }
            if (!taskFamily) throw new Error('Task descriptor family was not found.');
          }
          resolverContext = {
            allSidebar, readable, orderedKeys, dedupedAll, taskFamily, resolveTaskDescriptor
          };
        }
        // A successful semantic resolution replaces any prior failure entry.
        globalThis[activeCatalogResolverCacheKey] = resolverCache;
      } catch {
        globalThis[activeCatalogResolverCacheKey] = {
          url: appInitialUrl,
          format: activeCatalogResolverFormat,
          failure: true,
          retryAt: Date.now() + ${ACTIVE_CATALOG_RETRY_DELAY_MS}
        };
      }

      if (resolverContext && !resolverContext.skipCurrentPoll) {
        try {
          const { allSidebar, readable, orderedKeys, dedupedAll, taskFamily, resolveTaskDescriptor } = resolverContext;
          const bareUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const nativeIndex = new Map(dedupedAll.map((key, index) => [key, index]));
          const getKeyed = (container, key) => container instanceof Map ? container.get(key) : container?.[key];
          const stateName = (value) => typeof value === 'string'
            ? value
            : typeof value?.status === 'string' ? value.status
              : typeof value?.state === 'string' ? value.state : 'idle';
          const mapStatus = (value) => {
            const state = stateName(value).toLowerCase();
            if (['waiting', 'needs-input', 'needs_input', 'awaiting-response', 'awaiting_response'].includes(state)) {
              return 'awaiting-response';
            }
            if (['unread', 'completed-unread', 'completed_unread'].includes(state)) return 'unread';
            if (['active', 'working', 'running', 'in-progress', 'in_progress'].includes(state)) return 'working';
            if (['error', 'failed'].includes(state)) return 'error';
            return 'idle';
          };
          const remoteTaskStatus = (task, descriptor) => {
            if (task?.has_unread_turn === true) return 'unread';
            const turnStatus = task?.task_status_display?.latest_turn_status_display?.turn_status;
            if (typeof turnStatus === 'string') return mapStatus(turnStatus);
            if (typeof task?.status === 'string') return mapStatus(task.status);
            if (typeof descriptor.status === 'string') return mapStatus(descriptor.status);
            return 'idle';
          };
          const descriptorFor = (key) => taskFamily ? resolveTaskDescriptor(taskFamily, key) : null;
          const cleanTitle = (value) => typeof value === 'string' && value.trim() && value.length <= 240
            ? value.trim()
            : null;
          const nativeByKey = new Map(slots.filter((slot) => typeof slot.threadKey === 'string')
            .map((slot) => [slot.threadKey, slot]));
          const candidates = [];
          for (const key of orderedKeys) {
            const descriptor = descriptorFor(key);
            if (!descriptor) throw new Error('Task descriptor is temporarily unavailable.');
            const attention = getKeyed(readable.threadAttentionStateByKey, key);
            const attentionName = stateName(attention).toLowerCase();
            let recency = toEpoch(getKeyed(readable.threadRecencyAtByKey, key));
            let title = null;
            let conversationId;
            let descriptorStatus;
            if (descriptor.kind === 'local') {
              const conversation = descriptor.conversation ?? descriptor.thread?.conversation ?? descriptor.summary;
              const id = conversation?.id ?? conversation?.conversationId;
              if (typeof id === 'string' && bareUuid.test(id)) {
                conversationId = id.toLowerCase();
              }
              title = cleanTitle(conversation?.title) ?? cleanTitle(
                descriptor.pendingWorktree?.label ?? conversation?.pendingWorktree?.label ?? descriptor.pendingThreadStart?.title);
              recency ??= toEpoch(conversation?.recencyAt) ?? toEpoch(conversation?.updatedAt) ?? toEpoch(descriptor.at);
              const runtimeStatus = conversation?.threadRuntimeStatus?.type;
              descriptorStatus = runtimeStatus === 'active'
                ? 'working'
                : conversation?.hasUnreadTurn === true ? 'unread' : 'idle';
            } else {
              const task = descriptor.task ?? descriptor.remoteTask;
              title = cleanTitle(task?.title ?? descriptor.title);
              const remoteConversationId = task?.conversation_id ?? task?.id;
              if (typeof remoteConversationId === 'string' && bareUuid.test(remoteConversationId)) {
                conversationId = remoteConversationId.toLowerCase();
              }
              descriptorStatus = remoteTaskStatus(task, descriptor);
            }
            const native = nativeByKey.get(key);
            const mappedAttention = mapStatus(attentionName);
            const explicitAttention = ['awaiting-response', 'unread', 'error'].includes(mappedAttention)
              ? mappedAttention
              : undefined;
            const status = native?.status ?? explicitAttention ?? descriptorStatus ?? mappedAttention;
            candidates.push({
              threadKey: key,
              ...(conversationId ? { conversationId } : {}),
              title: native ? native.title : title,
              status,
              selected: native?.selected ?? false,
              activityAt: native ? native.activityAt : recency,
              catalogIndex: nativeIndex.get(key),
              ...(native ? { nativeSlot: native.id } : {})
            });
          }
          const knownNonIdle = new Set(['awaiting-response', 'unread', 'working', 'error', 'approval', 'awaiting-approval']);
          candidates.sort((left, right) =>
            Number(knownNonIdle.has(right.status)) - Number(knownNonIdle.has(left.status)) ||
            (right.activityAt ?? 0) - (left.activityAt ?? 0) ||
            left.catalogIndex - right.catalogIndex);
          activeCatalog = { complete: true, candidates };
        } catch {
          // A create/delete race is not evidence that semantic resolvers are
          // incompatible. Keep the success cache and retry on the next poll.
          activeCatalog = undefined;
        }
      }
    }
  }`;
}

/** Build the renderer return expression with an exact UTF-8 payload budget. */
export function buildSnapshotPayloadExpression(baseSnapshotExpression: string): string {
  return `(() => {
    const baseSnapshot = ${baseSnapshotExpression};
    if (!activeCatalog) return baseSnapshot;
    const catalogSnapshot = { ...baseSnapshot, activeCatalog };
    try {
      if (new TextEncoder().encode(JSON.stringify(catalogSnapshot)).byteLength <= ${SNAPSHOT_MAX_PAYLOAD_BYTES}) {
        return catalogSnapshot;
      }
    } catch {}
    return baseSnapshot;
  })()`;
}
