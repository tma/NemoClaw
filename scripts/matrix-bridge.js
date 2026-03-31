#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Matrix → NemoClaw bridge.
 *
 * Messages from Matrix rooms are forwarded to the OpenClaw agent running
 * inside the sandbox. Responses go back to the Matrix room.
 *
 * Runs on the host — credentials never enter the sandbox.
 *
 * Env:
 *   MATRIX_HOMESERVER    — homeserver URL (e.g. https://matrix.example.com)
 *   MATRIX_ACCESS_TOKEN  — bot account access token
 *   NVIDIA_API_KEY       — for inference
 *   SANDBOX_NAME         — sandbox name (default: nemoclaw)
 *   ALLOWED_ROOM_IDS     — comma-separated Matrix room IDs to accept (optional, accepts all if unset)
 */

const {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} = require("matrix-bot-sdk");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const HOMESERVER = process.env.MATRIX_HOMESERVER;
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
try {
  validateName(SANDBOX, "SANDBOX_NAME");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const ALLOWED_ROOMS = process.env.ALLOWED_ROOM_IDS
  ? process.env.ALLOWED_ROOM_IDS.split(",").map((s) => s.trim())
  : null;

if (!HOMESERVER) {
  console.error("MATRIX_HOMESERVER required");
  process.exit(1);
}
if (!ACCESS_TOKEN) {
  console.error("MATRIX_ACCESS_TOKEN required");
  process.exit(1);
}
if (!API_KEY) {
  console.error("NVIDIA_API_KEY required");
  process.exit(1);
}

const busyRooms = new Set();

const COOLDOWN_MS = 5000;
const lastMessageTime = new Map();

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], {
      encoding: "utf-8",
    });

    const confDir = fs.mkdtempSync("/tmp/nemoclaw-mx-ssh-");
    const confPath = `${confDir}/config`;
    fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    const cmd = `export NVIDIA_API_KEY=${shellQuote(API_KEY)} && nemoclaw-start openclaw agent --agent main --local -m ${shellQuote(message)} --session-id ${shellQuote("mx-" + safeSessionId)}`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try {
        fs.unlinkSync(confPath);
        fs.rmdirSync(confDir);
      } catch {
        /* ignored */
      }

      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();

      if (response) {
        resolve(response);
      } else if (code !== 0) {
        resolve(`Agent exited with code ${code}. ${stderr.trim().slice(0, 500)}`);
      } else {
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// ── Matrix message handler ────────────────────────────────────────

async function handleMessage(client, roomId, event) {
  if (event["content"]?.["msgtype"] !== "m.text") return;

  const sender = event["sender"];
  const botUserId = await client.getUserId();
  if (sender === botUserId) return;

  // Access control
  if (ALLOWED_ROOMS && !ALLOWED_ROOMS.includes(roomId)) {
    console.log(`[ignored] room ${roomId} not in allowed list`);
    return;
  }

  const body = event["content"]["body"];
  console.log(`[${roomId}] ${sender}: ${body}`);

  // Handle !reset
  if (body.trim() === "!reset") {
    await client.sendNotice(roomId, "Session reset.");
    return;
  }

  // Rate limiting: per-room cooldown
  const now = Date.now();
  const lastTime = lastMessageTime.get(roomId) || 0;
  if (now - lastTime < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastTime)) / 1000);
    await client.sendNotice(roomId, `Please wait ${wait}s before sending another message.`);
    return;
  }

  // Per-room serialization
  if (busyRooms.has(roomId)) {
    await client.sendNotice(roomId, "Still processing your previous message.");
    return;
  }

  lastMessageTime.set(roomId, now);
  busyRooms.add(roomId);

  // Send typing indicator
  try {
    await client.setTyping(roomId, true, 30000);
  } catch {
    /* ignored */
  }

  try {
    // Room-scoped session ID (strip the leading ! from room IDs)
    const sessionKey = roomId.replace(/[^a-zA-Z0-9-]/g, "");
    const response = await runAgentInSandbox(body, sessionKey);
    console.log(`[${roomId}] agent: ${response.slice(0, 100)}...`);

    // Send response in chunks (Matrix has a ~65535 byte limit but keep chunks readable)
    const chunks = [];
    for (let i = 0; i < response.length; i += 4000) {
      chunks.push(response.slice(i, i + 4000));
    }
    for (const chunk of chunks) {
      await client.sendText(roomId, chunk);
    }
  } catch (err) {
    await client.sendNotice(roomId, `Error: ${err.message}`);
  } finally {
    busyRooms.delete(roomId);
    try {
      await client.setTyping(roomId, false);
    } catch {
      /* ignored */
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const storageDir = path.join(
    process.env.HOME || "/tmp",
    ".nemoclaw",
    "matrix-bridge",
  );
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const storage = new SimpleFsStorageProvider(
    path.join(storageDir, "bot-state.json"),
  );

  const client = new MatrixClient(HOMESERVER, ACCESS_TOKEN, storage);
  AutojoinRoomsMixin.setupOnClient(client);

  let botUserId;
  try {
    botUserId = await client.getUserId();
  } catch (err) {
    console.error("Failed to connect to Matrix homeserver:", err.message);
    process.exit(1);
  }

  client.on("room.message", (roomId, event) =>
    handleMessage(client, roomId, event).catch((err) =>
      console.error(`[${roomId}] handler error:`, err.message),
    ),
  );

  await client.start();

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Matrix Bridge                            │");
  console.log("  │                                                     │");
  console.log(
    `  │  User:      ${(botUserId + "                              ").slice(0, 40)}│`,
  );
  console.log(
    "  │  Homeserver: " +
      (HOMESERVER + "                             ").slice(0, 39) +
      "│",
  );
  console.log(
    "  │  Sandbox:   " +
      (SANDBOX + "                              ").slice(0, 39) +
      "│",
  );
  console.log("  │                                                     │");
  console.log(
    "  │  Messages are forwarded to the OpenClaw agent      │",
  );
  console.log(
    "  │  inside the sandbox. Run 'openshell term' in       │",
  );
  console.log(
    "  │  another terminal to monitor + approve egress.     │",
  );
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
}

main();
