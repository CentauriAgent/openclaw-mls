# @openclaw/mls

**MLS encrypted group messaging channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).**

Give your AI agent end-to-end encrypted messaging — no phone numbers, no central servers. Built on the [Marmot protocol](https://github.com/marmot-protocol) (MLS + Nostr).

## What This Does

This plugin connects OpenClaw to [Burrow](https://github.com/CentauriAgent/burrow), an MLS messenger that runs on Nostr relays. Your agent gets a full encrypted messaging channel — just like Signal, Discord, or Telegram — but decentralized and E2E encrypted.

```
You (Burrow app) ←→ Nostr relays ←→ Burrow daemon ←→ MLS plugin ←→ OpenClaw agent
                         MLS encrypted                    JSONL        full session
```

**Your agent gets:**
- 🔒 End-to-end encrypted group messaging (MLS / RFC 9420)
- 💬 Full conversation history and session continuity
- 🛠️ All OpenClaw tools (search, browser, exec, memory, etc.)
- 🆔 Identity mapping (Nostr pubkeys → human-readable names)
- 🔐 Allowlist-based access control
- ⚡ Real-time message delivery via `fs.watch`

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- [Burrow](https://github.com/CentauriAgent/burrow) CLI built from source
- Burrow daemon running (`systemctl --user start burrow` or `burrow daemon`)
- A Nostr keypair (hex secret key)
- Membership in at least one MLS group

## Install

### Option A: Clone to extensions directory (recommended)

```bash
git clone https://github.com/CentauriAgent/openclaw-mls.git ~/.openclaw/extensions/mls
```

### Option B: Manual

```bash
mkdir -p ~/.openclaw/extensions/mls
cd ~/.openclaw/extensions/mls
# Copy all files from this repo
```

## Configure

Add the MLS channel and plugin to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "channels": {
    "mls": {
      "enabled": true,
      "burrowPath": "/path/to/burrow/target/release/burrow",
      "burrowDir": "/path/to/burrow",
      "dataDir": "~/.burrow",
      "keyPath": "~/.clawstr/secret.key",
      "selfPubkey": "YOUR_HEX_PUBKEY",
      "dmPolicy": "allowlist",
      "allowFrom": [
        "ALLOWED_CONTACT_HEX_PUBKEY"
      ],
      "identities": {
        "CONTACT_HEX_PUBKEY": "Alice",
        "YOUR_HEX_PUBKEY": "MyAgent"
      }
    }
  },
  "plugins": {
    "entries": {
      "mls": { "enabled": true }
    },
    "installs": {
      "mls": {
        "source": "npm",
        "installPath": "/home/YOU/.openclaw/extensions/mls"
      }
    }
  }
}
```

### Config Reference

| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | yes | Enable/disable the channel |
| `burrowPath` | yes | Path to the `burrow` binary |
| `burrowDir` | yes | Working directory for burrow commands |
| `dataDir` | no | Burrow data directory (default: `~/.burrow`) |
| `keyPath` | no | Path to Nostr secret key (default: `~/.clawstr/secret.key`) |
| `selfPubkey` | yes | Your agent's hex pubkey (to skip own messages) |
| `dmPolicy` | no | Access policy: `allowlist`, `pairing`, `open`, `disabled` (default: `allowlist`) |
| `allowFrom` | no | Array of hex pubkeys allowed to message the agent |
| `allowGroups` | no | Array of group IDs to listen to (empty = all) |
| `identities` | no | Map of hex pubkey → display name |

## How It Works

### Inbound (receiving messages)

1. Burrow daemon decrypts MLS messages and writes JSONL to `~/.burrow/daemon.jsonl`
2. The plugin tails this file using `fs.watch` (no polling)
3. Messages are filtered: must be `type: "message"`, `allowed: true`, and not from self
4. Valid messages are dispatched through OpenClaw's full agent pipeline
5. The agent responds with full tool access, memory, and conversation history

### Outbound (sending messages)

1. The agent produces a response
2. The plugin calls `burrow send <group-id> "<message>"` as a subprocess
3. Burrow encrypts via MLS and publishes to Nostr relays
4. Recipients decrypt in their Burrow app or CLI

### Session routing

Each MLS group gets its own OpenClaw session (`mls:<groupId>`), providing isolated conversation history per group — just like how Discord servers or Signal groups each get their own session.

## Architecture

```
~/.openclaw/extensions/mls/
├── openclaw.plugin.json    # Plugin manifest
├── package.json            # Package metadata
├── index.ts                # Entry point — registers the channel
└── src/
    ├── channel.ts          # ChannelPlugin implementation
    ├── mls-bus.ts          # Inbound: tails daemon.jsonl via fs.watch
    ├── mls-transport.ts    # Outbound: wraps `burrow send` subprocess
    ├── runtime.ts          # Runtime context holder
    └── types.ts            # Account resolution and config types
```

## Verify It's Working

After restarting OpenClaw, check the logs:

```bash
journalctl --user -u openclaw --since "5 min ago" | grep "\[mls\]"
```

You should see:
```
[mls] [default] starting MLS channel (selfPubkey: 90d8d489...)
[mls] [default] MLS channel started, tailing /home/you/.burrow/daemon.jsonl
```

When a message arrives:
```
[mls] [default] inbound from Alice in group dd677bac...: hello!
[mls] [default] sent reply to MLS group ce7f130c...
```

## Upgrade Safety

The plugin lives at `~/.openclaw/extensions/mls/` — completely outside the OpenClaw npm install path. Running `npm i -g openclaw@latest` will never touch it.

## Troubleshooting

**Plugin not loading?**
- Check `plugins.entries.mls.enabled` is `true` in config
- Check `plugins.installs.mls.installPath` points to the correct directory
- Restart OpenClaw: `/restart` or `openclaw gateway restart`

**Messages not arriving?**
- Verify Burrow daemon is running: `systemctl --user status burrow`
- Check `daemon.jsonl` has new entries: `tail -5 ~/.burrow/daemon.jsonl`
- Check offset isn't ahead of file: `cat ~/.burrow/openclaw-offset.txt` vs `wc -c ~/.burrow/daemon.jsonl`
- Reset offset if needed: `echo "0" > ~/.burrow/openclaw-offset.txt` (will replay all messages)

**Replies not sending?**
- Test manually: `burrow send <group-id> "test message"`
- Check the `burrowPath` in config points to a valid binary
- Check `keyPath` is readable

**Messages arriving but no agent response?**
- Check `allowFrom` includes the sender's hex pubkey
- Check `selfPubkey` is set correctly (prevents echo loop)

## Links

- **OpenClaw**: [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
- **Burrow**: [github.com/CentauriAgent/burrow](https://github.com/CentauriAgent/burrow)
- **Marmot Protocol**: [github.com/marmot-protocol](https://github.com/marmot-protocol)
- **MLS RFC 9420**: [datatracker.ietf.org/doc/rfc9420](https://datatracker.ietf.org/doc/rfc9420/)

## License

MIT
