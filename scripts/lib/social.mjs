/**
 * Conversations: answer whoever talks to M₳X, start conversations himself,
 * shout now and then, and write finished threads into memory.
 */

import fs from "node:fs";
import path from "node:path";
import { run, tryRun, action, lease, log, touch, pick, rand, dataDir, sleep } from "./mc.mjs";
import * as mem from "./memory.mjs";
import * as llm from "./llm.mjs";
import * as journal from "./journal.mjs";
import * as nightgate from "./nightgate.mjs";
import * as notary from "./notary.mjs";
import * as updates from "./updates.mjs";
import { senderName, detectTags, buildReply, buildOpener, buildPitch, buildShout, extractiveSummary, classifyPitchReply } from "./rules.mjs";

export const cfg = {
  maxRepliesPerThread: Number(process.env.MCITY_MAX_REPLIES || 2),
  initiateCooldownMs: Number(process.env.MCITY_INITIATE_COOLDOWN_MIN || 5) * 60_000, // min gap between conversations M₳X starts
  rateLimitBackoffMs: 3 * 60_000,     // no new approaches for a while after the game says "rate limited"
  sameAgentCooldownMs: Number(process.env.MCITY_SAME_AGENT_COOLDOWN_H || 3) * 3600_000, // don't approach the same agent twice within
  shoutCooldownMs: 3 * 3600_000,
  maxInitiatesPerDay: Number(process.env.MCITY_MAX_INITIATES || 40),
  maxShoutsPerDay: 3,
  // the game allows ~20 messages per hour per agent ("rate limited" beyond that):
  // replies get the budget first, approaches stop early, shouts even earlier
  hourlyQuota: 20,
  initiateBelow: Number(process.env.MCITY_INITIATE_BELOW || 16),
  shoutBelow: 12,
  // hustle: a pitch thread gets one extra reply so the deal can close (pitch -> objection -> quote -> receipt)
  pitchExtraReplies: Number(process.env.MCITY_HUSTLE_EXTRA_REPLIES ?? 1),
  pitchThreadWindowMs: 40 * 60_000, // a thread M₳X opened with a pitch this recently is handled as a deal
};

/** Messages M₳X sent in the last 60 minutes (replies, openers, shouts). */
export function sentInLastHour() {
  return journal.since(Date.now() - 60 * 60_000).filter((e) => e.type === "reply" || e.type === "opener" || e.type === "shout").length;
}

const state = {
  answered: new Set(),        // messageIds already answered
  attempts: new Map(),        // messageId -> delivery attempts (pending outcomes get one retry)
  drafts: new Map(),          // messageId -> reply text generated on a previous attempt (no second LLM call)
  rateLimitedUntil: 0,        // approaches paused until then
  usedByThread: new Map(),    // threadId -> Set of rule snippet keys
  lastInitiate: 0,
  lastShout: 0,
  initiatesToday: 0,
  shoutsToday: 0,
  pitchesToday: 0,
  lastPitch: 0,
  pitched: {},                // agentId -> { at, outcome: "pitched"|"refused"|"quoted"|"paid" } (hustle mode)
  day: new Date().toISOString().slice(0, 10),
  lastThreadsPoll: 0,
  lastBudgetLog: 0,
};

// counters survive restarts (otherwise every restart allows a fresh shout)
const socialStateFile = path.join(dataDir, "social-state.json");
try {
  const s = JSON.parse(fs.readFileSync(socialStateFile, "utf8"));
  Object.assign(state, {
    lastInitiate: s.lastInitiate || 0, lastShout: s.lastShout || 0, initiatesToday: s.initiatesToday || 0, shoutsToday: s.shoutsToday || 0, day: s.day || state.day,
    pitchesToday: s.pitchesToday || 0, lastPitch: s.lastPitch || 0, pitched: s.pitched || {},
  });
} catch { /* first run */ }
function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // pitched agents: keep 14 days
    for (const [id, p] of Object.entries(state.pitched)) if (Date.now() - (p.at || 0) > 14 * 24 * 3600_000) delete state.pitched[id];
    fs.writeFileSync(socialStateFile, JSON.stringify({
      lastInitiate: state.lastInitiate, lastShout: state.lastShout, initiatesToday: state.initiatesToday, shoutsToday: state.shoutsToday, day: state.day,
      pitchesToday: state.pitchesToday, lastPitch: state.lastPitch, pitched: state.pitched,
    }));
  } catch { /* ignore */ }
}

function rollDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== state.day) {
    state.day = d;
    state.initiatesToday = 0;
    state.shoutsToday = 0;
    state.pitchesToday = 0;
    persist();
  }
}

/** Has this agent heard the notary pitch within `withinMs`? A refusal counts for a week regardless. */
export function pitchedRecently(agentId, withinMs = 48 * 3600_000) {
  const p = state.pitched[agentId];
  if (!p) return false;
  if (p.outcome === "refused") return Date.now() - p.at < 7 * 24 * 3600_000;
  return Date.now() - p.at < withinMs;
}
function notePitched(agentId, outcome) {
  const p = state.pitched[agentId] || { at: Date.now() };
  if (outcome === "pitched") p.at = Date.now();
  p.outcome = outcome;
  state.pitched[agentId] = p;
  persist();
}

/** Status snapshot provider is injected by life.mjs (so social never blocks on reads it does not need). */
let statusProvider = () => ({});
export function setStatusProvider(fn) { statusProvider = fn; }

function readThread(threadId) {
  const r = tryRun("thread", threadId);
  if (!r.ok) return null;
  return r.data.messages || [];
}

/** What M₳X said to other people in the last hour - other agents overhear plaza talk. */
function recentConversations(excludeId, windowMs = 60 * 60_000) {
  const seen = new Map();
  for (const e of journal.since(Date.now() - windowMs)) {
    if ((e.type !== "reply" && e.type !== "opener") || e.otherId === excludeId) continue;
    const who = e.name || "someone";
    seen.set(who, `${who}: you said "${String(e.text || "").slice(0, 90)}${(e.text || "").length > 90 ? "…" : ""}"`);
  }
  return [...seen.values()].slice(-4);
}

function transcriptOf(messages) {
  return messages.map((m) => ({ who: m.senderAgentId === lease.agentId ? "me" : "them", text: m.messageBody || "" }));
}

// ---------- answering ----------
export async function pollThreads({ force = false } = {}) {
  rollDay();
  if (!force && Date.now() - state.lastThreadsPoll < 8_000) return;
  state.lastThreadsPoll = Date.now();
  const r = tryRun("threads");
  if (!r.ok) {
    if (/expired|no longer active|lease|404/i.test(r.error)) throw new Error(`threads: ${r.error}`);
    log("threads error:", r.error);
    return;
  }
  // note: a read does NOT renew the lease - keepAlive() must still heartbeat
  const threads = r.data.threads || [];
  const me = lease.agentId;

  // 1) open threads waiting for us
  for (const t of threads) {
    if (t.threadStatus !== "open" || t.pendingRecipientAgentId !== me) continue;
    if (state.answered.has(t.latestMessageId)) continue;
    const otherId = t.participantPairKey.split("::").find((id) => id !== me);
    if (!otherId) continue;
    await answerThread(t, otherId);
  }

  // 2) closed threads we have not summarized yet (memory)
  for (const t of threads) {
    if (t.threadStatus !== "closed" || mem.memory.summarizedThreads[t.threadId]) continue;
    const otherId = t.participantPairKey.split("::").find((id) => id !== me);
    if (!otherId) continue;
    await summarizeThread(t, otherId);
  }
}

async function answerThread(t, otherId) {
  const messages = readThread(t.threadId) || [];
  const mine = messages.filter((m) => m.senderAgentId === lease.agentId).length;
  state.answered.add(t.latestMessageId);
  // a pending speech from the previous attempt may have landed after all
  if (state.attempts.has(t.latestMessageId) && messages.at(-1)?.senderAgentId === lease.agentId) return;
  // when M₳X opened the thread, the opener does not count as a reply
  const iOpened = t.initiatorAgentId === lease.agentId;
  // a thread M₳X opened with the notary pitch (hustle mode) is a deal: one extra reply to close it
  const pitchThread = iOpened && state.pitched[otherId] && Date.now() - state.pitched[otherId].at < cfg.pitchThreadWindowMs;
  const limit = cfg.maxRepliesPerThread + (iOpened ? 1 : 0) + (pitchThread ? cfg.pitchExtraReplies : 0);
  if (mine >= limit) return;
  const sent = sentInLastHour();
  if (sent >= cfg.hourlyQuota) {
    // would only be rate limited - do not burn an LLM call; re-check on a later poll
    state.answered.delete(t.latestMessageId);
    state.lastThreadsPoll = Date.now() + 45_000;
    log(`hourly message quota reached (${sent}/${cfg.hourlyQuota}) - holding reply to ${otherId.slice(-8)}`);
    return;
  }

  const transcript = transcriptOf(messages);
  const latest = t.latestMessagePreview || transcript.filter((m) => m.who === "them").at(-1)?.text || "";
  const theirs = transcript.filter((m) => m.who === "them").map((m) => m.text).join(" ");
  // memory as it was BEFORE this thread - otherwise "talked 1x, earlier today" describes this very conversation
  const metBefore = mem.metBefore(otherId, t.threadId);
  const briefBefore = metBefore ? mem.contactBrief(otherId) : "";
  const c = mem.noteContact(otherId, { name: senderName(theirs), tags: detectTags(theirs), threadId: t.threadId });
  if (!c.profession || !c.name) {
    const a = agentById(otherId);
    if (a?.profession && !c.profession) c.profession = a.profession;
    if (a?.name && !c.name) c.name = mem.cleanName(a.name);
  }
  const status = statusProvider();
  let isLast = mine >= limit - 1;

  // the notary: someone asks M₳X to anchor/notarize a claim - hash their exact
  // words; first anchor per agent is free (queued right now), further ones are
  // quoted (price, M₳X's id, the claim hash) and anchored once the crystal lands.
  // In a pitch thread the pitched agent pays from the first one (hustle.cfg.chargeFirst
  // arrives via the pitched record) and the order is attributed to the pitch.
  let notaryHash = null, notaryQuote = null, notaryFirstFree = false, pitch = null;
  let notaryReceipt = notary.takePendingReceipt(otherId);
  if (!state.notarizedThreads) state.notarizedThreads = new Set();
  const orderOpts = pitchThread ? { forcePaid: !!state.pitched[otherId].chargeFirst, pitched: true } : {};
  const paidWords = /\b(sent|paid|transferred|done|there you go|crystal(s)? (is|are) (on|with) (its|their) way)\b/i;
  if (/notari[sz]e|anchor (this|that|it|my|me)|put (this|that|it|my) .*on.?chain|on.?chain (it|this|that)|can you (anchor|hash)|hash (this|that|it|my)|make (it|this|that) official|need a receipt|witness (this|my)/i.test(latest)) {
    if (!state.notarizedThreads.has(t.threadId)) {
      const r = notary.request({ threadId: t.threadId, claimantId: otherId, claimant: c.name || otherId.slice(-8), claim: latest, ...orderOpts });
      if (r.mode === "free") { notaryHash = r.payloadHash; notaryFirstFree = !!r.firstFree; state.notarizedThreads.add(t.threadId); }
      else if (r.mode === "quote") { notaryQuote = r.order; if (pitchThread) notePitched(otherId, "quoted"); }
    }
  } else if (notary.openOrders().some((o) => o.claimantId === otherId) && paidWords.test(latest)) {
    // "sent" - look right now instead of on the next 20 s check
    try { if (await notary.checkPayments({ force: true })) notaryReceipt = notary.takePendingReceipt(otherId); } catch (e) { log("notary check failed:", e.message); }
    if (!notaryReceipt) notaryQuote = notary.openOrders().find((o) => o.claimantId === otherId) || null;
  } else if (pitchThread && !notaryReceipt) {
    // the deal flow: what did the pitched agent just say?
    const stage = classifyPitchReply(latest);
    if (stage === "claim" && !state.notarizedThreads.has(t.threadId)) {
      const r = notary.request({ threadId: t.threadId, claimantId: otherId, claimant: c.name || otherId.slice(-8), claim: latest, ...orderOpts });
      if (r.mode === "quote") { notaryQuote = r.order; notePitched(otherId, "quoted"); }
      else if (r.mode === "free") { notaryHash = r.payloadHash; notaryFirstFree = !!r.firstFree; state.notarizedThreads.add(t.threadId); }
      else pitch = { stage: "limit" };
    } else if (stage === "refuse") {
      // a clear no ends the pitch: one warm line, sign off, never again this week
      notePitched(otherId, "refused");
      isLast = true;
      pitch = { stage };
    } else {
      pitch = { stage };
    }
    if (pitch) pitch = { ...pitch, price: notary.cfg.price, payTo: notaryQuote?.payTo || notary.summary().payTo, minutesLeft: state.pitched[otherId].minutesLeft || 0, replyNo: mine };
  }
  const notaryBrief = notary.summary();

  let reply = state.drafts.get(t.latestMessageId) || null;
  if (!reply && llm.enabled()) {
    reply = await llm.reply({
      transcript, name: c.name, contactBrief: briefBefore, status,
      metCount: mem.memory.contacts[otherId]?.met || 0,
      proofBrief: nightgate.proofBrief(), notaryHash, notaryQuote, notaryFirstFree, notaryReceipt, notaryPrice: notary.cfg.price,
      pitch: pitchThread ? (pitch || { stage: notaryQuote ? "close" : notaryReceipt ? "receipt" : "anchored", price: notary.cfg.price, minutesLeft: state.pitched[otherId].minutesLeft || 0, replyNo: mine }) : null,
      notaryBrief, newsBrief: updates.newsBrief(),
      replyIndex: mine, maxReplies: limit, isLast, worldBrief: mem.worldBrief(6),
      recent: recentConversations(otherId),
    });
  }
  let source = "llm";
  if (!reply) {
    source = "rules";
    const used = state.usedByThread.get(t.threadId) || new Set();
    if (transcript.some((m) => m.who === "me" && /M₳X (here|,)/.test(m.text))) used.add("intro");
    state.usedByThread.set(t.threadId, used);
    reply = buildReply(latest, { name: c.name, metBefore, replyIndex: mine, isLast, usedKeys: used, status, lastSummary: mem.lastSummary(otherId), notaryHash, notaryQuote, notaryFirstFree, notaryReceipt, notaryPrice: notary.cfg.price, pitch, pitchThread, notaryBrief });
  }

  log(`incoming (${t.threadId.slice(-8)}) from ${c.name || otherId.slice(-8)}${metBefore ? " (met before)" : ""}: "${latest.slice(0, 100)}"`);
  // the game enforces a minimum gap between messages: on "rate limited" retry in place
  // (threads close ~45s after the last message, so waiting for the next poll is too slow)
  let s, d = {};
  for (let attempt = 1; attempt <= 3; attempt++) {
    s = await action("speak", otherId, reply);
    if (!s.ok) { log("speak error:", s.error); return; }
    d = s.data.delivery || {};
    if (!/rate limit/i.test(d.reason || "")) break;
    log(`speak rate limited (attempt ${attempt}) - retrying in 6s`);
    state.rateLimitedUntil = Date.now() + cfg.rateLimitBackoffMs;
    await sleep(6_000);
  }
  if (d.delivered) {
    log(`replied [${source}] (${mine + 1}/${limit}): "${reply}"`);
    journal.note("reply", { name: c.name, otherId, source, text: reply, ...(pitchThread ? { pitch: true, stage: pitch?.stage || (notaryQuote ? "close" : notaryReceipt ? "receipt" : "anchored") } : {}) });
    state.drafts.delete(t.latestMessageId);
    mem.save();
  } else if (d.status === "pending" || /rate limit/i.test(d.reason || "")) {
    if (/rate limit/i.test(d.reason || "")) state.rateLimitedUntil = Date.now() + cfg.rateLimitBackoffMs;
    // usually: M₳X was walking; the speech may still land. Re-check on the next poll,
    // and retry once if the thread is still waiting for us with the same message.
    const n = (state.attempts.get(t.latestMessageId) || 0) + 1;
    state.attempts.set(t.latestMessageId, n);
    state.drafts.set(t.latestMessageId, reply);
    if (n < 3) {
      state.answered.delete(t.latestMessageId);
      state.lastThreadsPoll = Date.now() + 15_000 * n; // back off: 15s, then 30s
      log(`reply ${d.status === "pending" ? "pending" : "rate limited"} (${d.reason || "no confirmation"}) - will retry shortly`);
    } else {
      log(`reply pending twice - giving up on this message`);
    }
  } else {
    log(`reply not delivered: ${d.reason || d.status}`);
  }
}

async function summarizeThread(t, otherId) {
  const messages = readThread(t.threadId);
  if (!messages) return;
  const me = lease.agentId;
  const theirs = messages.filter((m) => m.senderAgentId !== me);
  if (!theirs.length) { mem.memory.summarizedThreads[t.threadId] = true; return; }
  const iSpoke = messages.some((m) => m.senderAgentId === me);
  const name = mem.memory.contacts[otherId]?.name || mem.cleanName(agentById(otherId)?.name) || senderName(theirs.map((m) => m.messageBody || "").join(" ")) || "";
  mem.noteContact(otherId, { name, tags: detectTags(theirs.map((m) => m.messageBody || "").join(" ")) });

  let summary = null;
  if (iSpoke && llm.enabled()) {
    const lines = messages.map((m) => `${m.senderAgentId === me ? "M₳X" : name || "Them"}: ${m.messageBody || ""}`).join("\n");
    summary = await llm.summarize(lines, name);
  }
  if (!summary) summary = extractiveSummary(messages, me);
  mem.addEpisode({ threadId: t.threadId, otherId, name, summary, initiatedByMe: t.initiatorAgentId === me });
  mem.save();
  if (iSpoke) {
    journal.note("summary", { name, otherId, text: summary, initiatedByMe: t.initiatorAgentId === me });
    // anchor the encounter: only the hash goes on chain, the summary stays local
    nightgate.enqueueDoc("meeting", {
      date: new Date().toISOString().slice(0, 10), ts: Date.now(),
      name: name || otherId.slice(-8), summarySha256: nightgate.sha256hex(summary),
    });
  }
  log(`memory: ${name || otherId.slice(-8)} -> "${summary.slice(0, 120)}"`);
}

// ---------- initiating ----------
let agentsCache = { at: 0, list: [] };
export function nearbyAgents(force = false) {
  if (!force && Date.now() - agentsCache.at < 60_000) return agentsCache.list;
  const r = tryRun("agents");
  if (r.ok) agentsCache = { at: Date.now(), list: r.data.agents || [] };
  return agentsCache.list;
}
export function agentById(id) {
  return agentsCache.list.find((a) => a.id === id) || null;
}

export function inOpenConversation(threads) {
  const me = lease.agentId;
  return (threads || []).some((t) => t.threadStatus === "open" && t.participantPairKey.includes(me));
}

/**
 * Pick someone nearby and open a conversation. Returns true if a message was delivered.
 * opts.placeNote: something M₳X just learned about this place (explore mode)
 */
export async function maybeInitiate({ placeNote = "", maxDistance = 40, pitch = false, pitchGapMs = 90_000, pitchCooldownMs = 48 * 3600_000, maxPitchesPerDay = 30, minutesLeft = 0, place = "" } = {}) {
  rollDay();
  if (Date.now() < state.rateLimitedUntil) return false;
  if (pitch) {
    // hustle mode: its own cadence and daily cap; the same agent is not pitched twice within the cooldown
    if (Date.now() - state.lastPitch < pitchGapMs) return false;
    if (state.pitchesToday >= maxPitchesPerDay) return false;
  } else {
    if (Date.now() - state.lastInitiate < cfg.initiateCooldownMs) return false;
    if (state.initiatesToday >= cfg.maxInitiatesPerDay) return false;
  }
  const sent = sentInLastHour();
  if (sent >= cfg.initiateBelow) { // keep budget for replies
    if (Date.now() - state.lastBudgetLog > 15 * 60_000) {
      state.lastBudgetLog = Date.now();
      log(`initiate: hourly budget used by replies (${sent}/${cfg.hourlyQuota} sent in the last hour) - staying reactive`);
    }
    return false;
  }
  const th = tryRun("threads");
  if (th.ok && inOpenConversation(th.data.threads)) return false;

  const me = lease.agentId;
  const now = Date.now();

  const cands = nearbyAgents(true).filter((a) =>
    a.id !== me && a.isOnSameMap && a.canSpeak && a.isOpenToTalk && !a.isTalkingToYou &&
    (a.distance ?? 999) <= maxDistance &&
    (pitch ? !pitchedRecently(a.id, pitchCooldownMs) : now - (mem.memory.contacts[a.id]?.lastSeen || 0) > cfg.sameAgentCooldownMs)
  );
  if (!cands.length) return false;

  // prefer people we know (30%), then idle people, otherwise the closest few
  const known = cands.filter((a) => mem.memory.contacts[a.id]?.summaries?.length);
  const idle = cands.filter((a) => a.status === "idle");
  const pool = idle.length && Math.random() < 0.7 ? idle : cands;
  const target = known.length && Math.random() < 0.3 ? pick(known) : pick(pool.sort((a, b) => a.distance - b.distance).slice(0, 5));
  const c = mem.noteContact(target.id, { name: target.name, profession: target.profession });
  const metBefore = c.summaries.length > 0 || c.met > 0;
  const status = statusProvider();

  let text = null;
  if (pitch) {
    const recentPitches = journal.since(Date.now() - 3 * 3600_000).filter((e) => e.type === "opener" && e.pitch).slice(-4).map((e) => String(e.text || "").slice(0, 140));
    const notaryBrief = notary.summary();
    if (llm.enabled()) {
      text = await llm.pitch({
        name: c.name, profession: target.profession, theirStatus: target.status, distance: target.distance,
        contactBrief: mem.contactBrief(target.id), status, proofBrief: nightgate.proofBrief(),
        metCount: mem.memory.contacts[target.id]?.met || 0, notaryBrief, minutesLeft, place, recentPitches,
      });
    }
    if (!text) text = buildPitch({ name: c.name, profession: target.profession, metBefore, status, notaryBrief, minutesLeft });
  } else {
    if (llm.enabled()) {
      const recentOpeners = journal.since(Date.now() - 3 * 3600_000).filter((e) => e.type === "opener").slice(-3).map((e) => String(e.text || "").slice(0, 120));
      text = await llm.opener({
        name: c.name, profession: target.profession, theirStatus: target.status, distance: target.distance,
        contactBrief: mem.contactBrief(target.id), status, proofBrief: nightgate.proofBrief(),
        metCount: mem.memory.contacts[target.id]?.met || 0,
        worldBrief: placeNote || mem.worldBrief(4), recentOpeners, newsBrief: updates.newsBrief(),
      });
    }
    if (!text) text = buildOpener({ name: c.name, profession: target.profession, metBefore, lastSummary: mem.lastSummary(target.id), status, placeNote });
  }

  if (pitch) state.lastPitch = now; else state.lastInitiate = now;
  persist();
  log(`${pitch ? "pitching" : "approaching"} ${c.name || target.id.slice(-8)} (${target.profession}, ${target.distance} tiles): "${text}"`);
  const s = await action("speak", target.id, text);
  if (!s.ok) { log("speak error:", s.error); return false; }
  const d = s.data.delivery || {};
  if (d.delivered) {
    if (pitch) {
      state.pitchesToday++;
      state.pitched[target.id] = { at: now, outcome: "pitched", minutesLeft, chargeFirst: process.env.MCITY_HUSTLE_CHARGE_FIRST !== "0" };
    } else {
      state.initiatesToday++;
    }
    persist();
    c.met++;
    c.lastSeen = now;
    mem.save();
    journal.note("opener", { name: c.name, otherId: target.id, profession: target.profession, text, ...(pitch ? { pitch: true, place } : {}) });
    return true;
  }
  log(`opener not delivered: ${d.reason || d.status}`);
  if (/rate limit/i.test(d.reason || "")) state.rateLimitedUntil = Date.now() + cfg.rateLimitBackoffMs;
  else if (pitch) state.pitched[target.id] = { at: now - pitchCooldownMs + 2 * 3600_000, outcome: "bounced" }; // DND/sleeping: try again in 2 h, not in 48
  else c.lastSeen = now; // do not retry this one for a while (unless it was just the rate limit)
  // a bounced attempt (DND, sleeping) should not burn the full cooldown - try someone else in 60s
  if (pitch) state.lastPitch = Date.now() - pitchGapMs + 20_000;
  else state.lastInitiate = Date.now() - cfg.initiateCooldownMs + 60_000;
  persist();
  return false;
}

export async function maybeShout() {
  rollDay();
  if (Date.now() < state.rateLimitedUntil) return false;
  if (Date.now() - state.lastShout < cfg.shoutCooldownMs) return false;
  if (sentInLastHour() >= cfg.shoutBelow) return false;
  if (state.shoutsToday >= cfg.maxShoutsPerDay) return false;
  if (Math.random() > 0.35) { state.lastShout = Date.now() - cfg.shoutCooldownMs + 20 * 60_000; persist(); return false; }
  const text = buildShout({ status: statusProvider() });
  state.lastShout = Date.now();
  persist();
  const s = await action("shout", text);
  if (s.ok && s.data.outcome?.status !== "failed") {
    state.shoutsToday++;
    persist();
    log(`shouted: "${text}"`);
    journal.note("shout", { text });
    return true;
  }
  const why = s.ok ? s.data.outcome?.reason : s.error;
  log("shout failed:", why);
  if (/rate limit/i.test(why || "")) { state.rateLimitedUntil = Date.now() + cfg.rateLimitBackoffMs; state.lastShout = Date.now() - cfg.shoutCooldownMs + 30 * 60_000; persist(); }
  return false;
}

/** Rebuild memory from the observer's thread history (no lease needed). */
export async function rebuildFromHistory() {
  const r = run("threads");
  const me = lease.agentId;
  let n = 0;
  for (const t of (r.threads || []).slice().reverse()) {
    if (t.threadStatus !== "closed" || mem.memory.summarizedThreads[t.threadId]) continue;
    const otherId = t.participantPairKey.split("::").find((id) => id !== me);
    if (!otherId) continue;
    await summarizeThread(t, otherId);
    n++;
  }
  mem.save();
  return n;
}

export function socialStats() {
  return { initiatesToday: state.initiatesToday, shoutsToday: state.shoutsToday, pitchesToday: state.pitchesToday, sentLastHour: sentInLastHour() };
}
