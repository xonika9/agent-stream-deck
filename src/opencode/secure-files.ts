import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";

export interface OpenCodeFileAccess {
  list(path: string): Promise<string[]>;
  readSecure(
    path: string,
    maximumBytes: number,
    expectedUid?: number,
    policy?: "private" | "owner-write",
  ): Promise<Buffer>;
}

export class UnsafeOpenCodeFileError extends Error {
  constructor() {
    super("OpenCode private file did not pass descriptor checks.");
  }
}

function safeMetadata(
  metadata: { isFile(): boolean; isSymbolicLink(): boolean; uid: number; mode: number; size: number; nlink: number },
  maximumBytes: number,
  expectedUid?: number,
  policy: "private" | "owner-write" = "private",
): boolean {
  const permissions = metadata.mode & 0o777;
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    metadata.size >= 0 &&
    metadata.size <= maximumBytes &&
    (expectedUid === undefined || metadata.uid === expectedUid) &&
    (permissions & (policy === "private" ? 0o177 : 0o022)) === 0 &&
    (permissions & 0o400) !== 0
  );
}

export const nodeOpenCodeFileAccess: OpenCodeFileAccess = {
  async list(path) {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  },

  async readSecure(path, maximumBytes, expectedUid, policy = "private") {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | noFollow);
      const before = await handle.stat();
      if (!safeMetadata(before, maximumBytes, expectedUid, policy)) throw new UnsafeOpenCodeFileError();
      const data = await handle.readFile();
      if (data.byteLength > maximumBytes) throw new UnsafeOpenCodeFileError();
      const after = await handle.stat();
      const pathAfter = await lstat(path);
      if (
        !safeMetadata(after, maximumBytes, expectedUid, policy) ||
        pathAfter.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.dev !== pathAfter.dev ||
        before.ino !== pathAfter.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new UnsafeOpenCodeFileError();
      }
      return data;
    } catch (error) {
      if (error instanceof UnsafeOpenCodeFileError) throw error;
      throw new UnsafeOpenCodeFileError();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
};
