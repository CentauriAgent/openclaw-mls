import { execFile } from "child_process";
import { homedir } from "os";

export interface MlsSendOptions {
  burrowPath: string;
  burrowDir: string;
  keyPath: string;
  groupId: string;
  text: string;
  mediaPath?: string;
}

export function sendTypingIndicator(opts: { burrowPath: string; burrowDir: string; keyPath: string; groupId: string }): Promise<void> {
  const { burrowPath, burrowDir, keyPath, groupId } = opts;
  const resolvedKeyPath = keyPath.replace(/^~/, homedir());
  const args = ["typing", groupId, "--key-path", resolvedKeyPath];
  return new Promise((resolve, reject) => {
    const resolvedBurrowDir = burrowDir.replace(/^~/, homedir());
    execFile(burrowPath, args, { env: { ...process.env, BURROW_DIR: resolvedBurrowDir } }, (err) => {
      if (err) { reject(err); } else { resolve(); }
    });
  });
}

export function sendMlsMessage(opts: MlsSendOptions): Promise<void> {
  const { burrowPath, burrowDir, keyPath, groupId, text, mediaPath } = opts;

  const resolvedKeyPath = keyPath.replace(/^~/, homedir());

  const args = ["send", groupId, text, "--key-path", resolvedKeyPath];
  if (mediaPath) {
    args.push("--media", mediaPath);
  }

  return new Promise((resolve, reject) => {
    execFile(
      burrowPath,
      args,
      {
        cwd: burrowDir,
        env: { ...process.env, HOME: homedir() },
        timeout: 60000,
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`burrow send failed: ${stderr || error.message}`));
        } else {
          resolve();
        }
      },
    );
  });
}

/** Generate speech from text using OpenAI TTS API */
export async function textToSpeech(text: string, outputPath: string): Promise<void> {
  const fs = await import("fs");
  const path = await import("path");

  const keyPath = path.join(homedir(), ".openclaw/credentials/openai-whisper.key");
  let apiKey: string;
  try {
    apiKey = fs.readFileSync(keyPath, "utf-8").trim();
  } catch {
    throw new Error("OpenAI API key not found");
  }

  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      [
        "-s",
        "https://api.openai.com/v1/audio/speech",
        "-H", `Authorization: Bearer ${apiKey}`,
        "-H", "Content-Type: application/json",
        "-d", JSON.stringify({
          model: "tts-1",
          input: text,
          voice: "nova",
          response_format: "aac",
        }),
        "--output", outputPath,
      ],
      { timeout: 30000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`TTS failed: ${stderr || error.message}`));
        } else {
          // Verify the output file exists and has content
          try {
            const stat = fs.statSync(outputPath);
            if (stat.size < 100) {
              reject(new Error("TTS output file too small — likely an error response"));
            } else {
              resolve();
            }
          } catch {
            reject(new Error("TTS output file not created"));
          }
        }
      },
    );
  });
}

/** Transcribe audio file using OpenAI Whisper API */
export async function transcribeAudio(audioPath: string): Promise<string> {
  const fs = await import("fs");
  const path = await import("path");

  // Read API key
  const keyPath = path.join(homedir(), ".openclaw/credentials/openai-whisper.key");
  let apiKey: string;
  try {
    apiKey = fs.readFileSync(keyPath, "utf-8").trim();
  } catch {
    throw new Error("Whisper API key not found at ~/.openclaw/credentials/openai-whisper.key");
  }

  // Use curl since we don't have form-data deps
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      [
        "-s",
        "https://api.openai.com/v1/audio/transcriptions",
        "-H", `Authorization: Bearer ${apiKey}`,
        "-F", `file=@${audioPath}`,
        "-F", "model=whisper-1",
      ],
      { timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Whisper transcription failed: ${stderr || error.message}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          resolve(result.text || "");
        } catch {
          reject(new Error(`Failed to parse Whisper response: ${stdout}`));
        }
      },
    );
  });
}
