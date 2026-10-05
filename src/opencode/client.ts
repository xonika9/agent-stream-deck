import type { Connection, OpenCodeCollectorDependencies } from "./contracts.js";
import { RESPONSE_LIMIT, FETCH_TIMEOUT_MS, IDENTITY_PATHS } from "./limits.js";
import { isRecord } from "./validation.js";

export class AuthenticatedOpenCodeClient {
  private readonly abortControllers = new Set<AbortController>();
  constructor(private readonly deps: OpenCodeCollectorDependencies) {}

  stop(): void {
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
  }

  async fetchJson(connection: Connection, path: string, maximumBytes = RESPONSE_LIMIT): Promise<unknown> {
    const result = await this.fetchAuthenticated(connection, path, maximumBytes);
    if (result.status < 200 || result.status >= 300) throw new Error("http-status");
    try { return JSON.parse(result.body); } catch { throw new Error("invalid-json"); }
  }

  async verifyIdentity(connection: Connection): Promise<boolean> {
    if (connection.identityPath) {
      const response = await this.fetchAuthenticated(connection, connection.identityPath, 16 * 1024);
      if (response.status !== 404) return this.identityMatches(connection, response);
      connection.identityPath = undefined;
    }
    for (const path of IDENTITY_PATHS) {
      const unauthenticated = await this.fetchResponse(connection.endpoint, path, undefined, 16 * 1024);
      if (unauthenticated.status === 404) continue;
      if (unauthenticated.status !== 401 && unauthenticated.status !== 403) return false;
      const response = await this.fetchAuthenticated(connection, path, 16 * 1024);
      if (response.status === 404) continue;
      if (!this.identityMatches(connection, response)) return false;
      connection.identityPath = path;
      return true;
    }
    return false;
  }

  private fetchAuthenticated(connection: Connection, path: string, maximumBytes: number) {
    const authorization = `Basic ${Buffer.from(`opencode:${connection.password}`).toString("base64")}`;
    return this.fetchResponse(connection.endpoint, path, authorization, maximumBytes);
  }

  private identityMatches(connection: Connection, response: { status: number; body: string }): boolean {
    if (response.status < 200 || response.status >= 300) return false;
    let identity: unknown;
    try { identity = JSON.parse(response.body); } catch { return false; }
    return isRecord(identity) && identity.version === connection.version && identity.pid === connection.pid;
  }

  async fetchResponse(
    endpoint: string,
    path: string,
    authorization?: string,
    maximumBytes = RESPONSE_LIMIT,
    request: Pick<RequestInit, "method" | "headers" | "body"> = {}
  ) {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = new Headers(request.headers);
      if (authorization) headers.set("authorization", authorization);
      const response = await this.deps.fetch(new URL(path, endpoint).toString(), {
        method: request.method ?? "GET",
        headers,
        body: request.body,
        redirect: "error",
        signal: controller.signal
      });
      return { status: response.status, body: await readBoundedBody(response, maximumBytes) };
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(controller);
    }
  }

}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumBytes)) throw new Error("response-size");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) throw new Error("response-size");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

