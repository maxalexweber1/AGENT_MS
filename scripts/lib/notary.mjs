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
 * as a fallback when nothing else moved the balance in the last 90 s.
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

export const cfg = {
  price: Number(process.env.MCITY_NOTARY_PRICE ?? 10),
  freeFirst: process.env.MCITY_NOTARY_FREE_FIRST !== "0",
  maxPerDay: Number(process.env.MCITY_NOTARY_MAX_PER_DAY || 30),
  orderTtlMs: 24 * 3600_000,
  checkEveryMs: 20_000,
  balanceQuietMs: 90_000,
};

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
export function request({ threadId, claimantId, claimant, claim }) {
  if (!nightgate.config().enabled) return { mode: "off" }; // nothing to sell without a vault
  const st = load();
  expire();
  const text = String(claim || "").slice(0, 400);
  const claimSha256 = nightgate.sha256hex(String(claim || ""));
  const free = cfg.price <= 0 || (cfg.freeFirst && !st.freeUsed[claimantId]);
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
      claim: text, claimSha256, price: cfg.price, payTo: myId(), createdAt: Date.now(), status: "quoted",
    };
    st.orders.push(order);
    save();
    journal.note("notary-order", { claimantId, claimant, free: false, price: cfg.price, claimSha256 });
    log(`notary: quoted ${cfg.price} crystal to ${order.claimant} for claim ${claimSha256.slice(0, 12)}…`);
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
  journal.note("notary-paid", { claimantId: order.claimantId, claimant: order.claimant, amount, via: how, payloadHash: order.payloadHash || null });
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

/**
 * Look for payments on open orders. Cheap when nothing is open (one branch).
 * Called from tick(); `force` skips the 20 s throttle (someone just said "sent").
 */
export async function checkPayments({ force = false } = {}) {
  const open = openOrders();
  if (!open.length) { lastBalance = null; return 0; }
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

  // 2) balance fallback: the balance rose while nothing of ours moved it
  const stillOpen = open.filter((o) => o.status === "quoted");
  if (stillOpen.length) {
    const { crystal } = getInventory();
    const ownMoves = journal.since(Date.now() - cfg.balanceQuietMs).some((e) => ["batch", "meal", "tool", "contract", "notary-paid"].includes(e.type));
    if (lastBalance != null && !ownMoves && crystal > lastBalance) {
      let delta = crystal - lastBalance;
      for (const o of stillOpen.sort((a, b) => a.createdAt - b.createdAt)) {
        if (delta < o.price) break;
        paid.push(markPaid(o, o.price, "balance"));
        delta -= o.price;
      }
      if (delta > 0) log(`notary: ${delta} crystal arrived unattributed`);
    }
    lastBalance = crystal;
    lastBalanceAt = Date.now();
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
