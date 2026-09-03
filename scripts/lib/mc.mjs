/**
 * Thin, hardened wrapper around scripts/mcity-control.mjs.
 *
 * - every helper call gets a 90s timeout (a dead socket must not hang the loop)
 * - transient network errors are retried 3x with 10s spacing
 * - lease errors surface immediately so the caller can reconnect
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const scriptsDir = path.resolve(here, "..");
export const rootDir = path.resolve(scriptsDir, "..");
export const dataDir = path.join(rootDir, "data");
const helper = path.join(scriptsDir, "mcity-control.mjs");

export const ts = () => new Date().toISOString().slice(11, 19);
export const log = (...a) => console.log(`[${ts()}]`, ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (min, max) => min + Math.random() * (max - min);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const TRANSIENT = /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|50[234]/i;
export const LEASE_ERROR = /expired|no longer active|another controller|lease/i;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function run(...args) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = execFileSync(process.execPath, [helper, ...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 90_000,
        killSignal: "SIGKILL",
      });
      try {
        return JSON.parse(out);
      } catch {
        throw new Error(`helper returned non-JSON for ${args[0]}: ${out.slice(0, 200)}`);
      }
    } catch (e) {
      lastError = e;
      const msg = (e.stderr || e.stdout || e.message || "").toString();
      if (!TRANSIENT.test(msg) || attempt === 3) throw e;
      log(`transient error on '${args[0]}' (${attempt}/3): ${msg.trim().split("\n")[0]}`);
      sleepSync(10_000);
    }
  }
  throw lastError;
}

export function tryRun(...args) {
  try {
    return { ok: true, data: run(...args) };
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || "").toString().trim().split("\n")[0];
    return { ok: false, error: msg };
  }
}

// ---------- lease ----------
export const lease = { agentId: "", lastHeartbeat: 0 };
const HEARTBEAT_MS = 60_000;

export function touch() {
  lease.lastHeartbeat = Date.now();
}

export async function connect(agentId = process.env.MCITY_AGENT_ID || "") {
  let id = agentId;
  if (!id) {
    const c = run("claimable");
    id = c.agentIds?.[0];
    if (!id) throw new Error("no claimable agent for this token");
  }
  const r = run("connect", id);
  if (!r.connected) throw new Error("connect failed");
  lease.agentId = id;
  touch();
  log(`connected to ${id}`);
  return id;
}

export async function keepAlive() {
  if (Date.now() - lease.lastHeartbeat < HEARTBEAT_MS) return;
  const r = tryRun("heartbeat");
  if (r.ok) {
    touch();
  } else if (LEASE_ERROR.test(r.error)) {
    log("lease lost ->", r.error);
    await connect(lease.agentId);
  }
}

/** Run an action; on lease loss reconnect once and retry. */
export async function action(...args) {
  let r = tryRun(...args);
  touch();
  if (!r.ok && LEASE_ERROR.test(r.error)) {
    log(`lease problem during ${args[0]} -> ${r.error}; reconnecting`);
    await sleep(3_000);
    try {
      await connect(lease.agentId);
      r = tryRun(...args);
      touch();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return r;
}

// ---------- reads ----------
export function getContext() {
  return run("context").agent;
}

export function getInventory() {
  const d = run("inventory");
  const inv = d.inventory || {};
  return {
    inv,
    coins: inv.meme_coin || 0,
    crystal: inv.crystal || 0,
    load: d.load?.state || "normal",
    workSpeed: d.load?.workSpeedPercent ?? 100,
  };
}

export function getNeeds() {
  const n = run("needs");
  return { hunger: n.hunger?.value ?? 0, state: n.hunger?.state ?? "unknown" };
}

/**
 * Wait until the agent has no active action.
 * `onTick` runs on every poll (used to answer conversations while busy).
 */
export async function waitIdle(label, { maxMs = 6 * 60_000, pollMs = 15_000, onTick = null } = {}) {
  const start = Date.now();
  for (;;) {
    const a = getContext();
    if (!a.activeAction) return a;
    if (Date.now() - start > maxMs) {
      log(`${label}: still '${a.activeAction.kind}' after ${Math.round(maxMs / 1000)}s, continuing anyway`);
      return a;
    }
    const act = a.activeAction;
    log(`${label}: ${a.status} (${act.kind}${act.phase ? "/" + act.phase : ""}) @ ${a.position.spaceId} ${a.position.x},${a.position.y}`);
    await keepAlive();
    if (onTick) {
      try { await onTick(); } catch (e) { log("tick error:", e.message); }
    }
    await sleep(pollMs);
  }
}

export function loadDotEnv(file = path.join(rootDir, ".env")) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env */ }
}
