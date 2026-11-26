// Runs inside the SSH host next to the shell reader. `server.getConfig` is only served over the T3
// WebSocket RPC, so this is a minimal stdlib WebSocket client bound to the runtime's loopback origin.
// Only usage-limit fields leave the host: no account fingerprints, messages, or other provider state.
export const REMOTE_USAGE_READER = String.raw`
import base64, signal, socket, struct
def usage_number(value):
 return value if type(value) in (int, float) and abs(value) <= 9007199254740991 else None
def compact_usage(config):
 providers = config.get("providers") if isinstance(config, dict) else None
 if not isinstance(providers, list): raise ValueError("providers")
 result = []
 for provider in providers[:64]:
  if not isinstance(provider, dict) or not isinstance(provider.get("driver"), str) or len(provider["driver"]) > 64: continue
  limits = provider.get("usageLimits")
  if not isinstance(limits, dict): continue
  usage = {"windows": []}
  if isinstance(limits.get("checkedAt"), str) and len(limits["checkedAt"]) <= 64: usage["checkedAt"] = limits["checkedAt"]
  if isinstance(limits.get("unavailable"), dict): usage["unavailable"] = {}
  for window in limits.get("windows", [])[:32] if isinstance(limits.get("windows"), list) else []:
   if not isinstance(window, dict) or not isinstance(window.get("id"), str) or len(window["id"]) > 128 or not isinstance(window.get("kind"), str) or len(window["kind"]) > 32: continue
   item = {"id": window["id"], "kind": window["kind"], "usedPercent": usage_number(window.get("usedPercent"))}
   if usage_number(window.get("windowDurationMins")) is not None: item["windowDurationMins"] = window["windowDurationMins"]
   if isinstance(window.get("resetsAt"), str) and len(window["resetsAt"]) <= 64: item["resetsAt"] = window["resetsAt"]
   usage["windows"].append(item)
  credits = limits.get("resetCredits")
  if isinstance(credits, dict): usage["resetCredits"] = {key: usage_number(credits.get(key)) for key in ("availableCount", "applicableCount")}
  result.append({"driver": provider["driver"], "usageLimits": usage})
 return {"providers": result}

def read_usage_config(token):
 ticket_request = urllib.request.Request(origin + "/api/auth/websocket-ticket", data=b"", method="POST", headers={"Authorization": "Bearer " + token})
 with opener.open(ticket_request, timeout=7) as response:
  ticket = json.loads(response.read(16385))["ticket"]
 if not isinstance(ticket, str) or not ticket: raise ValueError("ticket")
 url = urllib.parse.urlsplit(origin)
 connection = socket.create_connection((url.hostname, url.port), timeout=7)
 try:
  key = base64.b64encode(os.urandom(16)).decode()
  path = "/ws?" + urllib.parse.urlencode({"orchestrationProtocol": "2", "wsTicket": ticket})
  connection.sendall(("GET " + path + " HTTP/1.1\r\nHost: " + url.netloc + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
  buffer = b""
  while b"\r\n\r\n" not in buffer:
   chunk = connection.recv(4096)
   if not chunk or len(buffer) > 16384: raise ValueError("handshake")
   buffer += chunk
  head, buffer = buffer.split(b"\r\n\r\n", 1)
  if not head.startswith(b"HTTP/1.1 101"): raise ValueError("handshake")
  def send(text):
   payload, mask = text.encode(), os.urandom(4)
   size = len(payload)
   header = bytes([0x81, 0x80 | size]) if size < 126 else bytes([0x81, 0x80 | 126]) + struct.pack(">H", size)
   connection.sendall(header + mask + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload)))
  def take(size):
   nonlocal buffer
   while len(buffer) < size:
    chunk = connection.recv(65536)
    if not chunk: raise ValueError("closed")
    buffer += chunk
   value, buffer = buffer[:size], buffer[size:]
   return value
  send(json.dumps({"_tag": "Request", "id": "1", "tag": "server.getConfig", "payload": {}, "headers": []}))
  message = b""
  while True:
   first, second = take(2)
   if second & 0x80: raise ValueError("masked")
   size = second & 127
   if size == 126: size = struct.unpack(">H", take(2))[0]
   elif size == 127: size = struct.unpack(">Q", take(8))[0]
   if len(message) + size > ${8 * 1024 * 1024}: raise ValueError("size")
   payload, opcode = take(size), first & 15
   if opcode == 8: raise ValueError("closed")
   if opcode in (9, 10): continue
   message += payload
   if not first & 0x80: continue
   frame, message = json.loads(message), b""
   if not isinstance(frame, dict): continue
   if frame.get("_tag") == "Ping":
    send('{"_tag":"Pong"}')
    continue
   if frame.get("_tag") != "Exit" or frame.get("requestId") != "1": continue
   exit = frame.get("exit")
   if not isinstance(exit, dict) or exit.get("_tag") != "Success": raise ValueError("exit")
   return compact_usage(exit.get("value"))
 finally:
  connection.close()

def read_usage(token):
 def deadline(*args): raise TimeoutError("usage deadline")
 previous = signal.signal(signal.SIGALRM, deadline)
 signal.setitimer(signal.ITIMER_REAL, 7)
 try: return read_usage_config(token)
 finally:
  signal.setitimer(signal.ITIMER_REAL, 0)
  signal.signal(signal.SIGALRM, previous)
`;
