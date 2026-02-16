import type { OpenClawConfig } from "openclaw/plugin-sdk";

export interface MlsAccountConfig {
  enabled?: boolean;
  burrowPath?: string;
  burrowDir?: string;
  dataDir?: string;
  keyPath?: string;
  selfPubkey?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  allowGroups?: string[];
  identities?: Record<string, string>;
}

export interface ResolvedMlsAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  selfPubkey: string;
  burrowPath: string;
  burrowDir: string;
  dataDir: string;
  keyPath: string;
  allowFrom: string[];
  allowGroups: string[];
  identities: Record<string, string>;
  config: MlsAccountConfig;
}

const DEFAULT_ACCOUNT_ID = "default";

function getMlsConfig(cfg: OpenClawConfig): MlsAccountConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.mls as MlsAccountConfig | undefined;
}

export function listMlsAccountIds(cfg: OpenClawConfig): string[] {
  const mlsCfg = getMlsConfig(cfg);
  if (mlsCfg?.selfPubkey) return [DEFAULT_ACCOUNT_ID];
  return [];
}

export function resolveDefaultMlsAccountId(cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveMlsAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMlsAccount {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const mlsCfg = getMlsConfig(opts.cfg);

  const selfPubkey = mlsCfg?.selfPubkey ?? "";
  const configured = Boolean(selfPubkey.trim() && mlsCfg?.burrowPath);

  return {
    accountId,
    enabled: mlsCfg?.enabled !== false,
    configured,
    selfPubkey,
    burrowPath: mlsCfg?.burrowPath ?? "burrow",
    burrowDir: mlsCfg?.burrowDir ?? ".",
    dataDir: mlsCfg?.dataDir ?? "~/.burrow",
    keyPath: mlsCfg?.keyPath ?? "~/.clawstr/secret.key",
    allowFrom: mlsCfg?.allowFrom ?? [],
    allowGroups: mlsCfg?.allowGroups ?? [],
    identities: mlsCfg?.identities ?? {},
    config: mlsCfg ?? {},
  };
}
