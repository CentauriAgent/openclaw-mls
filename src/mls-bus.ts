import { watch, createReadStream, statSync, existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { createInterface } from "readline";
import { createHash } from "crypto";
import type { FSWatcher } from "fs";

export interface MlsInboundMessage {
  type: "message";
  timestamp: string;
  groupId: string;
  senderPubkey: string;
  content: string;
  allowed: boolean;
}

export interface MlsBusOptions {
  logPath: string;
  offsetPath: string;
  selfPubkey: string;
  onMessage: (msg: MlsInboundMessage) => void;
  onError?: (err: Error) => void;
  /** Dedup window in ms — messages with the same key seen within this window
   *  are silently dropped. Protects against double-dispatch on channel restart.
   *  Default: 60_000 (1 minute). */
  dedupWindowMs?: number;
}

export interface MlsBusHandle {
  close(): void;
}

/** Build a stable dedup key from a message. Uses timestamp+sender+content hash. */
function dedupKey(msg: MlsInboundMessage): string {
  const raw = `${msg.timestamp}|${msg.senderPubkey}|${msg.groupId}|${msg.content}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export async function startMlsBus(opts: MlsBusOptions): Promise<MlsBusHandle> {
  const { logPath, offsetPath, selfPubkey, onMessage, onError } = opts;
  const dedupWindowMs = opts.dedupWindowMs ?? 60_000;

  let offset = await loadOffset(offsetPath);
  let watcher: FSWatcher | null = null;
  let closed = false;
  let scheduled = false;
  let reading = false;

  // Dedup cache: key → expiry timestamp
  const recentMessages = new Map<string, number>();

  /** Evict expired dedup keys to keep memory bounded. */
  function evictExpired() {
    const now = Date.now();
    for (const [key, expiry] of recentMessages) {
      if (now > expiry) recentMessages.delete(key);
    }
  }

  /** Return true if this message was seen recently (duplicate); false and mark if new. */
  function isDuplicate(msg: MlsInboundMessage): boolean {
    evictExpired();
    const key = dedupKey(msg);
    if (recentMessages.has(key)) return true;
    recentMessages.set(key, Date.now() + dedupWindowMs);
    return false;
  }

  async function readNewLines() {
    if (reading || closed) return;
    reading = true;
    scheduled = false;

    try {
      if (!existsSync(logPath)) return;

      const fileStat = statSync(logPath);
      if (fileStat.size < offset) {
        offset = 0; // file truncated/rotated
      }
      if (fileStat.size <= offset) return;

      const stream = createReadStream(logPath, {
        start: offset,
        encoding: "utf-8",
      });

      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let bytesRead = 0;

      for await (const line of rl) {
        bytesRead += Buffer.byteLength(line, "utf-8") + 1;
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);
          if (
            parsed.type === "message" &&
            parsed.allowed === true &&
            parsed.senderPubkey !== selfPubkey &&
            parsed.content
          ) {
            // Filter out typing indicators
            const content = parsed.content.trim();
            if (content === "typing" || content === "stopped_typing") {
              continue;
            }

            const msg = parsed as MlsInboundMessage;

            // Dedup guard: skip messages already dispatched in this window
            if (isDuplicate(msg)) {
              continue;
            }

            onMessage(msg);
          }
        } catch {
          // Skip malformed lines
        }
      }

      offset += bytesRead;
      await saveOffset(offsetPath, offset);
    } catch (err) {
      onError?.(err as Error);
    } finally {
      reading = false;
      // If watch events arrived while we were reading, schedule one more pass
      if (scheduled && !closed) {
        scheduled = false;
        scheduleRead();
      }
    }
  }

  function scheduleRead() {
    if (scheduled || closed) return;
    scheduled = true;
    // Debounce: wait 50ms for fs.watch to settle before reading
    setTimeout(() => {
      if (!closed) readNewLines().catch((e) => onError?.(e as Error));
    }, 50);
  }

  // Initial read
  await readNewLines();

  // Watch for changes
  try {
    watcher = watch(logPath, { persistent: false }, () => {
      scheduleRead();
    });
    watcher.on("error", (err) => onError?.(err));
  } catch (err) {
    onError?.(err as Error);
  }

  return {
    close() {
      closed = true;
      watcher?.close();
    },
  };
}

async function loadOffset(path: string): Promise<number> {
  try {
    const data = await readFile(path, "utf-8");
    const n = parseInt(data.trim(), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

async function saveOffset(path: string, offset: number): Promise<void> {
  try {
    await writeFile(path, String(offset), "utf-8");
  } catch {
    // Best effort
  }
}
