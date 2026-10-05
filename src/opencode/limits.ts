export const REGISTRATION_LIMIT = 64 * 1024;
export const SETTINGS_LIMIT = 1024 * 1024;
export const RESPONSE_LIMIT = 1024 * 1024;
export const PROCESS_OUTPUT_LIMIT = 128 * 1024;
export const MAX_SESSIONS = 200;
export const MAX_ROOTS = 100;
export const MAX_ANCESTOR_DEPTH = 16;
export const MAX_CONNECTIONS = 17;
export const MAX_SSH_SERVERS = 16;
export const FETCH_TIMEOUT_MS = 5_000;
export const TERMINAL_RETENTION_WINDOW_MS = 5 * 60_000;
export const POLL_INTERVAL_MS = 5_000;
export const IDENTITY_PATHS = ["/api/info", "/api/status"] as const;
export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
export const SSH_EXECUTABLE = "/usr/bin/ssh";

