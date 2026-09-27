/**
 * The paid notary (since 2026-09-07). Another agent asks M₳X to anchor a
 * claim; M₳X hashes their exact words and:
 *   - the FIRST anchor per agent is free (MCITY_NOTARY_FREE_FIRST=0 to disable)
 *   - every further one costs MCITY_NOTARY_PRICE crystal (default 10, 0 = all
 *     free): M₳X quotes the price, his agent id and the claim's sha256, the
 *     other agent runs `send-crystal <M₳X id> <price>`, and the anchor goes on
 *     chain the moment the payment lands (kind `notary-paid`, the amount is
 *     part of the anchored document - the payment is proven along with it).
 *
 * Payment detection runs from tick() while orders are open: the recent-events
 * feed (crystal_transferred with M₳X as recipient) first, the crystal balance
 * as a fallback. The fallback is the normal case - a transfer does not show up
 * in the recipient's feed - and it is the dangerous one, because M₳X's own coin
 * sales raise the same balance. It booked 19 phantom payments before
 * 2026-09-21; judgeBalance() now holds every rise back until it is sure (an
 * announced own move via purse.mjs, a late journal event, an implausible amount
 * and a cap of one quote per rise). A missed payment costs a receipt; an
 * invented one puts a lie on chain.
 * Threads close ~60 s after the last message, so orders live in
 * data/notary-orders.json for 24 h: a late payment still gets its anchor and
 * the receipt is delivered in the next conversation with that agent (or by a
 * direct speak attempt right after the anchor is queued).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryRun, action, lease, log, dataDir, getInventory } from "./mc.mjs";
import * as journal from "./journal.mjs";
import * as nightgate from "./nightgate.mjs";
import * as purse from "./purse.mjs";

export const cfg = {
  price: Number(process.env.MCITY_NOTARY_PRICE ?? 10),
  freeFirst: process.env.MCITY_NOTARY_FREE_FIRST !== "0",
  maxPerDay: Number(process.env.MCITY_NOTARY_MAX_PER_DAY || 30),
  orderTtlMs: 24 * 3600_000,
  checkEveryMs: 20_000,
  balanceQuietMs: 90_000,
  // a rise is never booked on the spot: it has to survive this long unexplained
  // (our own sale is journaled 20-35 s after the money lands - see purse.mjs)
  confirmMs: Number(process.env.MCITY_NOTARY_CONFIRM_MS || 120_000),
  // how many open quotes one unexplained rise may ever settle (a 400 crystal
  // sale once settled seven of them in 104 ms)
  maxCreditsPerRise: Number(process.env.MCITY_NOTARY_MAX_CREDITS_PER_RISE || 1),
};
/** A payment looks like the price, not like a coin batch. */
const maxPlausibleRise = () => Number(process.env.MCITY_NOTARY_MAX_RISE || cfg.price * cfg.maxCreditsPerRise * 2);

/** Journal events that mean the balance moved because of something M₳X did. */
const OWN_EVENTS = ["batch", "meal", "tool", "contract", "notary-paid"];

const file = path.join(dataDir, "notary-orders.json");

/** M₳X's own agent id: the loop's lease, the env, or the helper's lease file (CLI without a lease). */
function myId() {
  if (lease.agentId || process.env.MCITY_AGENT_ID) return lease.agentId || process.env.MCITY_AGENT_ID;
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".midnight-city", "direct-control-lease.json"), "utf8")).agentId || ""; } catch { return ""; }
}
const today = () => new Date().toISOString().slice(0, 10);
const shortId = (id) => String(id || "").slice(-8);

let state = null;
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { state = {}; }
  state.orders ||= [];
  state.freeUsed ||= {};
  state.income ||= { total: 0, count: 0, byDay: {} };
  state.seenEvents ||= [];
  return state;
}
function save() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    state.seenEvents = state.seenEvents.slice(-200);
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (e) { log("notary state write failed:", e.message); }
}

const anchorsToday = () => nightgate.countKindToday("notary") + nightgate.countKindToday("notary-paid");

function expire() {
  const st = load();
  let n = 0;
  for (const o of st.orders) {
    if (o.status === "quoted" && Date.now() - o.createdAt > cfg.orderTtlMs) { o.status = "expired"; n++; }
  }
  if (n) save();
  // keep the file small: finished orders older than 7 days go
  st.orders = st.orders.filter((o) => o.status === "quoted" || Date.now() - o.createdAt < 7 * 24 * 3600_000);
}

export function openOrders() { expire(); return load().orders.filter((o) => o.status === "quoted"); }

/**
 * Someone asked for an anchor. Returns
 *   { mode: "free",  payloadHash }             anchored right now, on the house
 *   { mode: "quote", order }                   pay first: order has price, claimSha256, payTo
 *   { mode: "limit" }                          daily cap reached
 */
export function request({ threadId, claimantId, claimant, claim, forcePaid = false, pitched = false }) {
  if (!nightgate.config().enabled) return { mode: "off" }; // nothing to sell without a vault
  const st = load();
  expire();
  const text = String(claim || "").slice(0, 400);
  const claimSha256 = nightgate.sha256hex(String(claim || ""));
  // the free first anchor is for people who ask; a pitched agent (hustle mode) pays from the first one
  const free = cfg.price <= 0 || (!forcePaid && cfg.freeFirst && !st.freeUsed[claimantId]);
  if (free) {
    if (anchorsToday() >= cfg.maxPerDay) return { mode: "limit" };
    const r = nightgate.enqueueDoc("notary", { date: today(), ts: Date.now(), claimant: claimant || shortId(claimantId), claimantId, claim: text, claimSha256 });
    if (!r) return { mode: "limit" };
    st.freeUsed[claimantId] = Date.now();
    save();
    journal.note("notary-order", { claimantId, claimant, free: true, payloadHash: r.payloadHash });
    log(`notary: free anchor for ${claimant || shortId(claimantId)} - ${r.payloadHash}`);
    return { mode: "free", payloadHash: r.payloadHash, firstFree: cfg.price > 0 };
  }
  // an open quote for the same words is the same order (they asked twice)
  let order = st.orders.find((o) => o.status === "quoted" && o.claimantId === claimantId && o.claimSha256 === claimSha256);
  if (!order) {
    order = {
      id: `${Date.now().toString(36)}-${shortId(claimantId)}`, threadId, claimantId, claimant: claimant || shortId(claimantId),
      claim: text, claimSha256, price: cfg.price, payTo: myId(), createdAt: Date.now(), status: "quoted", pitched: !!pitched,
    };
    st.orders.push(order);
    save();
    journal.note("notary-order", { claimantId, claimant, free: false, price: cfg.price, claimSha256, pitched: !!pitched });
    log(`notary: quoted ${cfg.price} crystal to ${order.claimant} for claim ${claimSha256.slice(0, 12)}…${pitched ? " (pitched)" : ""}`);
  }
  return { mode: "quote", order };
}

/** A receipt that could not be delivered yet (thread was closed): hand it over in the next reply. */
export function takePendingReceipt(claimantId) {
  const st = load();
  const o = st.orders.find((x) => x.status === "anchored" && x.claimantId === claimantId && x.receiptPending);
  if (!o) return null;
  o.receiptPending = false;
  save();
  return { payloadHash: o.payloadHash, paid: o.paidAmount, claimSha256: o.claimSha256 };
}

function markPaid(order, amount, how) {
  const st = load();
  order.status = "paid";
  order.paidAt = Date.now();
  order.paidAmount = amount;
  order.paidVia = how;
  const r = nightgate.enqueueDoc("notary-paid", {
    date: today(), ts: Date.now(), claimant: order.claimant, claimantId: order.claimantId,
    claim: order.claim, claimSha256: order.claimSha256, paid: amount,
  });
  if (r) {
    order.status = "anchored";
    order.payloadHash = r.payloadHash;
    order.receiptPending = true;
  } else {
    order.status = "paid-unanchored"; // schema/cap problem - keep the money trail, retry by hand
  }
  st.income.total += amount;
  st.income.count += 1;
  st.income.byDay[today()] = (st.income.byDay[today()] || 0) + amount;
  save();
  journal.note("notary-paid", { claimantId: order.claimantId, claimant: order.claimant, amount, via: how, payloadHash: order.payloadHash || null, pitched: !!order.pitched });
  log(`notary: ${order.claimant} paid ${amount} crystal (${how}) - anchoring ${order.payloadHash || "FAILED TO QUEUE"}`);
  return order;
}

/** Try to hand the receipt over right away (opens a thread; fails silently on DND/busy). */
async function deliverReceipt(order) {
  const text = `Payment landed, ${order.claimant} - ${order.paidAmount} crystal, thanks. Your claim is going on Midnight right now: sha256 ${order.payloadHash}. Give it a minute or two, then anyone can verify it against live contract state.`;
  const s = await action("speak", order.claimantId, text);
  const d = s.ok ? (s.data.delivery || {}) : {};
  if (d.delivered) {
    order.receiptPending = false;
    save();
    journal.note("reply", { name: order.claimant, otherId: order.claimantId, source: "notary", text });
    log(`notary: receipt delivered to ${order.claimant}`);
  } else {
    log(`notary: receipt not delivered now (${d.reason || d.status || s.error || "?"}) - will hand it over in the next conversation`);
  }
}

let lastCheck = 0;
let lastBalance = null;
let lastBalanceAt = 0;
/** A rise that is waiting to be explained: { at, delta, balance, claimantId } */
let pendingRise = null;

/**
 * The decision the old code got wrong, as a pure function - no clock, no files,
 * no network, so the 2026-09-21 incident can be replayed by hand:
 *   judgeBalance({ now: 0, crystal: 228138, lastBalance: 227738, pending: null,
 *     ownMoveActive: true, ownMoveReason: "selling 100 meme_coin",
 *     ownReasonFor: () => null, price: 10, confirmMs: 120000, maxRise: 20 })
 *   → { kind: "ignore" }   (the old code booked seven payments here)
 *
 * Three independent guards, each of which alone would have stopped 2026-09-21:
 *   1. an announced own move (purse.mjs) is never a payment
 *   2. a rise is held for `confirmMs` and dropped if a reason turns up late
 *      (our batch event is written 20-35 s after the money)
 *   3. a rise far above the price is not a payment, whatever else says
 *
 * Returns { kind: "book" | "hold" | "drop" | "ignore" | "none", ... }.
 */
export function judgeBalance({ now, crystal, lastBalance, pending, ownMoveActive, ownMoveReason, ownReasonFor, price, confirmMs, maxRise }) {
  if (pending) {
    const ours = ownMoveActive ? `we announced "${ownMoveReason}"` : ownReasonFor(pending.at);
    if (ours) return { kind: "drop", log: `the ${pending.delta} crystal rise was ours (${ours}) - no payment booked` };
    if (now - pending.at < confirmMs) return { kind: "none" };
    return { kind: "book", delta: pending.delta, claimantId: pending.claimantId || null, waitedS: Math.round((now - pending.at) / 1000) };
  }
  if (lastBalance == null || crystal <= lastBalance) return { kind: "none" };
  const delta = crystal - lastBalance;
  const ours = ownMoveActive ? `we announced "${ownMoveReason}"` : ownReasonFor(now);
  if (ours) return { kind: "ignore", log: `+${delta} crystal, but ${ours} - not a payment` };
  if (delta > maxRise) return { kind: "ignore", log: `+${delta} crystal is far above the ${price} crystal price - not a payment, ignoring` };
  return { kind: "hold", delta };
}

/** Who a confirmed rise settles: whoever said they sent it, else oldest first. */
export function ordersForRise(openQuotes, claimantId) {
  return openQuotes.slice().sort((a, b) => {
    if (claimantId) {
      const ha = a.claimantId === claimantId ? 0 : 1;
      const hb = b.claimantId === claimantId ? 0 : 1;
      if (ha !== hb) return ha - hb;
    }
    return a.createdAt - b.createdAt;
  });
}

/**
 * Did something of ours move the balance around `sinceTs`? Returns the reason
 * or null. Looks at both ends: an announcement made before the money arrived
 * (purse.mjs) and a journal event written after it.
 */
function ownExplains(sinceTs) {
  const from = sinceTs - cfg.balanceQuietMs;
  const move = purse.lastOwnMove();
  if (move.at >= from) return `we announced "${move.reason}"`;
  const e = journal.since(from).find((x) => OWN_EVENTS.includes(x.type));
  return e ? `our own ${e.type} at ${new Date(e.at).toISOString().slice(11, 19)}` : null;
}

/**
 * Look for payments on open orders. Cheap when nothing is open (one branch).
 * Called from tick(); `force` skips the 20 s throttle (someone just said "sent"),
 * `claimantId` names who said it, so a confirmed rise settles THAT order rather
 * than the oldest one.
 */
export async function checkPayments({ force = false, claimantId = null } = {}) {
  const open = openOrders();
  if (!open.length) { lastBalance = null; pendingRise = null; return 0; }
  if (!force && Date.now() - lastCheck < cfg.checkEveryMs) return 0;
  lastCheck = Date.now();
  const st = load();
  const me = myId();
  let paid = [];

  // 1) the event feed: crystal_transferred with M₳X as the recipient
  const ev = tryRun("recent-events");
  if (ev.ok) {
    for (const e of ev.data.recentEvents || []) {
      const p = e.payload || {};
      if (p.kind !== "crystal_transferred" || p.recipientAgentId !== me) continue;
      if (st.seenEvents.includes(e.eventId)) continue;
      st.seenEvents.push(e.eventId);
      const sender = p.senderAgentId || p.agentId;
      const amount = Number(p.quantity || 0);
      const order = open.find((o) => o.claimantId === sender && o.status === "quoted");
      if (order && amount >= order.price) paid.push(markPaid(order, amount, "event"));
      else log(`notary: transfer of ${amount} from ${shortId(sender)} matches no open order (or is below the price)`);
    }
    if (paid.length) save();
  }

  // 2) balance fallback: the balance rose and nothing of ours explains it.
  //    judgeBalance() below holds every rise back for cfg.confirmMs first,
  //    because our own sale is journaled up to 35 s after the money lands.
  const stillOpen = open.filter((o) => o.status === "quoted");
  if (stillOpen.length) {
    const { crystal } = getInventory();
    const now = Date.now();
    // "I sent it" arriving while a rise is on hold tells us whose it is
    if (pendingRise && claimantId && !pendingRise.claimantId) pendingRise.claimantId = claimantId;

    const verdict = judgeBalance({
      now, crystal, lastBalance, pending: pendingRise, claimantId,
      ownMoveActive: purse.ownMoveActive(now),
      ownMoveReason: purse.lastOwnMove().reason,
      ownReasonFor: ownExplains,
      price: cfg.price, confirmMs: cfg.confirmMs, maxRise: maxPlausibleRise(),
    });

    if (verdict.kind === "book") {
      let delta = verdict.delta;
      for (const o of ordersForRise(stillOpen, verdict.claimantId)) {
        if (paid.length >= cfg.maxCreditsPerRise || delta < o.price) break;
        paid.push(markPaid(o, o.price, verdict.claimantId === o.claimantId ? "balance (they said they sent it)" : "balance"));
        delta -= o.price;
      }
      if (!paid.length) log(`notary: ${verdict.delta} crystal stayed unattributed for ${verdict.waitedS}s but matches no open quote`);
      else if (delta > 0) log(`notary: ${delta} crystal of that rise stayed unattributed (at most ${cfg.maxCreditsPerRise} quote(s) per rise)`);
      pendingRise = null;
    } else if (verdict.kind === "hold") {
      pendingRise = { at: now, delta: verdict.delta, balance: crystal, claimantId: claimantId || null };
      log(`notary: +${verdict.delta} crystal with no reason of ours - holding it for ${Math.round(cfg.confirmMs / 1000)}s before booking it as a payment`);
    } else if (verdict.kind === "drop" || verdict.kind === "ignore") {
      log(`notary: ${verdict.log}`);
      if (verdict.kind === "drop") pendingRise = null;
    }

    lastBalance = crystal;
    lastBalanceAt = now;
  }

  for (const o of paid) await deliverReceipt(o);
  return paid.length;
}

/** Numbers for status, report and the persona. */
export function summary() {
  const st = load();
  expire();
  return {
    price: cfg.price, freeFirst: cfg.freeFirst, payTo: myId(),
    open: st.orders.filter((o) => o.status === "quoted").length,
    paidTotal: st.income.total, paidCount: st.income.count,
    paidToday: st.income.byDay[today()] || 0,
    freeGiven: Object.keys(st.freeUsed).length,
  };
}

/** `life.mjs notary`: orders and income at a glance. */
export function describe() {
  const s = summary();
  const st = load();
  const lines = [
    `price ${s.price} crystal${s.freeFirst ? ", first anchor per agent free" : ""} · pay to ${s.payTo || "?"}`,
    `income: ${s.paidTotal} crystal from ${s.paidCount} paid anchors (${s.paidToday} today) · free anchors given: ${s.freeGiven} · open quotes: ${s.open}`,
  ];
  for (const o of [...st.orders].reverse().slice(0, 12)) {
    lines.push(`  ${new Date(o.createdAt).toISOString().slice(0, 16)} ${o.status.padEnd(9)} ${o.claimant.padEnd(16)} ${o.price} cr  ${o.claimSha256.slice(0, 12)}…${o.payloadHash ? ` -> ${o.payloadHash.slice(0, 12)}…` : ""}`);
  }
  return lines.join("\n");
}
