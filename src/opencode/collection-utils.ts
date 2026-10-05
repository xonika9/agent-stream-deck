import type { OpenCodeConnectionSnapshot, OpenCodeTask, OpenCodeTaskStatus } from "./contracts.js";

export function unavailable(connectionId: string, observedAt: number): OpenCodeConnectionSnapshot {
  return { connectionId, health: "unavailable", complete: false, observedAt, tasks: [] };
}

export function taskIdentity(connectionId: string, sessionId: string): string {
  return `${connectionId}\0${sessionId}`;
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next++;
        const value = values[index];
        if (value === undefined) return;
        results[index] = await operation(value);
      }
    }),
  );
  return results;
}

export function compareTasks(left: OpenCodeTask, right: OpenCodeTask): number {
  const priority: Record<OpenCodeTaskStatus, number> = { attention: 0, error: 1, complete: 2, working: 3 };
  return priority[left.status] - priority[right.status] || left.sessionId.localeCompare(right.sessionId);
}

export function normalizeTime(value: number, now: number): number {
  return Math.min(value, now);
}
