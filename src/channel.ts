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
import { sendMlsMessage } from "./mls-transport.js";
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

      const bus = await startMlsBus({
        logPath,
        offsetPath,
        selfPubkey: account.selfPubkey,
        onMessage: async (msg) => {
          const senderName = displayName(msg.senderPubkey);
          ctx.log?.info?.(`[${account.accountId}] inbound from ${senderName} in group ${msg.groupId}: ${msg.content.slice(0, 80)}`);

          // Build session key: mls:<groupId>
          const sessionKey = `mls:${msg.groupId}`;

          // Build MsgContext for the OpenClaw dispatch pipeline
          const msgContext = {
            Body: msg.content,
            RawBody: msg.content,
            CommandBody: msg.content,
            BodyForCommands: msg.content,
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
              await sendMlsMessage({
                burrowPath: account.burrowPath,
                burrowDir: account.burrowDir,
                keyPath: account.keyPath,
                groupId: mlsGroupId,
                text,
              });
              ctx.log?.info?.(`[${account.accountId}] sent reply to MLS group ${mlsGroupId}`);
            } catch (err) {
              ctx.log?.error?.(`[${account.accountId}] Failed to send MLS reply: ${(err as Error).message}`);
            }
          };

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

      return {
        stop: () => {
          bus.close();
          activeBuses.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] MLS channel stopped`);
        },
      };
    },
  },
};
