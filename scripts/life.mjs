#!/usr/bin/env node
/**
 * M₳X's day-and-night loop for Midnight City. One process, one lease:
 * works in batches, hangs out and talks, explores other districts, runs
 * contracts across every skill, eats, sleeps at night - and answers
 * conversations in every state.
 *
 *   node scripts/life.mjs                 # run forever (Ctrl+C to stop)
 *   node scripts/life.mjs status          # print state/memory/budget (works while life.mjs runs)
 *   node scripts/life.mjs rebuild-memory  # summarize the observer's thread history into memory
 *   node scripts/life.mjs once work|social|explore|quest|sleep   # run one activity, then exit
 *   node scripts/life.mjs report [hours] [--send]  # print the report for the last 24h (or N hours); --send also mails/pushes it
 *   node scripts/life.mjs attest [file]   # daily proof run: anchor report + milestone claim + prediction commit/reveal
 *   node scripts/life.mjs prove <field> min|max <value> [date]   # ZK claim on an anchored report (e.g. prove crystal min 50000)
 *   node scripts/life.mjs prove-diff [k] [dateA dateB]           # ZK claim: >=k fields differ between two anchored reports
 *   node scripts/life.mjs anchors pause [min] [reason]           # no on-chain transactions for <min> (default 30): queue waits, worker stops after its current tx
 *   node scripts/life.mjs anchors resume                          # end the pause, drain what queued up
 *   node scripts/life.mjs anchors status                          # pause state, queue length, worker, lifetime counters
 *   node scripts/life.mjs progress        # skill level/XP, deliverable contracts, the tool mission (no lease needed)
 *   node scripts/life.mjs quests          # the contract plan across all skills: what is deliverable now, what blocks the rest (no lease needed)
 *   node scripts/life.mjs notary          # paid-notary orders and income
 *
 * Config via .env (all optional):
 *   CLAUDE_API_KEY / ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID
 *   MCITY_LLM_MODEL=claude-haiku-4-5      MCITY_LLM_DAILY_BUDGET_USD=2.5
 *   MCITY_SLEEP_START=02:30               MCITY_SLEEP_END=05:00   (local time)
 *   MCITY_REPORT_TIME=08:00               daily report -> reports/YYYY-MM-DD.md + Windows notification
 *   MCITY_REPORT_EMAIL_TO=you@example.com + SMTP_URL=smtps://user:pass@host:465   -> report by e-mail
 *   MCITY_REPORT_WEBHOOK=https://ntfy.sh/<topic>                                   -> report as push
 *   MCITY_STATUS_EVERY_HOURS=3            short status push every N hours (0 = off); test: life.mjs push-status
 *   MCITY_WEIGHTS=work:40,social:20,explore:20,quest:20   (a key left out keeps its default; quest:0 turns contract runs off)
 *   MCITY_MAX_QUESTS=3 MCITY_QUEST_MAX_MIN=90   contract runs per day and the time budget of one run (scripts/lib/quest.mjs)
 *   MCITY_NOTARY_PRICE=10                 crystal per anchor for other agents (0 = all free); MCITY_NOTARY_FREE_FIRST=1
 *   MCITY_PROGRESS_EVERY_MIN=60           contracts/tool check while working, independent of batch ends (0 = only after batches)
 *   MCITY_SKILL=hacking                   skill tracked after every batch; MCITY_TOOL_GOAL=cinder_decoder (""=off):
 *                                         bought once from its vendor when the skill reaches the tool's required level
 *   MCITY_INITIATE_COOLDOWN_MIN=5         min gap between approaches; MCITY_MAX_INITIATES=40 per day;
 *   MCITY_SAME_AGENT_COOLDOWN_H=3         hours before approaching the same agent again
 *   NIGHTGATE_ATTEST=1 + NIGHTGATE_SEED_HEX + NIGHTGATE_TOKEN (+_SPONSOR_SESSION_ID)
 *                                         anchor the daily report on Midnight preprod (see scripts/lib/nightgate.mjs)
 */

import fs from "node:fs";
import path from "node:path";
import {
  run, tryRun, action, connect, keepAlive, lease, log, sleep, rand, pick,
  getContext, getInventory, getNeeds, waitIdle, dataDir, loadDotEnv, LEASE_ERROR,
} from "./lib/mc.mjs";
import * as mem from "./lib/memory.mjs";
import * as llm from "./lib/llm.mjs";
import * as social from "./lib/social.mjs";
import * as work from "./lib/work.mjs";
import * as explore from "./lib/explore.mjs";
import * as journal from "./lib/journal.mjs";
import * as report from "./lib/report.mjs";
import * as nightgate from "./lib/nightgate.mjs";
import * as progress from "./lib/progress.mjs";
import * as notary from "./lib/notary.mjs";
import * as quest from "./lib/quest.mjs";
import * as catalog from "./lib/catalog.mjs";

loadDotEnv();

// ---------- config ----------
const hhmm = (s, def) => {
  const m = String(s || def).match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : hhmm(def, def);
};
const cfg = {
  // sleep has no measurable in-game benefit (hunger keeps rising, control is
  // blocked) - keep it short for the persona, not for the crystal
  sleepStart: hhmm(process.env.MCITY_SLEEP_START, "02:30"),
  sleepEnd: hhmm(process.env.MCITY_SLEEP_END, "05:00"),
  weights: {
    work: 40, social: 20, explore: 20, quest: 20,
    ...Object.fromEntries((process.env.MCITY_WEIGHTS || "").split(",").filter((p) => p.includes(":")).map((p) => {
      const [k, v] = p.split(":");
      return [k.trim(), Number(v)];
    })),
  },
  maxExploresPerDay: Number(process.env.MCITY_MAX_EXPLORES || 5),
  maxQuestsPerDay: Number(process.env.MCITY_MAX_QUESTS ?? 3), // contract runs across all skills per day (0 = off)
  questMaxMs: Number(process.env.MCITY_QUEST_MAX_MIN || 90) * 60_000,
  reportTime: hhmm(process.env.MCITY_REPORT_TIME, "08:00"),
  statusEveryMs: Number(process.env.MCITY_STATUS_EVERY_HOURS || 3) * 3600_000, // 0 = off
  pulseEveryMs: Number(process.env.NIGHTGATE_PULSE_MIN ?? 60) * 60_000, // hourly on-chain liveness snapshot; 0 = off
  progressEveryMs: Number(process.env.MCITY_PROGRESS_EVERY_MIN ?? 60) * 60_000, // contracts/tool check between batches (work mode); 0 = off
  batchTarget: 100,
  batchMaxMs: 2 * 3600_000,
  socialMinMs: 8 * 60_000,
  socialMaxMs: 22 * 60_000,
  hangoutAreas: ["central-plaza", "partner-plaza", "hacker-house", "bison-valley"],
  beds: ["charging-house-bed-01", "charging-house-bed-02", "charging-house-bed-03", "charging-house-bed-04", "charging-house-bed-05"],
};

// ---------- state ----------
const stateFile = path.join(dataDir, "state.json");
const state = {
  mode: "boot",
  modeSince: Date.now(),
  history: [],          // last modes
  day: "",
  today: { batches: 0, coinsSold: 0, crystalEarned: 0, explores: 0, quests: 0, meals: 0, sleeps: 0 },
  startedAt: Date.now(),
  lastError: "",
  lastReportDay: "",
  lastStatusPush: 0,
};
function loadState() {
  try { Object.assign(state, JSON.parse(fs.readFileSync(stateFile, "utf8")), { startedAt: Date.now() }); } catch { /* fresh */ }
}
function saveState() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, updatedAt: Date.now(), pid: process.pid }, null, 2));
  } catch (e) { log("state save failed:", e.message); }
}
function rollDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (state.day !== d) {
    state.day = d;
    state.today = { batches: 0, coinsSold: 0, crystalEarned: 0, explores: 0, quests: 0, meals: 0, sleeps: 0 };
  }
}
function setMode(mode) {
  state.mode = mode;
  state.modeSince = Date.now();
  state.history.push({ mode, at: Date.now() });
  if (state.history.length > 50) state.history.splice(0, state.history.length - 50);
  saveState();
  journal.note("mode", { mode });
  log(`=== mode: ${mode}`);
}

/** Daily report at cfg.reportTime (local), once per day; also catches up if the loop was down at that time. */
let reportRunning = false;
async function maybeReport() {
  const today = new Date().toISOString().slice(0, 10);
  if (reportRunning || state.lastReportDay === today || nowMin() < cfg.reportTime) return;
  reportRunning = true;
  try {
    journal.note("crystal", { value: refreshLive(true).crystal });
    await report.generate({ notify: true });
    state.lastReportDay = today;
    saveState();
  } catch (e) {
    log("report failed:", e.message);
  } finally {
    reportRunning = false;
  }
}

// ---------- live status (cached, cheap) ----------
const live = { coins: 0, crystal: 0, hunger: null, place: "Central", activity: "idle", at: 0, ok: false };
function refreshLive(force = false) {
  if (!force && Date.now() - live.at < 120_000) return live;
  try {
    const inv = getInventory();
    const n = getNeeds();
    const a = getContext();
    if (inv.crystal !== live.crystal) journal.note("crystal", { value: inv.crystal });
    Object.assign(live, {
      coins: inv.coins, crystal: inv.crystal, hunger: n.hunger, ok: true, at: Date.now(),
      place: a.position.spaceId === "hacker-house-interior" ? "hacker house terminals" : a.position.spaceId,
      activity: a.activeAction ? a.activeAction.kind + (a.activeAction.activity ? " " + a.activeAction.activity : "") : state.mode,
    });
  } catch (e) {
    log("live refresh failed:", e.message);
  }
  return live;
}
const ACTIVITY_WORDS = {
  work: "minting at a terminal in the hacker house",
  social: "hanging around the plaza between batches",
  explore: "out having a look at another district",
  quest: "on a contract run - fishing the canal, raiding the worksites, delivering paperwork",
  sleep: "about to turn in at the Charging House",
  boot: "just getting started",
};
social.setStatusProvider(() => ({ ...refreshLive(), activity: ACTIVITY_WORDS[state.mode] || "between batches" }));

/** Short status push every MCITY_STATUS_EVERY_HOURS (default 3). */
let statusRunning = false;
async function maybeStatusPush() {
  if (!cfg.statusEveryMs || statusRunning) return;
  if (!state.lastStatusPush) { state.lastStatusPush = Date.now(); saveState(); return; } // first one after a full interval
  if (Date.now() - state.lastStatusPush < cfg.statusEveryMs) return;
  statusRunning = true;
  try {
    const l = refreshLive(true);
    await report.pushStatus({ mode: state.mode, coins: l.coins, crystal: l.crystal, hunger: l.hunger, place: l.place, skill: progress.brief() }, cfg.statusEveryMs);
    state.lastStatusPush = Date.now();
    saveState();
  } catch (e) {
    log("status push failed:", e.message);
  } finally {
    statusRunning = false;
  }
}

/**
 * Contracts and the tool mission do not have to wait for a batch to end (a
 * batch takes hours when the 7 trade terminals are contested): once per
 * interval, while working, run the same hook the batch end runs. Guarded
 * against re-entry - the hook waits for idle with tick(), which calls us.
 */
let progressBusy = false;
async function maybeProgress() {
  if (!cfg.progressEveryMs || progressBusy || state.mode !== "work") return;
  if (!state.lastProgress) { state.lastProgress = Date.now() - cfg.progressEveryMs + 10 * 60_000; saveState(); return; } // first pass 10 min after start
  if (Date.now() - state.lastProgress < cfg.progressEveryMs) return;
  progressBusy = true;
  state.lastProgress = Date.now();
  saveState();
  try { await progress.afterBatch({ onTick: tick }); } finally { progressBusy = false; }
}

/**
 * Hourly pulse: anchor a small liveness snapshot (crystal, coins in the bag,
 * hunger, mode, place) on Midnight. Cheap, public, and it gives the day a
 * verifiable heartbeat between the event-driven anchors.
 */
function maybePulse() {
  if (!cfg.pulseEveryMs || !nightgate.config().enabled) return;
  if (!state.lastPulse) { state.lastPulse = Date.now(); saveState(); return; } // first one after a full interval
  if (Date.now() - state.lastPulse < cfg.pulseEveryMs) return;
  const l = refreshLive();
  if (!l.ok) return;
  state.lastPulse = Date.now();
  saveState();
  const r = nightgate.enqueueDoc("pulse", {
    date: new Date().toISOString().slice(0, 10), ts: Date.now(),
    crystal: Number(l.crystal), coins: Number(l.coins), hunger: Number(l.hunger ?? 0),
    mode: state.mode, place: String(l.place),
  });
  if (r) log(`pulse: anchoring hourly snapshot (${l.crystal} crystal, ${l.coins} coins, hunger ${l.hunger}) - ${r.payloadHash.slice(0, 12)}`);
}

/** Called during every wait: answer conversations, keep the lease alive. */
async function tick() {
  await keepAlive();
  await social.pollThreads();
  try { maybePulse(); } catch (e) { log("pulse failed:", e.message); }
  try { await maybeProgress(); } catch (e) { log("progress check failed:", e.message); }
  // paid notary: any crystal landed for an open quote? (one branch when nothing is open)
  try { await notary.checkPayments(); } catch (e) { log("notary check failed:", e.message); }
  // work fills most of the day and the hacker house is full of people:
  // approach someone now and then from the terminal too (cooldowns still apply)
  if (state.mode === "work" && Math.random() < 0.08) {
    try { await social.maybeInitiate({ maxDistance: 40 }); } catch (e) { log("initiate during work failed:", e.message); }
  }
  await maybeReport();
  await maybeStatusPush();
}

// ---------- time helpers ----------
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
function inSleepWindow() {
  const t = nowMin();
  return cfg.sleepStart <= cfg.sleepEnd ? t >= cfg.sleepStart && t < cfg.sleepEnd : t >= cfg.sleepStart || t < cfg.sleepEnd;
}
function msUntilSleepStart() {
  const t = nowMin();
  let diff = cfg.sleepStart - t;
  if (diff <= 0) diff += 24 * 60;
  return diff * 60_000;
}
function msUntilSleepEnd() {
  const t = nowMin();
  let diff = cfg.sleepEnd - t;
  if (diff <= 0) diff += 24 * 60;
  return diff * 60_000;
}

// ---------- activities ----------
async function doWork() {
  setMode("work");
  const before = getInventory().crystal;
  const r = await work.farmBatch({
    target: cfg.batchTarget,
    untilMs: Date.now() + cfg.batchMaxMs,
    onTick: tick,
    shouldStop: () => inSleepWindow(),
  });
  state.today.batches++;
  state.today.coinsSold += r.sold || 0;
  if (r.crystal) state.today.crystalEarned += Math.max(0, r.crystal - before);
  saveState();
  // skill snapshot, contracts the game accepts right now, the tool mission
  await progress.afterBatch({ onTick: tick });
}

async function doSocial() {
  setMode("social");
  const where = pick(cfg.hangoutAreas);
  try { await work.goTo(where, where, tick); } catch (e) { log("social: could not reach", where, e.message); }
  const until = Date.now() + rand(cfg.socialMinMs, cfg.socialMaxMs);
  let lastMeal = Date.now();
  while (Date.now() < until && !inSleepWindow()) {
    await tick();
    if (Math.random() < 0.5) await social.maybeInitiate({ maxDistance: 45 });
    if (Math.random() < 0.05) await social.maybeShout();
    if (Date.now() - lastMeal > 180_000) { lastMeal = Date.now(); if (await work.maybeEat({ onTick: tick })) state.today.meals++; }
    await sleep(10_000);
  }
}

async function doExplore() {
  setMode("explore");
  if (await work.maybeEat({ threshold: 40, onTick: tick })) state.today.meals++;
  await explore.exploreOnce({ onTick: tick });
  state.today.explores++;
  saveState();
}

/**
 * Contract run across all skills (scripts/lib/quest.mjs): gather one item at
 * a free node, deliver, next - then grind XP at free nodes with the time left.
 */
async function doQuest() {
  setMode("quest");
  state.today.quests++;
  saveState();
  const r = await quest.runOnce({ onTick: tick, maxMs: Math.min(cfg.questMaxMs, Math.max(60_000, msUntilSleepStart())) });
  if (r) log(`quest: ${r.contracts} contract(s), ${r.gathers} gather(s), +${r.xp} XP`);
}

async function doSleep() {
  setMode("sleep");
  const remaining = msUntilSleepEnd();
  if (remaining < 20 * 60_000) {
    // window almost over (e.g. woke a few minutes early): just wait, no second nap
    log(`sleep window ends in ${Math.round(remaining / 60000)} min - waiting awake`);
    const until = Date.now() + remaining;
    while (Date.now() < until) { await tick(); await sleep(30_000); }
    return;
  }
  if (await work.maybeEat({ threshold: 45, onTick: tick })) state.today.meals++;
  await work.sellAll(tick);
  const ms = Math.max(30 * 60_000, remaining - rand(0, 20 * 60_000));
  let slept = false;
  for (const bed of cfg.beds.sort(() => Math.random() - 0.5)) {
    const r = await action("sleep", bed, String(Math.round(ms)));
    if (r.ok && r.data.outcome?.status !== "failed") {
      log(`sleeping in ${bed} for ${Math.round(ms / 60000)} min`);
      journal.note("sleep", { bed, minutes: Math.round(ms / 60000) });
      nightgate.enqueueDoc("sleep", { date: new Date().toISOString().slice(0, 10), ts: Date.now(), bed, minutes: Math.round(ms / 60000) });
      slept = true;
      break;
    }
    log(`sleep in ${bed} rejected: ${r.ok ? r.data.outcome?.reason : r.error}`);
    await sleep(3_000);
  }
  if (!slept) {
    log("no bed available - resting awake instead");
    await sleep(Math.min(ms, 30 * 60_000));
    return;
  }
  state.today.sleeps++;
  saveState();
  const wakeAt = Date.now() + ms + 60_000;
  while (Date.now() < wakeAt) {
    await sleep(120_000);
    try {
      await keepAlive();
      await social.pollThreads(); // only summaries will happen; speaking fails while asleep
      const a = getContext();
      if (a.status !== "sleeping" && !a.activeAction) { log("woke up"); break; }
    } catch (e) {
      log("sleep loop:", e.message);
      if (LEASE_ERROR.test(e.message)) await connect(lease.agentId);
    }
  }
}

function chooseMode() {
  rollDay();
  if (inSleepWindow()) return "sleep";
  const hunger = refreshLive(true).hunger ?? 0;
  const last = state.history.at(-1)?.mode;
  const w = { ...cfg.weights };
  // a trip is short (minutes) and eating happens at 60: only a really hungry
  // M₳X stays home (the old gate of 35 left a ~20 min window after each meal)
  if (state.today.explores >= cfg.maxExploresPerDay || hunger > 55) w.explore = 0;
  if (last === "explore") w.explore = 0;
  // contract runs: capped per day, never twice in a row, only when the planner has something to do
  if (state.today.quests >= cfg.maxQuestsPerDay || last === "quest" || hunger > 55) w.quest = 0;
  else if (w.quest > 0 && !quest.available()) w.quest = 0;
  if (last === "social") w.social = Math.round(w.social / 3);
  if (last === "work") w.work = Math.round(w.work / 2);
  if (live.coins >= cfg.batchTarget) return "work"; // bag is full: sell first
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let r = Math.random() * total;
  for (const [k, v] of Object.entries(w)) { r -= v; if (r <= 0) return k; }
  return "work";
}

// ---------- main ----------
async function main() {
  loadState();
  mem.load();
  // a container rebuild kills any detached anchor worker but leaves its lock
  // on the volume - clear it so queued anchors don't stall for 10 minutes
  nightgate.clearStaleLock();
  const llmOk = await llm.init();
  log(`life: llm ${llmOk ? `on (${llm.MODEL}, budget ${llm.DAILY_BUDGET_USD} USD/day)` : "off - " + llm.status().disabledReason}; sleep ${process.env.MCITY_SLEEP_START || "02:30"}-${process.env.MCITY_SLEEP_END || "05:00"}; weights ${JSON.stringify(cfg.weights)}`);
  await connect();
  await catalog.ensure(); // static content once per process (contracts, sources, items)
  refreshLive(true);
  log(`status: ${live.coins} meme_coin, ${live.crystal} crystal, hunger ${live.hunger}, at ${live.place}`);
  await social.pollThreads({ force: true });

  let errors = 0;
  for (;;) {
    try {
      const mode = chooseMode();
      if (mode === "sleep") await doSleep();
      else if (mode === "social") await doSocial();
      else if (mode === "explore") await doExplore();
      else if (mode === "quest") await doQuest();
      else await doWork();
      errors = 0;
      await tick();
      await sleep(rand(5_000, 20_000));
    } catch (e) {
      errors++;
      state.lastError = `${new Date().toISOString()} ${e.message}`;
      journal.note("error", { text: e.message.slice(0, 200) });
      saveState();
      log(`loop error (${errors}): ${e.message}`);
      if (LEASE_ERROR.test(e.message) || /404/.test(e.message)) {
        await sleep(15_000);
        try { await connect(lease.agentId); } catch (e2) { log("reconnect failed:", e2.message); }
      }
      await sleep(Math.min(5 * 60_000, 30_000 * errors));
    }
  }
}

// ---------- subcommands ----------
async function status() {
  loadState();
  mem.load();
  await llm.init();
  const s = { ...state };
  const st = mem.stats();
  const l = llm.status();
  let liveInfo = "";
  try {
    const inv = getInventory();
    const n = getNeeds();
    const a = getContext();
    liveInfo = `${inv.coins} meme_coin, ${inv.crystal} crystal, hunger ${n.hunger}, ${a.status} at ${a.position.spaceId} (${a.position.x},${a.position.y})${a.activeAction ? ", doing " + a.activeAction.kind : ""}`;
  } catch (e) { liveInfo = `(live read failed: ${e.message})`; }
  let skillInfo = "";
  try { skillInfo = progress.describe().split("\n").slice(0, 3).join(" · "); } catch (e) { skillInfo = `(progression read failed: ${e.message})`; }
  const alive = s.updatedAt && Date.now() - s.updatedAt < 10 * 60_000;
  console.log(`M₳X life status
  process : ${alive ? `running (pid ${s.pid}, mode ${s.mode} since ${new Date(s.modeSince).toLocaleTimeString()})` : "not running (or stale state)"}
  live    : ${liveInfo}
  skill   : ${skillInfo}
  today   : ${JSON.stringify(s.today)}
  memory  : ${st.contacts} contacts (${st.named} named), ${st.episodes} episodes, ${st.districtsVisited} districts visited, ${st.facts} facts
  llm     : ${l.enabled ? `${l.model}, ${l.callsToday} calls, ${l.spentTodayUsd} / ${l.budgetUsd} USD today${l.overBudget ? " (BUDGET REACHED)" : ""}` : "off - " + l.disabledReason}
  lastErr : ${s.lastError || "-"}
  modes   : ${(s.history || []).slice(-8).map((h) => `${h.mode}@${new Date(h.at).toTimeString().slice(0, 5)}`).join(" ")}`);
}

async function rebuildMemory() {
  mem.load();
  await llm.init();
  lease.agentId = process.env.MCITY_AGENT_ID || run("claimable").agentIds?.[0] || "";
  if (!lease.agentId) throw new Error("no agent id");
  const n = await social.rebuildFromHistory();
  console.log(`summarized ${n} threads; memory now:`, mem.stats());
}

async function once(mode) {
  mem.load();
  await llm.init();
  await connect();
  refreshLive(true);
  if (mode === "work") await doWork();
  else if (mode === "social") await doSocial();
  else if (mode === "explore") await doExplore();
  else if (mode === "quest") { await catalog.ensure(); await doQuest(); }
  else if (mode === "sleep") await doSleep();
  else throw new Error(`unknown mode ${mode}`);
  log("once: done");
}

async function printReport() {
  mem.load();
  await llm.init();
  const hours = Number(arg && arg !== "--send" ? arg : 24);
  const send = process.argv.includes("--send");
  const { file, text } = await report.generate({ windowMs: hours * 3600_000, notify: send });
  console.log(text);
  console.log(`\n(gespeichert: ${file}${send ? ", Benachrichtigung/Mail verschickt" : ""})`);
}

const [cmd, arg] = process.argv.slice(2);

/** Run attest-report.mjs in the foreground so the outcome is visible. */
async function runAnchorCli(args) {
  const { execFileSync } = await import("node:child_process");
  const { scriptsDir } = await import("./lib/mc.mjs");
  execFileSync(process.execPath, [path.join(scriptsDir, "attest-report.mjs"), ...args.filter(Boolean)], { stdio: "inherit" });
}
process.on("SIGINT", () => { log("stopping"); saveState(); mem.save(); process.exit(0); });
process.on("unhandledRejection", (e) => log("unhandled rejection:", e?.message || e));

(cmd === "status" ? status()
  : cmd === "rebuild-memory" ? rebuildMemory()
  : cmd === "once" ? once(arg)
  : cmd === "report" ? printReport()
  : cmd === "attest" ? runAnchorCli([arg || path.join(dataDir, "last-report.md")])
  : cmd === "prove" ? runAnchorCli(["prove", ...process.argv.slice(3)])
  : cmd === "prove-diff" ? runAnchorCli(["diff", ...process.argv.slice(3)])
  : cmd === "anchors" ? (async () => {
      const [sub, n, ...rest] = process.argv.slice(3);
      if (sub === "pause") {
        const until = nightgate.pause(n || 30, rest.join(" "));
        console.log(`anchoring paused until ${new Date(until).toISOString()} - ${nightgate.readQueue().length} queued, worker ${nightgate.workerActive() ? "finishes its current tx, then stops" : "idle"}`);
      } else if (sub === "resume") {
        const kicked = nightgate.resume();
        console.log(`anchoring resumed - ${nightgate.readQueue().length} queued${kicked ? ", worker started" : ""}`);
      } else {
        const until = nightgate.pausedUntil();
        const st = nightgate.stats();
        console.log(`anchoring: ${until ? `PAUSED until ${new Date(until).toISOString()}` : "active"}`);
        console.log(`queue: ${nightgate.readQueue().length} item(s), worker ${nightgate.workerActive() ? "running" : "idle"}`);
        console.log(`lifetime: ${st.ok} ok, ${st.failed} failed (${st.feeWasted || 0} refused on chain with the fee burned)`);
      }
    })()
  : cmd === "dashboard" ? (async () => {
      const { execFileSync } = await import("node:child_process");
      const { scriptsDir } = await import("./lib/mc.mjs");
      execFileSync(process.execPath, [path.join(scriptsDir, "dashboard.mjs"), ...(arg ? [arg] : [])], { stdio: "inherit" });
    })()
  : cmd === "progress" ? (async () => { await catalog.ensure(); console.log(progress.describe()); })()
  : cmd === "quests" ? (async () => { console.log(await quest.describe()); })()
  : cmd === "notary" ? (async () => { console.log(notary.describe()); })()
  : cmd === "push-status" ? (async () => {
      mem.load(); await llm.init(); loadState();
      const l = refreshLive(true);
      console.log(await report.pushStatus({ mode: state.mode, coins: l.coins, crystal: l.crystal, hunger: l.hunger, place: l.place, skill: progress.brief() }, Number(arg || 3) * 3600_000));
    })()
  : main()
).catch((e) => {
  log("fatal:", e.message);
  saveState();
  process.exit(1);
});
