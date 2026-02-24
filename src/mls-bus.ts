import { watch, createReadStream, statSync, existsSync } from "fs";
import { readFile, writeFile, stat } from "fs/promises";
import { createInterface } from "readline";
import { join } from "path";
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
}

export interface MlsBusHandle {
  close(): void;
}

export async function startMlsBus(opts: MlsBusOptions): Promise<MlsBusHandle> {
  const { logPath, offsetPath, selfPubkey, onMessage, onError } = opts;

  let offset = await loadOffset(offsetPath);
  let watcher: FSWatcher | null = null;
  let reading = false;
  let closed = false;

  // Dedup: track recent message hashes to filter relay duplicates
  const DEDUP_WINDOW_MS = 30_000; // 30 seconds
  const DEDUP_MAX_SIZE = 200;
  const recentHashes = new Map<string, number>(); // hash -> timestamp

  function dedup(msg: { senderPubkey: string; groupId: string; content: string }): boolean {
    const key = `${msg.senderPubkey}:${msg.groupId}:${msg.content}`;
    const now = Date.now();

    // Prune old entries
    if (recentHashes.size > DEDUP_MAX_SIZE) {
      for (const [k, ts] of recentHashes) {
        if (now - ts > DEDUP_WINDOW_MS) recentHashes.delete(k);
      }
    }

    if (recentHashes.has(key)) return true; // duplicate
    recentHashes.set(key, now);
    return false;
  }

  async function readNewLines() {
    if (reading || closed) return;
    reading = true;
    const readId = Date.now();

    try {
      if (!existsSync(logPath)) {
        reading = false;
        return;
      }

      const fileStat = statSync(logPath);
      if (fileStat.size <= offset) {
        // File may have been truncated/rotated
        if (fileStat.size < offset) {
          offset = 0;
        }
        reading = false;
        return;
      }

      const stream = createReadStream(logPath, {
        start: offset,
        encoding: "utf-8",
      });

      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let bytesRead = 0;

      for await (const line of rl) {
        bytesRead += Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);
          if (
            parsed.type === "message" &&
            parsed.allowed === true &&
            parsed.senderPubkey !== selfPubkey &&
            parsed.content
          ) {
            if (!dedup(parsed)) {
              console.error(`[mls-bus][${readId}] DELIVER: ${parsed.content?.slice(0, 40)} (offset=${offset})`);
              onMessage(parsed as MlsInboundMessage);
            } else {
              console.error(`[mls-bus][${readId}] DEDUP-SKIP: ${parsed.content?.slice(0, 40)}`);
            }
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
    }
  }

  // Initial read
  await readNewLines();

  // Watch for changes
  try {
    watcher = watch(logPath, { persistent: false }, () => {
      readNewLines().catch((e) => onError?.(e as Error));
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
