type RecordValue = Record<string, unknown>;
const MAX_VALUE_CHARS = 256 * 1024;
const MAX_RETAINED_THREADS = 10_000;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;

// The HTTP shell has no history filter. Bound each JSON record, not the accumulated history.
export async function readShell(
  body: AsyncIterable<Uint8Array>,
  keep: (thread: RecordValue) => boolean,
): Promise<{ schemaVersion: number; threads: RecordValue[] }> {
  const reader = new ShellReader(keep);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of body) reader.write(decoder.decode(chunk, { stream: true }));
  reader.write(decoder.decode());
  return reader.finish();
}

class ShellReader {
  private state: "start" | "key" | "colon" | "value" | "array" | "arrayDelimiter" | "delimiter" | "end" = "start";
  private key = "";
  private readonly keys = new Set<string>();
  private emptyAllowed = true;
  private token?: "string" | "container" | "primitive";
  private quoted = false;
  private escaped = false;
  private depth = 0;
  private parts: string[] = [];
  private chars = 0;
  private schemaVersion?: number;
  private readonly threads: RecordValue[] = [];
  private retainedBytes = 0;

  constructor(private readonly keep: (thread: RecordValue) => boolean) {}

  write(chunk: string): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i]!;
      if (this.token) {
        if (this.token === "primitive") {
          if (!/[ \t\r\n,}\]]/u.test(char)) continue;
          this.append(chunk.slice(start, i));
          this.complete();
          i--;
          continue;
        }
        if (this.quoted) {
          if (this.escaped) this.escaped = false;
          else if (char === "\\") this.escaped = true;
          else if (char === '"') this.quoted = false;
        } else if (char === '"') this.quoted = true;
        else if (char === "{" || char === "[") {
          if (++this.depth > 64) throw new Error("Shell record too deep");
        } else if (char === "}" || char === "]") this.depth--;
        if (this.quoted || (this.token === "container" && this.depth !== 0)) continue;
        this.append(chunk.slice(start, i + 1));
        this.complete();
        continue;
      }
      if (/[ \t\r\n]/u.test(char)) continue;
      switch (this.state) {
        case "start":
          if (char !== "{") throw new Error("Invalid shell");
          this.state = "key";
          break;
        case "key":
          if (char === "}" && this.emptyAllowed) this.state = "end";
          else {
            if (char !== '"') throw new Error("Invalid shell key");
            this.begin(char);
            start = i;
          }
          break;
        case "colon":
          if (char !== ":") throw new Error("Invalid shell separator");
          this.state = "value";
          break;
        case "value":
          if (char === "[") {
            this.state = "array";
            this.emptyAllowed = true;
            break;
          }
          if (this.key === "threads") throw new Error("Invalid threads");
          this.begin(char);
          start = i;
          break;
        case "array":
          if (char === "]" && this.emptyAllowed) this.state = "delimiter";
          else {
            this.begin(char);
            start = i;
          }
          break;
        case "arrayDelimiter":
          if (char === "]") this.state = "delimiter";
          else if (char === ",") {
            this.state = "array";
            this.emptyAllowed = false;
          } else throw new Error("Invalid array separator");
          break;
        case "delimiter":
          if (char === "}") this.state = "end";
          else if (char === ",") {
            this.state = "key";
            this.emptyAllowed = false;
          } else throw new Error("Invalid shell separator");
          break;
        case "end":
          throw new Error("Trailing shell data");
      }
    }
    if (this.token) this.append(chunk.slice(start));
  }

  finish(): { schemaVersion: number; threads: RecordValue[] } {
    if (this.token || this.state !== "end" || this.schemaVersion === undefined || !this.keys.has("threads"))
      throw new Error("Incomplete shell");
    return { schemaVersion: this.schemaVersion, threads: this.threads };
  }

  private begin(char: string): void {
    this.token = char === '"' ? "string" : char === "{" || char === "[" ? "container" : "primitive";
    this.quoted = this.token === "string";
    this.escaped = false;
    this.depth = this.token === "container" ? 1 : 0;
  }

  private append(part: string): void {
    this.chars += part.length;
    if (this.chars > MAX_VALUE_CHARS) throw new Error("Shell record too large");
    this.parts.push(part);
  }

  private complete(): void {
    const raw = this.parts.join("");
    const value: unknown = JSON.parse(raw);
    this.token = undefined;
    this.parts = [];
    this.chars = 0;
    if (this.state === "key") {
      if (typeof value !== "string" || this.keys.has(value) || this.keys.size >= 128)
        throw new Error("Invalid shell key");
      this.key = value;
      this.keys.add(value);
      this.state = "colon";
    } else if (this.state === "array") {
      if (this.key === "threads") {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid thread");
        const thread = value as RecordValue;
        if (this.keep(thread)) {
          this.retainedBytes += Buffer.byteLength(raw);
          if (this.retainedBytes > MAX_RETAINED_BYTES) throw new Error("Active threads too large");
          if (this.threads.length >= MAX_RETAINED_THREADS) throw new Error("Too many active threads");
          this.threads.push(thread);
        }
      }
      this.state = "arrayDelimiter";
    } else {
      if (this.key === "schemaVersion") {
        if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Invalid schema");
        this.schemaVersion = value;
      }
      this.state = "delimiter";
    }
  }
}
