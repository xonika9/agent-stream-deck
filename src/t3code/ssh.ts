import { spawn } from "node:child_process";

export type T3SshConnection = { host: string; environmentId: string; token: string };

// Read only through the authenticated SSH host, never a network HTTP origin.
// Pairing uses the already-running server's official CLI; it never starts a service.
const T3_REMOTE_SCRIPT = `import json, os, stat, sys, subprocess, urllib.request, urllib.parse
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self, *args): raise ValueError("redirect")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
def request(path, token=None, body=None):
 headers = {"x-t3-orchestration-protocol":"2"}
 if token: headers["Authorization"] = "Bearer " + token
 if body is not None: headers["Content-Type"] = "application/x-www-form-urlencoded"
 with opener.open(urllib.request.Request(origin + path, data=body, headers=headers), timeout=4) as response:
  raw = response.read(2097153)
  if len(raw) > 2097152: raise ValueError("size")
  return json.loads(raw)
try:
 data = json.loads(sys.stdin.read(16385))
 root = os.path.expanduser("~/.t3/userdata")
 path = root + "/server-runtime.json"
 info = os.lstat(path)
 if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 16384: raise ValueError("runtime")
 with open(path) as file: runtime = json.load(file)
 origin = runtime["origin"]
 url = urllib.parse.urlsplit(origin)
 if runtime["version"] != 1 or url.scheme != "http" or url.hostname not in ("127.0.0.1", "::1") or url.username or url.password or url.path or url.query or url.fragment: raise ValueError("origin")
 os.kill(runtime["pid"], 0)
 with open(root + "/environment-id") as file: identity = file.read().strip()
 if data.get("pair"):
  process_dir = "/proc/" + str(runtime["pid"])
  if os.stat(process_dir).st_uid != os.getuid(): raise ValueError("owner")
  executable = os.readlink(process_dir + "/exe")
  if os.path.basename(executable) != "t3": raise ValueError("executable")
  paired = subprocess.run([executable, "auth", "pairing", "create", "--label", "CodexDeck", "--json"], capture_output=True, timeout=5, check=True)
  credential = json.loads(paired.stdout)["credential"]
  body = urllib.parse.urlencode({"grant_type":"urn:ietf:params:oauth:grant-type:token-exchange", "subject_token":credential, "subject_token_type":"urn:t3:params:oauth:token-type:environment-bootstrap", "requested_token_type":"urn:ietf:params:oauth:token-type:access_token", "scope":"orchestration:read", "client_label":"CodexDeck", "client_device_type":"desktop", "client_os":"macOS"}).encode()
  session = request("/oauth/token", body=body)
  if session["token_type"] != "Bearer" or session["scope"] != "orchestration:read": raise ValueError("scope")
  token = session["access_token"]
  request("/api/orchestration/shell", token)
  print(json.dumps({"environmentId":identity, "token":token}))
 else:
  if identity != data["environmentId"]: raise ValueError("identity")
  print(json.dumps(request("/api/orchestration/shell", data["token"])))
except Exception:
 sys.exit(1)
`;

export function validateSshHost(host: unknown): asserts host is string {
  if (typeof host !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,255}$/u.test(host))
    throw new Error("Invalid T3 SSH host");
}

export function validateSshConnection(value: unknown): T3SshConnection {
  const connection = value as Partial<T3SshConnection> | null;
  if (
    !connection ||
    typeof connection.environmentId !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/u.test(connection.environmentId) ||
    typeof connection.token !== "string" ||
    !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/u.test(connection.token)
  )
    throw new Error("Invalid T3 SSH connection");
  validateSshHost(connection.host);
  return connection as T3SshConnection;
}

export async function t3SshRequest(host: string, input: object, signal: AbortSignal): Promise<unknown> {
  // Validate a single saved SSH alias; no user command or SSH options are accepted.
  validateSshHost(host);
  const command = `python3 -c '${T3_REMOTE_SCRIPT.replaceAll("'", "'\\''")}'`;
  const child = spawn(
    "/usr/bin/ssh",
    [
      "-T",
      "-a",
      "-x",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=4",
      "-o",
      "RemoteCommand=none",
      "-o",
      "RequestTTY=no",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "ClearAllForwardings=yes",
      host,
      command,
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
      signal: AbortSignal.any([signal, AbortSignal.timeout("pair" in input ? 10_000 : 4_000)]),
    },
  );
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(input));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        child.kill();
        reject(new Error("T3 SSH response too large"));
      } else chunks.push(chunk);
    });
    child.on("error", () => reject(new Error("T3 SSH unavailable")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("T3 SSH unavailable"));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid T3 SSH response"));
      }
    });
  });
}
