---
title:
  page: "Set Up the NemoClaw Matrix Bridge for Remote Agent Chat"
  nav: "Set Up Matrix Bridge"
description: "Forward messages between Matrix rooms and the sandboxed OpenClaw agent."
keywords: ["nemoclaw matrix bridge", "matrix bot openclaw agent"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "matrix", "deployment", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Set Up the Matrix Bridge

Forward messages between Matrix rooms and the OpenClaw agent running inside the sandbox.
The Matrix bridge is an auxiliary service managed by `nemoclaw start`.

## Prerequisites

- A running NemoClaw sandbox, either local or remote.
- A Matrix homeserver (self-hosted or hosted).
- A Matrix account for the bot with an access token.

## Create a Matrix Bot Account

Create a dedicated account on your Matrix homeserver for the bot. The exact
steps depend on your homeserver software (Synapse, Conduit, Dendrite, etc.).

### Synapse Example

Register the bot user via the admin API or `register_new_matrix_user`:

```console
$ register_new_matrix_user -c /etc/synapse/homeserver.yaml -u nemoclaw-bot -p <password> --no-admin
```

### Obtain an Access Token

Log in as the bot user to get an access token:

```console
$ curl -s -X POST https://matrix.example.com/_matrix/client/v3/login \
    -H 'Content-Type: application/json' \
    -d '{"type":"m.login.password","user":"nemoclaw-bot","password":"<password>"}' \
    | jq -r '.access_token'
```

Save the access token — you will need it in the next step.

## Set the Environment Variables

The bridge reads credentials from environment variables or from
`~/.nemoclaw/credentials.json` (where `nemoclaw onboard` already stores
`NVIDIA_API_KEY`).

Add the Matrix credentials to `~/.nemoclaw/credentials.json` (where
`nemoclaw onboard` already stores `NVIDIA_API_KEY`):

```console
$ node -e "
  const {saveCredential} = require('nemoclaw/bin/lib/credentials');
  saveCredential('MATRIX_HOMESERVER', 'https://matrix.example.com');
  saveCredential('MATRIX_ACCESS_TOKEN', '<your-access-token>');
"
```

Alternatively, export them as environment variables:

```console
$ export MATRIX_HOMESERVER=https://matrix.example.com
$ export MATRIX_ACCESS_TOKEN=<your-access-token>
```

## Start Auxiliary Services

Start the Matrix bridge and other auxiliary services:

```console
$ nemoclaw start
```

The Matrix bridge starts only when both `MATRIX_HOMESERVER` and
`MATRIX_ACCESS_TOKEN` environment variables are set.

The bridge automatically joins rooms when invited (autojoin).

## Verify the Services

Check that the Matrix bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services, including the Matrix bridge.

## Chat with the Agent

Invite the bot user to a Matrix room. Once joined, send a message — the
bridge forwards it to the OpenClaw agent inside the sandbox and posts the
agent response back to the room.

Session continuity is scoped per room. Each room maintains its own
conversation context.

## Restrict Access by Room ID

To restrict which rooms the bot responds in, set the `ALLOWED_ROOM_IDS`
environment variable to a comma-separated list of Matrix room IDs:

```console
$ export ALLOWED_ROOM_IDS='!abc123:example.com,!def456:example.com'
$ nemoclaw start
```

The bot still autojoins all rooms it is invited to but only responds to
messages in the allowed rooms.

## Reset a Session

Send `!reset` in any room to clear the conversation session for that room.

## Stop the Services

To stop the Matrix bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Related Topics

- [Set Up Telegram Bridge](set-up-telegram-bridge.md) for Telegram integration.
- [Commands](../reference/commands.md) for the full `start` and `stop` command reference.
