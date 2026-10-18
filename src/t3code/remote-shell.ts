export const REMOTE_SHELL_READER = String.raw`
import codecs, datetime, signal
class ShellRecords:
 def __init__(self, response):
  self.response, self.buffer, self.eof = response, "", False
  self.decoder = codecs.getincrementaldecoder("utf-8")("strict")
  self.json = json.JSONDecoder(parse_constant=self.invalid_constant)
 def invalid_constant(self, value): raise ValueError("constant")
 def more(self):
  raw = self.response.read1(65536)
  self.eof = not raw
  self.buffer += self.decoder.decode(raw, final=self.eof)
 def peek(self):
  while True:
   self.buffer = self.buffer.lstrip(" \t\r\n")
   if self.buffer or self.eof: return self.buffer[:1]
   self.more()
 def take(self, char):
  if self.peek() != char: raise ValueError("separator")
  self.buffer = self.buffer[1:]
 def value(self):
  self.peek()
  while True:
   try:
    value, end = self.json.raw_decode(self.buffer)
    complete = end < len(self.buffer) and self.buffer[end] in " \t\r\n,:]}" or end == len(self.buffer) and self.eof
   except ValueError:
    complete = False
   if complete:
    if end > 262144: raise ValueError("record size")
    depth, quoted, escaped = 0, False, False
    for char in self.buffer[:end]:
     if quoted:
      if escaped: escaped = False
      elif char == "\\": escaped = True
      elif char == '"': quoted = False
     elif char == '"': quoted = True
     elif char in "[{":
      depth += 1
      if depth > 64: raise ValueError("record depth")
     elif char in "]}": depth -= 1
    self.buffer = self.buffer[end:]
    return value
   if self.eof or len(self.buffer) > 262144: raise ValueError("invalid record")
   self.more()
 def records(self):
  self.take("{")
  keys = set()
  if self.peek() == "}": self.take("}")
  else:
   while True:
    key = self.value()
    if not isinstance(key, str) or key in keys or len(keys) >= 128: raise ValueError("key")
    keys.add(key)
    self.take(":")
    if self.peek() == "[":
     self.take("[")
     yield key, None, True
     if self.peek() != "]":
      while True:
       yield key, self.value(), False
       if self.peek() == "]": break
       self.take(",")
     self.take("]")
    else:
     if key == "threads": raise ValueError("threads")
     yield key, self.value(), False
    if self.peek() == "}":
     self.take("}")
     break
    self.take(",")
  if self.peek(): raise ValueError("trailing data")

def truthy(value):
 return value is not None and value is not False and value != 0 and value != ""
def timestamp(value):
 if not isinstance(value, str): return 0
 try: return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
 except (ValueError, OverflowError, OSError): return 0
def compact_thread(thread, now):
 if not isinstance(thread, dict) or not isinstance(thread.get("id"), str) or not thread["id"] or len(thread["id"]) > 512 or not isinstance(thread.get("title"), str) or not isinstance(thread.get("status"), str): raise ValueError("thread")
 if any(truthy(thread.get(key)) for key in ("deletedAt", "archivedAt", "settledAt")) or thread.get("settledOverride") == "settled" or timestamp(thread.get("snoozedUntil")) > now: return None
 approval = truthy(thread.get("pendingRuntimeRequest")) or truthy(thread.get("hasActionableProposedPlan"))
 background = isinstance(thread.get("pendingBackgroundTasks"), list) and len(thread["pendingBackgroundTasks"]) > 0
 activity = thread.get("activityRunStatus")
 working = (activity if activity is not None else thread["status"]) in ("preparing", "queued", "starting", "running", "waiting") or background
 if not approval and not working:
  terminal = timestamp(thread.get("latestRunCompletedAt"))
  if thread["status"] not in ("completed", "failed") or terminal <= 0 or now - terminal > 300000 or timestamp(thread.get("lastVisitedAt")) >= terminal: return None
 fields = ("id", "title", "status", "deletedAt", "archivedAt", "settledAt", "settledOverride", "snoozedUntil", "activityRunStartedAt", "latestUserAuthoredMessageAt", "latestRunRequestedAt", "latestRunCompletedAt", "activityRunStatus", "lastVisitedAt")
 result = {key: thread[key] for key in fields if key in thread}
 result["pendingRuntimeRequest"] = truthy(thread.get("pendingRuntimeRequest"))
 result["hasActionableProposedPlan"] = truthy(thread.get("hasActionableProposedPlan"))
 result["pendingBackgroundTasks"] = [True] if background else []
 return result

def read_shell_records(token, now):
 headers = {"x-t3-orchestration-protocol":"2", "Authorization":"Bearer " + token}
 with opener.open(urllib.request.Request(origin + "/api/orchestration/shell", headers=headers), timeout=4) as response:
  result, found_threads, size = {"threads": []}, False, 0
  for key, value, array_start in ShellRecords(response).records():
   if array_start:
    if key == "schemaVersion": raise ValueError("schema")
    if key == "threads": found_threads = True
    continue
   if key == "schemaVersion":
    if type(value) not in (int, float) or value != int(value) or abs(value) > 9007199254740991: raise ValueError("schema")
    result[key] = value
   elif key == "threads":
    thread = compact_thread(value, now)
    if thread is not None:
     size += len(json.dumps(thread).encode())
     if len(result["threads"]) >= 10000 or size > 8388608: raise ValueError("active tasks size")
     result["threads"].append(thread)
  if not found_threads or "schemaVersion" not in result: raise ValueError("shell")
  return result

def read_shell(token, now):
 def deadline(*args): raise TimeoutError("shell deadline")
 previous = signal.signal(signal.SIGALRM, deadline)
 signal.setitimer(signal.ITIMER_REAL, 4)
 try: return read_shell_records(token, now)
 finally:
  signal.setitimer(signal.ITIMER_REAL, 0)
  signal.signal(signal.SIGALRM, previous)
`;
