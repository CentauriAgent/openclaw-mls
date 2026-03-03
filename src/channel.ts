import {
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type ChannelAccountSnapshot,
} from "openclaw/plugin-sdk";

function formatPairingApproveHint(channel: string): string {
  return `To approve, add the sender's pubkey to channels.${channel}.allowFrom in your config.`;
}
import { startMlsBus, type MlsBusHandle } from "./mls-bus.js";
import { sendMlsMessage, sendTypingIndicator, transcribeAudio, textToSpeech } from "./mls-transport.js";
import { getMlsRuntime } from "./runtime.js";
import {
  listMlsAccountIds,
  resolveDefaultMlsAccountId,
  resolveMlsAccount,
  type ResolvedMlsAccount,
} from "./types.js";
import { homedir } from "os";
import { join } from "path";

const activeBuses = new Map<string, MlsBusHandle>();

export const mlsPlugin: ChannelPlugin<ResolvedMlsAccount> = {
  id: "mls",
  meta: {
    id: "mls",
    label: "MLS",
    selectionLabel: "MLS (Encrypted Group Messaging)",
    docsPath: "/channels/mls",
    docsLabel: "mls",
    blurb: "End-to-end encrypted group messaging via MLS protocol",
    order: 60,
  },
  capabilities: {
    chatTypes: ["group"],
    media: false,
  },
  reload: { configPrefixes: ["channels.mls"] },

  config: {
    listAccountIds: (cfg) => listMlsAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMlsAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMlsAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      selfPubkey: account.selfPubkey,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveMlsAccount({ cfg, accountId }).allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((e) => String(e).trim()).filter(Boolean),
  },

  pairing: {
    idLabel: "mlsPubkey",
    normalizeAllowEntry: (entry) => entry.trim().toLowerCase(),
  },

  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "allowlist",
      allowFrom: account.allowFrom,
      policyPath: "channels.mls.dmPolicy",
      allowFromPath: "channels.mls.allowFrom",
      approveHint: formatPairingApproveHint("mls"),
      normalizeEntry: (raw) => raw.trim().toLowerCase(),
    }),
  },

  messaging: {
    normalizeTarget: (target) => target.trim().toLowerCase(),
    targetResolver: {
      looksLikeId: (input) => /^[0-9a-fA-F]{32,64}$/.test(input.trim()),
      hint: "<mls-group-id>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendMedia: async () => {
      throw new Error("MLS channel does not support media");
    },
    sendText: async ({ to, text, accountId }) => {
      const runtime = getMlsRuntime();
      const cfg = runtime.config.loadConfig();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const account = resolveMlsAccount({ cfg, accountId: aid });

      if (!account.configured) {
        throw new Error("MLS channel not configured");
      }

      // The `to` is the group ID — use the MLS group ID for sending
      await sendMlsMessage({
        burrowPath: account.burrowPath,
        burrowDir: account.burrowDir,
        keyPath: account.keyPath,
        groupId: to,
        text: text ?? "",
      });

      return {
        channel: "mls" as const,
        to,
        messageId: `mls-${Date.now()}`,
      };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    } as unknown as ReturnType<typeof collectStatusIssuesFromLastError> extends unknown ? any : never,
    collectStatusIssues: (accounts: any) => collectStatusIssuesFromLastError("mls", accounts),
    buildAccountSnapshot: ({ account, runtime }: { account: ResolvedMlsAccount; runtime?: any }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      selfPubkey: account.selfPubkey,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        selfPubkey: account.selfPubkey,
      });
      ctx.log?.info(`[${account.accountId}] starting MLS channel (selfPubkey: ${account.selfPubkey})`);

      if (!account.configured) {
        throw new Error("MLS channel not configured — need selfPubkey and burrowPath");
      }

      const runtime = getMlsRuntime();
      const dataDir = account.dataDir.replace(/^~/, homedir());
      const logPath = join(dataDir, "daemon.jsonl");
      const offsetPath = join(dataDir, "openclaw-offset.txt");

      // Resolve identity display names
      const identities = account.identities;
      function displayName(pubkey: string): string {
        return identities[pubkey] ?? pubkey.slice(0, 8);
      }

      // MLS group ID for outbound (32-char hex, distinct from Nostr group ID)
      const mlsGroupId = "ce7f130ce1c36e46a4a9ad1caebed214";

      // Keepalive: update lastEventAt every 5 minutes so the health monitor
      // doesn't mark the channel as "stuck" during quiet periods.
      // DEFAULT_STALE_EVENT_THRESHOLD_MS is 30 min; 5 min is well within that.
      const keepaliveIntervalMs = 5 * 60_000;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

      function touchLastEventAt() {
        ctx.setStatus?.({
          accountId: account.accountId,
          selfPubkey: account.selfPubkey,
          lastEventAt: Date.now(),
        } as any);
      }

      keepaliveTimer = setInterval(() => {
        if (!closed) touchLastEventAt();
      }, keepaliveIntervalMs);

      // Touch immediately so lastEventAt is set from the start
      touchLastEventAt();

      const bus = await startMlsBus({
        logPath,
        offsetPath,
        selfPubkey: account.selfPubkey,
        onMessage: async (msg) => {
          // Touch lastEventAt on every inbound message so health monitor
          // knows the channel is alive and actively receiving.
          touchLastEventAt();
          const senderName = displayName(msg.senderPubkey);
          ctx.log?.info?.(`[${account.accountId}] inbound from ${senderName} in group ${msg.groupId}: ${msg.content.slice(0, 80)}`);

          let messageBody = msg.content;
          let isVoiceMessage = false;

          // Detect media attachments: [📎 filename -> /path/to/file]
          const mediaMatch = msg.content.match(/\[📎\s+(.+?)\s+->\s+(.+?)\]/);
          if (mediaMatch) {
            const [, filename, filePath] = mediaMatch;
            const ext = filename.split('.').pop()?.toLowerCase() ?? '';
            const audioExts = ['m4a', 'mp3', 'wav', 'ogg', 'opus', 'webm', 'flac', 'aac'];

            if (audioExts.includes(ext)) {
              isVoiceMessage = true;
              ctx.log?.info?.(`[${account.accountId}] Voice message detected: ${filename}`);
              try {
                const transcription = await transcribeAudio(filePath);
                messageBody = `[Voice message from ${senderName}]: "${transcription}"`;
                ctx.log?.info?.(`[${account.accountId}] Transcribed: ${transcription.slice(0, 80)}`);
              } catch (err) {
                ctx.log?.error?.(`[${account.accountId}] Transcription failed: ${(err as Error).message}`);
                messageBody = `[Voice message from ${senderName} - transcription failed. Audio file: ${filePath}]`;
              }
            }
          }

          // Build session key: mls:<groupId>
          const sessionKey = `mls:${msg.groupId}`;

          // Build MsgContext for the OpenClaw dispatch pipeline
          const msgContext = {
            Body: messageBody,
            RawBody: messageBody,
            CommandBody: messageBody,
            BodyForCommands: messageBody,
            From: msg.senderPubkey,
            To: account.selfPubkey,
            SessionKey: sessionKey,
            AccountId: account.accountId,
            MessageSid: `mls-${Date.now()}`,
            ChatType: "group" as const,
            SenderName: senderName,
            SenderId: msg.senderPubkey,
            Provider: "mls",
            Surface: "mls",
            OriginatingChannel: "mls" as any,
            OriginatingTo: msg.groupId,
            Timestamp: Date.now(),
            CommandAuthorized: true,
          };

          // Create a deliver function that sends via burrow
          const deliver = async (payload: { text?: string; media?: unknown }) => {
            const text = payload.text;
            if (!text?.trim()) return;
            try {
              // Always send text reply
              await sendMlsMessage({
                burrowPath: account.burrowPath,
                burrowDir: account.burrowDir,
                keyPath: account.keyPath,
                groupId: mlsGroupId,
                text,
              });
              ctx.log?.info?.(`[${account.accountId}] sent reply to MLS group ${mlsGroupId}`);

              // If inbound was a voice message, also send a voice reply
              if (isVoiceMessage) {
                try {
                  const { join } = await import("path");
                  const ttsPath = join(dataDir, "media", `reply-${Date.now()}.m4a`);
                  // Truncate long responses for TTS (max ~500 chars)
                  const ttsText = text.length > 500 ? text.slice(0, 497) + "..." : text;
                  await textToSpeech(ttsText, ttsPath);
                  await sendMlsMessage({
                    burrowPath: account.burrowPath,
                    burrowDir: account.burrowDir,
                    keyPath: account.keyPath,
                    groupId: mlsGroupId,
                    text: "",
                    mediaPath: ttsPath,
                  });
                  ctx.log?.info?.(`[${account.accountId}] sent voice reply to MLS group ${mlsGroupId}`);
                } catch (ttsErr) {
                  ctx.log?.error?.(`[${account.accountId}] Voice reply failed: ${(ttsErr as Error).message}`);
                }
              }
            } catch (err) {
              ctx.log?.error?.(`[${account.accountId}] Failed to send MLS reply: ${(err as Error).message}`);
            }
          };

          // Send typing indicator before processing
          try {
            await sendTypingIndicator({
              burrowPath: account.burrowPath,
              burrowDir: account.burrowDir,
              keyPath: account.keyPath,
              groupId: mlsGroupId,
            });
          } catch (e) {
            ctx.log?.error?.(`[${account.accountId}] typing indicator failed: ${(e as Error).message}`);
          }

          try {
            const cfg = runtime.config.loadConfig();
            await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgContext,
              cfg,
              dispatcherOptions: {
                deliver: deliver as any,
                onError: (err: any) => {
                  ctx.log?.error?.(`[${account.accountId}] dispatch error: ${err?.message ?? err}`);
                },
              },
            });
          } catch (err) {
            ctx.log?.error?.(`[${account.accountId}] dispatchReply failed: ${(err as Error).message}`);
          }
        },
        onError: (err) => {
          ctx.log?.error?.(`[${account.accountId}] MLS bus error: ${err.message}`);
        },
      });

      activeBuses.set(account.accountId, bus);
      ctx.log?.info(`[${account.accountId}] MLS channel started, tailing ${logPath}`);

      // Return a long-lived promise that only resolves when aborted/stopped.
      // OpenClaw expects startAccount to stay alive; if it resolves, it auto-restarts.
      let closed = false;
      return new Promise<void>((resolve) => {
        const onAbort = () => {
          closed = true;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          bus.close();
          activeBuses.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] MLS channel stopped`);
          resolve();
        };
        if (ctx.abortSignal) {
          ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
  },
};
