import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Database } from "sqlite3";

export type NativeSqliteTarget = {
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
  archive: string;
  archiveSha256: string;
  binarySha256: string;
};

export const NATIVE_SQLITE_VERSION = "6.0.1";
export const MINIMUM_NODE_VERSION = "20.17.0";

export const NATIVE_SQLITE_TARGETS: readonly NativeSqliteTarget[] = [
  {
    platform: "darwin",
    arch: "arm64",
    archive: "sqlite3-v6.0.1-napi-v6-darwin-arm64.tar.gz",
    archiveSha256: "65ddb932a774b7beaba9d97dc3c5a3750ae9405e96ee52b8ec9beec7c8eea597",
    binarySha256: "ba14c3b1975cb0f70321b38c9fea614ef09b27e996aec58794d4e210d2ee91f2"
  },
  {
    platform: "darwin",
    arch: "x64",
    archive: "sqlite3-v6.0.1-napi-v6-darwin-x64.tar.gz",
    archiveSha256: "04c9e612a9fce5f62f1a779b44cb75f4d944c02dde615dbd8a1dff51569a2570",
    binarySha256: "3e256bf5a51b06346197d545770e495be3baf20ca92b94017ae96ce388fe4e8e"
  },
  {
    platform: "win32",
    arch: "x64",
    archive: "sqlite3-v6.0.1-napi-v6-win32-x64.tar.gz",
    archiveSha256: "e0bbbb6e43b45378e6d6e2c5cc096e61e4c8932dbc2d2c9c08b8e3aaa80c9adf",
    binarySha256: "5e1d1275e126c3fc584bcf5752fbf747bff89454bfcf8bc76c982b24e7815057"
  }
] as const;

export function resolveNativeSqliteTarget(
  platform: string,
  arch: string,
  nodeVersion = process.versions.node
): NativeSqliteTarget {
  if (!supportedNodeVersion(nodeVersion)) {
    throw new Error(`SQLite probing requires Node ${MINIMUM_NODE_VERSION} or newer.`);
  }
  const target = NATIVE_SQLITE_TARGETS.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (!target) throw new Error(`Unsupported SQLite runtime target: ${platform}-${arch}.`);
  return target;
}

export async function verifyLoadedNativeSqlite(): Promise<{ path: string; sha256: string }> {
  const target = resolveNativeSqliteTarget(process.platform, process.arch);
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("sqlite3/package.json"));
  const path = join(packageRoot, "build", "Release", "node_sqlite3.node");
  const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  if (sha256 !== target.binarySha256) throw new Error("Loaded SQLite binary does not match the pinned target hash.");
  return { path, sha256 };
}

function supportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/u, "").split(".").map(Number);
  if (![major, minor, patch].every(Number.isInteger)) return false;
  if (major > 20) return true;
  return major === 20 && (minor > 17 || (minor === 17 && patch >= 0));
}

type SqliteModule = {
  Database: typeof import("sqlite3").Database;
  OPEN_CREATE: number;
  OPEN_READONLY: number;
  OPEN_READWRITE: number;
};

async function loadVerifiedSqlite(): Promise<SqliteModule> {
  await verifyLoadedNativeSqlite();
  const imported = await import("sqlite3") as unknown as { default?: SqliteModule } & SqliteModule;
  return imported.default ?? imported;
}

function openDatabase(sqlite: SqliteModule, path: string, mode: number): Promise<Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite.Database(path, mode, (error: Error | null) => error ? reject(error) : resolve(database));
  });
}

function exec(database: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => database.exec(sql, (error) => error ? reject(error) : resolve()));
}

function all<T>(database: Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, (error, rows) => error ? reject(error) : resolve(rows as T[]));
  });
}

function close(database: Database): Promise<void> {
  return new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
}

async function fileNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}

async function fileSnapshot(directory: string): Promise<Record<string, { size: number; mtimeMs: number; sha256: string }>> {
  return Object.fromEntries(await Promise.all((await fileNames(directory)).map(async (name) => {
    const metadata = await stat(join(directory, name));
    const sha256 = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
    return [name, { size: metadata.size, mtimeMs: metadata.mtimeMs, sha256 }] as const;
  })));
}

export async function probeReadonlyWal(directory: string): Promise<{
  rows: Array<{ value: string }>;
  createdByReader: string[];
  filesChangedByReader: string[];
}> {
  const sqlite3 = await loadVerifiedSqlite();
  const path = join(directory, "probe.sqlite");
  const writer = await openDatabase(sqlite3, path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
  try {
    await exec(writer, [
      "PRAGMA journal_mode=WAL",
      "PRAGMA synchronous=NORMAL",
      "CREATE TABLE sample (value TEXT NOT NULL)",
      "INSERT INTO sample (value) VALUES ('from-wal')"
    ].join(";"));

    const before = await fileSnapshot(directory);
    const reader = await openDatabase(sqlite3, path, sqlite3.OPEN_READONLY);
    let rows: Array<{ value: string }>;
    try {
      reader.configure("busyTimeout", 500);
      rows = await all<{ value: string }>(reader, "SELECT value FROM sample ORDER BY rowid");
    } finally {
      await close(reader);
    }
    const after = await fileSnapshot(directory);
    return {
      rows,
      createdByReader: Object.keys(after).filter((name) => !(name in before)),
      filesChangedByReader: Object.keys(before).filter((name) => {
        const next = after[name];
        return !next || before[name]?.size !== next.size || before[name]?.mtimeMs !== next.mtimeMs ||
          before[name]?.sha256 !== next.sha256;
      })
    };
  } finally {
    await close(writer);
  }
}
