import { execFile } from "child_process";
import { homedir } from "os";

export interface MlsSendOptions {
  burrowPath: string;
  burrowDir: string;
  keyPath: string;
  groupId: string;
  text: string;
}

export function sendMlsMessage(opts: MlsSendOptions): Promise<void> {
  const { burrowPath, burrowDir, keyPath, groupId, text } = opts;

  // Resolve ~ in paths
  const resolvedKeyPath = keyPath.replace(/^~/, homedir());

  return new Promise((resolve, reject) => {
    execFile(
      burrowPath,
      ["send", groupId, text, "--key-path", resolvedKeyPath],
      {
        cwd: burrowDir,
        env: { ...process.env, HOME: homedir() },
        timeout: 30000,
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
