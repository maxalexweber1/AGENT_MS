#!/usr/bin/env node
/**
 * Midnight City meme-coin farmer for one hacker agent.
 *
 * Runs in a normal terminal (no tool timeouts), one action at a time,
 * keeps the direct-control lease alive, and sells via the exact merchant
 * offer returned by `merchants`.
 *
 * Usage (from the skill directory):
 *   node scripts/farm.mjs --target 30            # farm until >= 30 meme_coin, then sell all
 *   node scripts/farm.mjs --target 30 --no-sell  # farm only
 *   node scripts/farm.mjs --sell-only            # just sell what is in inventory
 *   node scripts/farm.mjs --target 30 --agent <agentId>
 *   node scripts/farm.mjs --target 30 --no-eat    # never buy food / eat automatically
 *
 * Stop any time with Ctrl+C. Do NOT run Hermes/another controller at the same
 * time - `connect` from another process steals the lease.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(here, "mcity-control.mjs");

const HACKER_SPACE = "hacker-house-interior";
const HACKER_AREA = "hacker-house-interior"; // teleport-reachable area id from `areas`
const COIN = "meme_coin";

const POLL_MS = 15_000;          // how often to re-read context while an action runs
const HEARTBEAT_MS = 60_000;     // keep the lease alive while we only read
const BUSY_RETRY_MS = 30_000;    // all terminals reserved -> wait
const ACTION_MAX_MS = 6 * 60_000; // give up waiting on one action after this
const ERROR_RETRY_MS = 20_000;
const BUSY_MAX_STREAK = 120;    // 120 x 30s = 60 minutes of "all terminals reserved"
const EAT_AT_HUNGER = 60;        // buy + eat when hunger reaches this (100 = starving)
const HUNGER_CHECK_MS = 120_000; // how often to re-read needs
const FOOD_PRIORITY = ["fish", "meat", "to_go_food", "matcha_smoothie"]; // what to buy, in order

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const target = Number(opt("--target", 30));
const sell = !flag("--no-sell");
const sellOnly = flag("--sell-only");
const autoEat = !flag("--no-eat");
const agentArg = opt("--agent", process.env.MCITY_AGENT_ID || "");

// ---------- helpers ----------
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRANSIENT = /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|50[234]/i;

/** Block the loop for ms without async - used between retries inside sync run(). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(...args) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = execFileSync(process.execPath, [helper, ...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 90_000, // a hung network call must not freeze a multi-hour run
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
      // lease/auth errors must surface at once so the caller can reconnect;
      // only network blips are worth sitting out.
      if (!TRANSIENT.test(msg) || attempt === 3) throw e;
      log(`transient error on '${args[0]}' (${attempt}/3): ${msg.trim().split("\n")[0]}`);
      sleepSync(10_000);
    }
  }
  throw lastError;
}

function tryRun(...args) {
  try {
    return { ok: true, data: run(...args) };
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || "").toString().trim().split("\n")[0];
    return { ok: false, error: msg };
  }
}

let lastHeartbeat = 0;
async function keepAlive() {
  if (Date.now() - lastHeartbeat < HEARTBEAT_MS) return;
  const r = tryRun("heartbeat");
  if (r.ok) {
    lastHeartbeat = Date.now();
  } else if (/expired|no longer active|lease/i.test(r.error)) {
    log("lease lost ->", r.error);
    await connect();
  }
}

async function connect() {
  let id = agentArg;
  if (!id) {
    const c = run("claimable");
    id = c.agentIds?.[0];
    if (!id) throw new Error("no claimable agent for this token");
  }
  const r = run("connect", id);
  if (!r.connected) throw new Error("connect failed");
  lastHeartbeat = Date.now();
  log(`connected to ${id}`);
  return id;
}

function getContext() {
  return run("context").agent;
}

function getCoins() {
  const inv = run("inventory").inventory || {};
  return { coins: inv[COIN] || 0, crystal: inv.crystal || 0 };
}

/** Wait until the agent has no active action. Returns final agent context. */
async function waitIdle(label) {
  const start = Date.now();
  for (;;) {
    const a = getContext();
    if (!a.activeAction) return a;
    if (Date.now() - start > ACTION_MAX_MS) {
      log(`${label}: still '${a.activeAction.kind}' after ${ACTION_MAX_MS / 1000}s, continuing anyway`);
      return a;
    }
    const act = a.activeAction;
    log(`${label}: ${a.status} (${act.kind}${act.phase ? "/" + act.phase : ""}) @ ${a.position.spaceId} ${a.position.x},${a.position.y}`);
    await keepAlive();
    await sleep(POLL_MS);
  }
}

async function ensureInHackerHouse() {
  let a = await waitIdle("before-move");
  if (a.position.spaceId === HACKER_SPACE) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`agent is in ${a.position.spaceId} (${a.position.x},${a.position.y}); moving to ${HACKER_AREA} (try ${attempt}) ...`);
    const r = tryRun("move-area", HACKER_AREA);
    lastHeartbeat = Date.now();
    if (!r.ok) throw new Error(`move-area failed: ${r.error}`);
    const o = r.data.outcome || {};
    if (o.status === "failed") {
      log(`move rejected: ${o.reason || "unknown"}`);
      await sleep(BUSY_RETRY_MS);
      continue;
    }
    await sleep(5_000); // give the coordinator a moment to register the action
    a = await waitIdle("moving");
    if (a.position.spaceId === HACKER_SPACE) {
      log("arrived in hacker house");
      return;
    }
    log(`not there yet: agent is in ${a.position.spaceId} (${a.position.x},${a.position.y})`);
    await sleep(5_000);
  }
  throw new Error(`could not reach ${HACKER_SPACE}; agent is in ${a.position.spaceId}`);
}

/** One terminal cycle. Returns true if inventory coin count went up. */
async function harvestOnce(before) {
  const r = tryRun("harvest", HACKER_SPACE, "trade", "crypto");
  lastHeartbeat = Date.now(); // actions renew the lease
  if (!r.ok) {
    if (/expired|no longer active/i.test(r.error)) {
      log("lease lost during harvest ->", r.error);
      await connect();
      return false;
    }
    if (/fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|502|503|504/i.test(r.error)) {
      // network blip, not a dry terminal: reconnect and do not count it as a failed cycle
      log("network problem during harvest ->", r.error);
      await sleep(ERROR_RETRY_MS);
      try {
        await connect();
      } catch (e) {
        log("reconnect failed:", e.message);
      }
      return "busy";
    }
    log("harvest error:", r.error);
    await sleep(ERROR_RETRY_MS);
    return false;
  }
  const o = r.data.outcome || {};
  if (o.status === "failed") {
    log(`harvest rejected: ${o.reason || "unknown"} -> retry in ${BUSY_RETRY_MS / 1000}s`);
    await sleep(BUSY_RETRY_MS);
    return "busy";
  }
  log(`harvest submitted (outcome ${o.status}${o.settlementPending ? ", settlement pending" : ""})`);
  await waitIdle("terminal");
  // settlement can land a few seconds after the action ends
  for (let i = 0; i < 6; i++) {
    const now = getCoins();
    if (now.coins > before) {
      log(`+${now.coins - before} ${COIN} -> ${now.coins} ${COIN}, ${now.crystal} crystal`);
      return true;
    }
    await sleep(5_000);
  }
  const now = getCoins();
  log(`no ${COIN} gained this cycle (still ${now.coins}); checking recent-events`);
  const ev = tryRun("recent-events");
  if (ev.ok) {
    const lines = (ev.data.recentEvents || [])
      .slice(0, 5)
      .map((e) => `${e.payload?.kind || "?"}: ${e.payload?.reason || e.payload?.message || ""}`.trim());
    if (lines.length) log("recent:", lines.join(" | "));
  }
  return false;
}

// ---------- food ----------
let lastHungerCheck = 0;
function getNeeds() {
  const n = run("needs");
  return { hunger: n.hunger?.value ?? 0, state: n.hunger?.state ?? "unknown" };
}

function findFoodOffer() {
  const m = run("merchants");
  const merchants = m.merchants || [];
  for (const want of FOOD_PRIORITY) {
    for (const merchant of merchants) {
      const o = merchant.offer || {};
      const t = merchant.trade || {};
      if (o.paysItemId === want && o.acceptsItemId === "crystal" && t.merchantName) {
        return {
          food: want,
          merchantName: t.merchantName,
          itemId: t.itemId || "crystal",
          cost: t.minQuantity || o.acceptsQuantity || 50,
        };
      }
    }
  }
  return null;
}

/** Buy food if needed and eat. Returns true if the agent ate. */
async function maybeEat(force = false) {
  if (!autoEat) return false;
  if (!force && Date.now() - lastHungerCheck < HUNGER_CHECK_MS) return false;
  lastHungerCheck = Date.now();
  const { hunger, state } = getNeeds();
  const threshold = force ? EAT_AT_HUNGER - 20 : EAT_AT_HUNGER; // end-of-run top-up is a bit more eager
  if (hunger < threshold) {
    if (force) log(`hunger ${hunger} (${state}) - no meal needed`);
    return false;
  }
  log(`hunger ${hunger} (${state}) -> time to eat`);

  // already carrying food?
  const inv = run("inventory").inventory || {};
  let have = FOOD_PRIORITY.find((f) => (inv[f] || 0) > 0);
  if (!have) {
    const offer = findFoodOffer();
    if (!offer) {
      log("no food merchant found - skipping meal");
      return false;
    }
    if ((inv.crystal || 0) < offer.cost) {
      log(`not enough crystal (${inv.crystal || 0}) to buy ${offer.food} for ${offer.cost} - skipping meal`);
      return false;
    }
    await waitIdle("before-buy-food");
    log(`buying 1 ${offer.food} from "${offer.merchantName}" for ${offer.cost} crystal`);
    const r = tryRun("trade", offer.merchantName, offer.itemId, String(offer.cost));
    lastHeartbeat = Date.now();
    if (!r.ok) {
      log("food trade failed:", r.error);
      return false;
    }
    if (r.data.outcome?.status === "failed") {
      log("food trade rejected:", r.data.outcome.reason || "unknown");
      return false;
    }
    await sleep(5_000);
    await waitIdle("walking-to-food-outlet");
    const inv2 = run("inventory").inventory || {};
    have = FOOD_PRIORITY.find((f) => (inv2[f] || 0) > 0);
    if (!have) {
      log("bought food but inventory shows none yet - will retry next check");
      return false;
    }
  }
  const e = tryRun("eat");
  lastHeartbeat = Date.now();
  if (!e.ok) {
    log("eat failed:", e.error);
    return false;
  }
  const o = e.data.outcome || {};
  if (o.status === "confirmed") {
    log(`ate ${o.itemId || have}: hunger ${o.hungerBefore} -> ${o.hungerAfter}`);
    return true;
  }
  log(`eat outcome ${o.status}${o.reason ? ": " + o.reason : ""}`);
  if (o.status === "pending") await waitIdle("eating");
  return o.status !== "failed";
}

async function sellAll() {
  const { coins, crystal } = getCoins();
  if (coins <= 0) {
    log(`nothing to sell (0 ${COIN})`);
    return;
  }
  const m = run("merchants");
  const merchants = m.merchants || m.offers || [];
  let offer = null;
  for (const merchant of merchants) {
    const trades = merchant.trades || merchant.offers || (merchant.trade ? [merchant.trade] : []);
    for (const t of trades) {
      if ((t.itemId || t.acceptsItemId) === COIN && (t.merchantName || merchant.name)) {
        offer = {
          merchantName: t.merchantName || merchant.name,
          itemId: t.itemId || t.acceptsItemId,
          min: t.minQuantity || t.acceptsQuantity || 1,
          batch: t.batchMultiple || 1,
          pays: merchant.offer?.paysQuantity ?? null,
        };
        break;
      }
    }
    if (offer) break;
  }
  if (!offer) {
    log(`no merchant currently buys ${COIN}; raw merchants:`);
    console.log(JSON.stringify(merchants, null, 1).slice(0, 1500));
    return;
  }
  const qty = coins - (coins % offer.batch);
  if (qty < offer.min) {
    log(`only ${coins} ${COIN}, merchant needs at least ${offer.min} - not selling`);
    return;
  }
  log(`selling ${qty} ${COIN} to "${offer.merchantName}" (${crystal} crystal before${offer.pays ? `, pays ${offer.pays} each` : ""})`);
  await waitIdle("before-sell");
  const r = tryRun("trade", offer.merchantName, offer.itemId, String(qty));
  lastHeartbeat = Date.now();
  if (!r.ok) throw new Error(`trade failed: ${r.error}`);
  const o = r.data.outcome || {};
  log(`trade outcome: ${o.status}${o.receivedQuantity != null ? `, received ${o.receivedQuantity}` : ""}${o.reason ? `, ${o.reason}` : ""}`);
  if (o.status === "pending") await waitIdle("trade");
  const after = getCoins();
  log(`inventory now: ${after.coins} ${COIN}, ${after.crystal} crystal`);
}

// ---------- main ----------
(async () => {
  log(`meme-coin farmer: target=${target} sell=${sell} sellOnly=${sellOnly} autoEat=${autoEat} (eat at hunger>=${EAT_AT_HUNGER})`);
  await connect();

  if (!sellOnly) {
    let { coins } = getCoins();
    log(`starting with ${coins} ${COIN}`);
    let failStreak = 0;
    let busyStreak = 0;
    while (coins < target) {
      await maybeEat();
      await ensureInHackerHouse();
      const result = await harvestOnce(coins);
      if (result === true) {
        failStreak = 0;
        busyStreak = 0;
        coins = getCoins().coins;
        log(`progress ${coins}/${target}`);
      } else if (result === "busy") {
        // all terminals reserved by other agents: be patient (BUSY_MAX_STREAK * 30s)
        if (++busyStreak >= BUSY_MAX_STREAK) {
          log(`terminals busy for ${(BUSY_MAX_STREAK * BUSY_RETRY_MS) / 60000} minutes straight - stopping.`);
          process.exit(3);
        }
      } else if (++failStreak >= 8) {
        log("8 completed cycles in a row without coins - stopping so you can look at it.");
        process.exit(2);
      }
      await keepAlive();
    }
    log(`target reached: ${coins} ${COIN}`);
  }

  if (sell || sellOnly) await sellAll();
  await maybeEat(true); // top up after the sale so the next run starts well fed
  log("done (lease kept - run `node scripts/mcity-control.mjs disconnect` if you are finished playing)");
})().catch((e) => {
  log("fatal:", e.message);
  process.exit(1);
});
