/**
 * Work: meme-coin batches at the hacker house, selling, eating.
 * Ported from farm.mjs; every wait calls `onTick` so conversations keep flowing.
 */

import { run, tryRun, action, log, sleep, waitIdle, getInventory, getNeeds, keepAlive, LEASE_ERROR, connect, lease } from "./mc.mjs";
import * as journal from "./journal.mjs";
import * as nightgate from "./nightgate.mjs";

export const HACKER_SPACE = "hacker-house-interior";
const COIN = "meme_coin";
// terminals free up whenever another agent's cycle ends: a short retry grabs
// them sooner. ~40% of attempts bounce, so this interval is most of the idle time.
const BUSY_RETRY_MS = Number(process.env.MCITY_BUSY_RETRY_S || 15) * 1000;
const BUSY_GIVE_UP_MS = 20 * 60_000;
const ERROR_RETRY_MS = 20_000;
export const EAT_AT_HUNGER = 60;
const FOOD_PRIORITY = ["fish", "meat", "to_go_food", "matcha_smoothie"];
// Dynamic vendor pricing (city release 2026-09-07): the Central Crypto Merchant
// pays 6..20 crystal per meme coin. Every sale knocks the price down, then it
// climbs back about one crystal per 10 s to the 20 cap (measured 2026-09-08:
// a full recovery takes ~2 min). A 100-coin batch is paid at the listed price,
// so selling on the upswing is worth up to 3x - wait for >= SELL_MIN_PRICE,
// at most SELL_WAIT_MAX_MS, then sell at whatever it is.
const SELL_MIN_PRICE = Number(process.env.MCITY_SELL_MIN_PRICE ?? 17);
const SELL_WAIT_MAX_MS = Number(process.env.MCITY_SELL_WAIT_MAX_S ?? 240) * 1000;
const SELL_POLL_MS = 10_000;

const price = { pays: null, merchantName: null, at: 0, lo: null, hi: null };

/** Current meme-coin price at the crypto merchant (cached `maxAgeMs`); tracks the range seen this process. */
export function coinPrice(maxAgeMs = 20_000) {
  if (Date.now() - price.at < maxAgeMs) return price;
  try {
    const m = run("merchants");
    const merchant = (m.merchants || []).find((x) => x.trade?.itemId === COIN && x.trade?.merchantName);
    if (!merchant) return price;
    const pays = Number(merchant.offer?.paysQuantity);
    Object.assign(price, {
      pays: Number.isFinite(pays) ? pays : null, merchantName: merchant.trade.merchantName, at: Date.now(),
      lo: Number.isFinite(pays) ? Math.min(price.lo ?? pays, pays) : price.lo,
      hi: Number.isFinite(pays) ? Math.max(price.hi ?? pays, pays) : price.hi,
    });
  } catch (e) { log("coin price read failed:", e.message); }
  return price;
}

export async function goTo(areaId, label = areaId, onTick = null) {
  let a = await waitIdle("before-move", { onTick });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await action("move-area", areaId);
    if (!r.ok) throw new Error(`move-area ${areaId} failed: ${r.error}`);
    const o = r.data.outcome || {};
    if (o.status === "failed") {
      log(`move to ${label} rejected: ${o.reason || "unknown"} (try ${attempt})`);
      await sleep(15_000);
      continue;
    }
    await sleep(4_000);
    a = await waitIdle(`moving to ${label}`, { onTick });
    return a;
  }
  throw new Error(`could not move to ${label}`);
}

export async function ensureInHackerHouse(onTick) {
  const a = await waitIdle("before-move", { onTick });
  if (a.position.spaceId === HACKER_SPACE) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`agent is in ${a.position.spaceId}; moving to hacker house (try ${attempt})`);
    const r = await action("move-area", HACKER_SPACE);
    if (!r.ok) throw new Error(`move-area failed: ${r.error}`);
    if (r.data.outcome?.status === "failed") {
      log(`move rejected: ${r.data.outcome.reason || "unknown"}`);
      await sleep(BUSY_RETRY_MS);
      continue;
    }
    await sleep(5_000);
    const b = await waitIdle("moving", { onTick });
    if (b.position.spaceId === HACKER_SPACE) { log("arrived in hacker house"); return; }
    await sleep(5_000);
  }
  throw new Error("could not reach the hacker house");
}

/** One terminal cycle: true = coins went up, "busy" = no free terminal, false = nothing. */
export async function harvestOnce(before, onTick) {
  const r = await action("harvest", HACKER_SPACE, "trade", "crypto");
  if (!r.ok) {
    if (/fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|50[234]/i.test(r.error)) {
      log("network problem during harvest ->", r.error);
      await sleep(ERROR_RETRY_MS);
      try { await connect(lease.agentId); } catch (e) { log("reconnect failed:", e.message); }
      return "busy";
    }
    log("harvest error:", r.error);
    await sleep(ERROR_RETRY_MS);
    return false;
  }
  const o = r.data.outcome || {};
  if (o.status === "failed") {
    log(`harvest rejected: ${o.reason || "unknown"} -> retry in ${BUSY_RETRY_MS / 1000}s`);
    if (onTick) await onTick();
    await sleep(BUSY_RETRY_MS);
    return "busy";
  }
  await waitIdle("terminal", { onTick });
  for (let i = 0; i < 6; i++) {
    const now = getInventory();
    if (now.coins > before) {
      log(`+${now.coins - before} ${COIN} -> ${now.coins} ${COIN}, ${now.crystal} crystal`);
      return true;
    }
    await sleep(5_000);
  }
  log(`no ${COIN} gained this cycle`);
  return false;
}

function findFoodOffer() {
  const m = run("merchants");
  for (const want of FOOD_PRIORITY) {
    for (const merchant of m.merchants || []) {
      const o = merchant.offer || {};
      const t = merchant.trade || {};
      if (o.paysItemId === want && o.acceptsItemId === "crystal" && t.merchantName) {
        return { food: want, merchantName: t.merchantName, itemId: t.itemId || "crystal", cost: t.minQuantity || o.acceptsQuantity || 50 };
      }
    }
  }
  return null;
}

/** Buy food if needed and eat. `threshold` defaults to EAT_AT_HUNGER. */
export async function maybeEat({ threshold = EAT_AT_HUNGER, onTick = null } = {}) {
  const { hunger, state } = getNeeds();
  if (hunger < threshold) return false;
  log(`hunger ${hunger} (${state}) -> time to eat`);
  const { inv, crystal } = getInventory();
  let have = FOOD_PRIORITY.find((f) => (inv[f] || 0) > 0);
  if (!have) {
    const offer = findFoodOffer();
    if (!offer) { log("no food merchant here - skipping meal"); return false; }
    if (crystal < offer.cost) { log(`not enough crystal (${crystal}) for ${offer.food}`); return false; }
    await waitIdle("before-buy-food", { onTick });
    log(`buying 1 ${offer.food} from "${offer.merchantName}" for ${offer.cost} crystal`);
    const r = await action("trade", offer.merchantName, offer.itemId, String(offer.cost));
    if (!r.ok) { log("food trade failed:", r.error); return false; }
    if (r.data.outcome?.status === "failed") { log("food trade rejected:", r.data.outcome.reason || "unknown"); return false; }
    await sleep(5_000);
    await waitIdle("walking-to-food-outlet", { onTick });
    const inv2 = getInventory().inv;
    have = FOOD_PRIORITY.find((f) => (inv2[f] || 0) > 0);
    if (!have) { log("bought food but inventory shows none yet"); return false; }
  }
  const e = await action("eat");
  if (!e.ok) { log("eat failed:", e.error); return false; }
  const o = e.data.outcome || {};
  if (o.status === "confirmed") {
    log(`ate ${o.itemId || have}: hunger ${o.hungerBefore} -> ${o.hungerAfter}`);
    journal.note("meal", { food: o.itemId || have, cost: 50, hungerBefore: o.hungerBefore, hungerAfter: o.hungerAfter });
    nightgate.enqueueDoc("meal", { date: new Date().toISOString().slice(0, 10), ts: Date.now(), food: String(o.itemId || have), cost: 50, hungerBefore: Number(o.hungerBefore ?? 0), hungerAfter: Number(o.hungerAfter ?? 0) });
    return true;
  }
  log(`eat outcome ${o.status}${o.reason ? ": " + o.reason : ""}`);
  if (o.status === "pending") await waitIdle("eating", { onTick });
  return o.status !== "failed";
}

export async function sellAll(onTick) {
  const { coins, crystal } = getInventory();
  if (coins <= 0) return { sold: 0 };
  const m = run("merchants");
  let offer = null;
  for (const merchant of m.merchants || []) {
    const t = merchant.trade || {};
    if (t.itemId === COIN && t.merchantName) {
      offer = { merchantName: t.merchantName, itemId: t.itemId, min: t.minQuantity || 1, batch: t.batchMultiple || 1, pays: merchant.offer?.paysQuantity ?? null };
      break;
    }
  }
  if (!offer) { log(`no merchant currently buys ${COIN}`); return { sold: 0 }; }
  const qty = coins - (coins % offer.batch);
  if (qty < offer.min) return { sold: 0 };
  await waitIdle("before-sell", { onTick });
  // sell on the upswing: the listed price is what the whole batch gets
  let pays = offer.pays;
  const t0 = Date.now();
  while (pays != null && pays < SELL_MIN_PRICE && Date.now() - t0 < SELL_WAIT_MAX_MS) {
    if (Date.now() - t0 < SELL_POLL_MS) log(`coin price ${pays} < ${SELL_MIN_PRICE} - waiting for the upswing (max ${Math.round(SELL_WAIT_MAX_MS / 1000)}s)`);
    if (onTick) { try { await onTick(); } catch (e) { log("tick error:", e.message); } }
    await sleep(SELL_POLL_MS);
    await keepAlive();
    pays = coinPrice(0).pays ?? pays;
  }
  const waited = Math.round((Date.now() - t0) / 1000);
  log(`selling ${qty} ${COIN} to "${offer.merchantName}" at ${pays ?? "?"} each${waited >= SELL_POLL_MS / 1000 ? ` after ${waited}s wait` : ""} (${crystal} crystal before)`);
  const r = await action("trade", offer.merchantName, offer.itemId, String(qty));
  if (!r.ok) throw new Error(`trade failed: ${r.error}`);
  const o = r.data.outcome || {};
  log(`trade outcome: ${o.status}${o.receivedQuantity != null ? `, received ${o.receivedQuantity}` : ""}${o.reason ? `, ${o.reason}` : ""}`);
  if (o.status === "pending") await waitIdle("trade", { onTick });
  const after = getInventory();
  log(`inventory now: ${after.coins} ${COIN}, ${after.crystal} crystal`);
  journal.note("batch", { sold: qty, earned: Math.max(0, after.crystal - crystal), crystal: after.crystal, price: pays ?? null, waitedS: waited });
  journal.note("crystal", { value: after.crystal });
  // proofs, not vibes: anchor the batch on Midnight (no-op unless configured)
  nightgate.enqueueDoc("batch", { date: new Date().toISOString().slice(0, 10), ts: Date.now(), coins: qty, earned: Math.max(0, after.crystal - crystal) });
  return { sold: qty, crystal: after.crystal };
}

/**
 * Farm until `target` coins (or `untilMs` deadline), then sell.
 * Calls `onTick` between cycles (conversation polling) and `shouldStop()` to allow the day plan to interrupt.
 */
export async function farmBatch({ target = 100, untilMs = Infinity, onTick = null, shouldStop = () => false, switchAfterMs = 0, minYield = 0 } = {}) {
  let { coins } = getInventory();
  const startCoins = coins;
  const startedAt = Date.now();
  log(`work: batch to ${target} ${COIN} (have ${coins})`);
  let failStreak = 0;
  let busySince = 0;
  let lastHunger = Date.now();
  let switched = null;
  while (coins < target) {
    if (Date.now() > untilMs || shouldStop()) { log("work: stopping batch early (plan)"); break; }
    if (Date.now() - lastHunger > 120_000) { lastHunger = Date.now(); await maybeEat({ onTick }); }
    await ensureInHackerHouse(onTick);
    const result = await harvestOnce(coins, onTick);
    if (result === true) {
      failStreak = 0; busySince = 0;
      coins = getInventory().coins;
    } else if (result === "busy") {
      busySince ||= Date.now();
      if (Date.now() - busySince >= BUSY_GIVE_UP_MS) {
        switched = "terminals busy for 20 minutes";
        log(`work: ${switched} - giving the batch up for now`);
        break;
      }
    } else if (++failStreak >= 8) {
      log("work: 8 cycles without coins - giving up this batch");
      break;
    }
    // the daytime picture (2026-09-09: 7 coins in 30 min, 92% of the attempts
    // bounced): after `switchAfterMs` with fewer than `minYield` coins gained,
    // hand the time to other work instead of standing at a taken terminal
    if (switchAfterMs && Date.now() - startedAt >= switchAfterMs && coins - startCoins < minYield) {
      switched = `${coins - startCoins} coins in ${Math.round((Date.now() - startedAt) / 60_000)} min (terminals taken)`;
      log(`work: ${switched} - switching to other work`);
      break;
    }
    if (onTick) { try { await onTick(); } catch (e) { log("tick error:", e.message); } }
    await keepAlive();
  }
  // a switched batch keeps its few coins for the next one (no 4-minute price wait for 7 coins)
  const sold = switched && coins < target ? { sold: 0 } : await sellAll(onTick);
  await maybeEat({ threshold: EAT_AT_HUNGER - 20, onTick });
  return { coins, ...sold, ...(switched ? { switched: true, reason: switched } : {}) };
}
