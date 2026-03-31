# NemoClaw Matrix Bridge — Build Context

## Session: 2026-03-31

### What we built

Host-side Matrix bridge for NemoClaw, following the proven Telegram bridge
pattern. Branch `feat/matrix-bridge` on `tma/NemoClaw` (forked from
`NVIDIA/NemoClaw`).

### Files changed

| File | Change |
|------|--------|
| `scripts/matrix-bridge.js` | New — host-side bridge using `matrix-bot-sdk` |
| `scripts/start-services.sh` | Added Matrix bridge lifecycle (start/stop/status) |
| `docs/deployment/set-up-matrix-bridge.md` | New — setup guide mirroring Telegram docs |
| `package.json` | Added `matrix-bot-sdk` `^0.8.0` dependency |

### Design decisions

- **Host-side bridge, not sandbox plugin.** This follows the Telegram bridge
  pattern and aligns with issue #618 which proposes moving all channels to
  host-side bridges. Credentials never enter the sandbox.
- **`matrix-bot-sdk`** (not `matrix-js-sdk`). Simpler API for bots, handles
  sync loop, autojoin mixin. No encryption support yet — can add
  `RustSdkCryptoStorageProvider` later.
- **Room-scoped sessions.** Each Matrix room gets its own `--session-id`
  (`mx-<sanitized-room-id>`), matching how Discord PRs use channel-scoped
  sessions (`dc-ch-<channelId>`).
- **Autojoin on invite.** Bot joins any room it's invited to. Access control
  via `ALLOWED_ROOM_IDS` filters which rooms get responses.
- **Bot state stored at** `~/.nemoclaw/matrix-bridge/bot-state.json` with
  `0700` permissions, keeping it alongside other NemoClaw state.

### Env vars

The bridge uses `getCredential()` from NemoClaw's credential system, which
checks env vars first, then falls back to `~/.nemoclaw/credentials.json`.

`NVIDIA_API_KEY` is already stored there by `nemoclaw onboard` — no env var
needed for inference.

| Var | Required | Source |
|-----|----------|--------|
| `MATRIX_HOMESERVER` | Yes | env or `credentials.json` |
| `MATRIX_ACCESS_TOKEN` | Yes | env or `credentials.json` |
| `NVIDIA_API_KEY` | Yes | already in `credentials.json` from onboard |
| `SANDBOX_NAME` | No | defaults to `nemoclaw` |
| `ALLOWED_ROOM_IDS` | No | comma-separated, accepts all if unset |

To persist Matrix creds alongside the API key (one-time):

```bash
sudo incus exec agent -- bash -lc '
  cd ~/.nemoclaw
  cat credentials.json \
    | jq ". + {MATRIX_HOMESERVER: \"https://matrix.53cr37.co\", MATRIX_ACCESS_TOKEN: \"syt_...\"}" \
    > credentials.json.tmp && mv credentials.json.tmp credentials.json
  chmod 600 credentials.json
'
```

### How to test on the agent VM

```bash
# 1. Install the fork branch globally (replaces stock nemoclaw)
sudo incus exec agent -- bash -lc \
  'npm install -g github:tma/NemoClaw#feat/matrix-bridge'

# 2. Create bot account on Matrix homeserver, get access token:
curl -s -X POST https://matrix.53cr37.co/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","user":"nemoclaw-bot","password":"<pw>"}' \
  | jq -r '.access_token'

# 3. Add Matrix creds to credentials.json (NVIDIA_API_KEY already there from onboard)
sudo incus exec agent -- bash -lc '
  cd ~/.nemoclaw
  cat credentials.json \
    | jq ". + {MATRIX_HOMESERVER: \"https://matrix.53cr37.co\", MATRIX_ACCESS_TOKEN: \"syt_...\"}" \
    > credentials.json.tmp && mv credentials.json.tmp credentials.json
  chmod 600 credentials.json
'

# 4. Test bridge directly (interactive, see output)
sudo incus exec agent -- bash -lc '
  export SANDBOX_NAME=nemo
  node ~/.nemoclaw/source/scripts/matrix-bridge.js
'

# 5. Once working, use service manager
sudo incus exec agent -- bash -lc '
  export SANDBOX_NAME=nemo
  nemoclaw start
'
```

### Test checklist

- [ ] Autojoin works when bot is invited to a room
- [ ] Messages are relayed to sandbox agent and responses posted back
- [ ] Typing indicator shows while agent is processing
- [ ] Long responses are chunked correctly
- [ ] `!reset` clears the session for that room
- [ ] `ALLOWED_ROOM_IDS` filtering works (bot joins but doesn't respond)
- [ ] Bot handles being kicked and re-invited
- [ ] Per-room session isolation (two rooms = two conversations)
- [ ] Rate limiting works (5s cooldown per room)
- [ ] Busy-room serialization (rejects concurrent messages in same room)

### Research findings

#### NemoClaw architecture (alpha, launched 2026-03-16)

Three independently-versioned components:
- **CLI** — npm package (`npm update -g nemoclaw`)
- **Blueprint** — Python artifact, resolved + digest-verified at onboard time
- **OpenShell** — separate binary, separate release stream

No tagged releases yet — `main` is the install path.

#### Updating

- No `nemoclaw update` command exists
- CLI: `npm update -g nemoclaw`
- Sandbox: destroy + re-onboard (immutable container image)
- OpenClaw inside sandbox: cannot be updated in-place (read-only filesystem)

#### Backup gap

`backup-workspace.sh` (official, at `~/.nemoclaw/source/scripts/`) only covers
workspace files (SOUL.md, USER.md, IDENTITY.md, AGENTS.md, MEMORY.md,
`memory/`). Does NOT back up:
- `~/.openclaw/openclaw.json` (agent config, channel accounts, model settings)
- `~/.openclaw/agents/` (per-agent config, session data)

No upstream issue filed for this yet. Noted in `node-srv` readme.

#### Channel support status

| Channel | Where it runs | Credentials | Status |
|---------|--------------|-------------|--------|
| Telegram | Host (bridge) | Host-only | ✅ Paved path |
| Discord | Sandbox (plugin) | Sandbox env var | Broken (#599, #606) |
| Slack | Sandbox (plugin) | Sandbox env var | Same as Discord |
| Matrix | Not supported | — | Our PR adds this |

Issue #618 proposes moving all channels to the Telegram host-side bridge
pattern. Community Discord bridge PRs exist (#422, #458) but aren't merged.

#### Known bugs affecting us

- **#719** — Config read-only inside sandbox after onboarding. Blocks
  network policy, gateway config, Traefik integration.
- **#618** — Tracking issue for host-side bridge architecture for all channels.
- **VM restart loses sandbox** — Docker container recreated, needs re-onboard.

### Related changes in node-srv

Updated `apps/nemoclaw/readme.md` with:
- Update section (CLI vs sandbox vs OpenShell)
- Backup/restore workflow using `backup-workspace.sh`
- Correct script path (`~/.nemoclaw/source/scripts/backup-workspace.sh`)
- Note about backup gap (OpenClaw config not backed up)

### Next steps

- [ ] Test the bridge on the agent VM
- [ ] Fix any issues found during testing
- [ ] Open PR against `NVIDIA/NemoClaw` referencing #618
- [ ] File upstream issue for backup-workspace.sh not covering OpenClaw config
- [ ] Consider adding encryption support (`RustSdkCryptoStorageProvider`)
