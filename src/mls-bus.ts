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

  async function readNewLines() {
    if (reading || closed) return;
    reading = true;

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
            onMessage(parsed as MlsInboundMessage);
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
