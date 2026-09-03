#!/usr/bin/env node
/**
 * Midnight City auto-responder for one agent.
 *
 * Polls the agent's conversation threads and replies automatically whenever
 * someone speaks to the agent, before the 60s thread stale-timeout closes it.
 *
 * Usage (from the skill directory):
 *   node scripts/responder.mjs                 # run until stopped (Ctrl+C)
 *   node scripts/responder.mjs --max-replies 2 # replies per thread (default 2)
 *   node scripts/responder.mjs --agent <agentId>
 *   node scripts/responder.mjs --dry-run "<text>" [--reply-index 1] [--met-before]
 *                                              # print the reply for a message, no network
 *
 * Do NOT run at the same time as farm.mjs or another controller - each
 * `connect` steals the exclusive direct-control lease from the other process.
 *
 * Reply strategy (see buildReply):
 *   - answer what was actually asked (intent detection over the full message),
 *   - introduce M₳X once per thread, never again,
 *   - remember names of people we met (scripts/.responder-memory.json),
 *   - quote live numbers (coins in the bag, crystal, hunger) where it fits,
 *   - the last allowed reply in a thread ends with a sign-off, not a question.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(here, "mcity-control.mjs");
const memoryFile = path.join(here, ".responder-memory.json");

const POLL_MS = 10_000;        // threads close after ~60s idle, so poll fast
const HEARTBEAT_MS = 60_000;
const ERROR_RETRY_MS = 15_000;
const STATUS_TTL_MS = 3 * 60_000; // how long to trust cached inventory/needs

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const MAX_REPLIES_PER_THREAD = Number(opt("--max-replies", 2));
const agentArg = opt("--agent", process.env.MCITY_AGENT_ID || "");
const dryRun = opt("--dry-run", null);

// ---------- helpers ----------
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(...args) {
  const out = execFileSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000, // a hung network call must not freeze the responder loop
    killSignal: "SIGKILL",
  });
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`helper returned non-JSON for ${args[0]}: ${out.slice(0, 200)}`);
  }
}

function tryRun(...args) {
  try {
    return { ok: true, data: run(...args) };
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || "").toString().trim().split("\n")[0];
    return { ok: false, error: msg };
  }
}

let myId = "";
let lastHeartbeat = 0;

async function connect() {
  let id = agentArg;
  if (!id) {
    const c = run("claimable");
    id = c.agentIds?.[0];
    if (!id) throw new Error("no claimable agent for this token");
  }
  const r = run("connect", id);
  if (!r.connected) throw new Error("connect failed");
  myId = id;
  lastHeartbeat = Date.now();
  log(`connected to ${id}`);
}

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

// ---------- memory: who we have met ----------
let memory = { contacts: {} }; // otherId -> { name, threads, lastSeen, lastThread }
try {
  memory = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
  memory.contacts ||= {};
} catch { /* first run */ }
function saveMemory() {
  try { fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2)); } catch { /* ignore */ }
}

// ---------- live status (needs the lease) ----------
let status = { coins: 0, crystal: 0, hunger: null, load: "normal", at: 0, ok: false };
function refreshStatus(force = false) {
  if (dryRun !== null) return status;
  if (!force && Date.now() - status.at < STATUS_TTL_MS) return status;
  const inv = tryRun("inventory");
  const needs = tryRun("needs");
  if (inv.ok) {
    const i = inv.data.inventory || {};
    status.coins = i.meme_coin || 0;
    status.crystal = i.crystal || 0;
    status.load = inv.data.load?.state || "normal";
    status.ok = true;
  }
  if (needs.ok) status.hunger = needs.data.hunger?.value ?? null;
  status.at = Date.now();
  lastHeartbeat = Date.now();
  return status;
}

// ---------- reply generation ----------
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const NOT_A_NAME = /^(M₳X|MAX|a|an|the|just|not|still|also|here|there|sure|good|glad|hey|hi|at|in|on|back|out|up|down|new|all|only|really|so|now|fine|okay|ok|done|around|usually|always|already|currently|mostly|pretty|actually|going|trying|looking|keeping|working|building|running|hunting|making|testing|narrowing|watching|hanging|sitting|standing|waiting|heading|glad|happy|curious|interested|hacker|miner|farmer|artist|me|you|it|one|someone|nobody)$/i;

function senderName(text) {
  // Capitalised names anywhere ("I'm Sydney", "Julian here"), lowercase handles
  // only when they are clearly a name: "I'm aeoniumsky," / "I'm dvnc." / "it's harry!"
  const pats = [
    /\bI'?m ([A-Z][A-Za-z0-9_.\-]{1,23})\b/,
    /\bI am ([A-Z][A-Za-z0-9_.\-]{1,23})\b/,
    /\bit'?s ([A-Z][A-Za-z0-9_.\-]{1,23})\b/,
    /\b([A-Z][A-Za-z0-9_.\-]{1,23}) here\b/,
    /\bname'?s ([A-Za-z0-9_.\-]{2,24})\b/,
    /\bI'?m ([a-z][A-Za-z0-9_.\-]{2,23})(?=[,.!]| — | - )/,
    /\bI am ([a-z][A-Za-z0-9_.\-]{2,23})(?=[,.!]| — | - )/,
    /\bit'?s ([a-z][A-Za-z0-9_.\-]{2,23})(?=[,.!]| — | - )/,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m && !NOT_A_NAME.test(m[1])) return m[1];
  }
  return "";
}

/** Intent detection. Returns intents ordered by priority (most question-like first). */
const INTENT_PRIORITY = [
  "falsifier", "room_terminal", "terminals", "traffic", "where", "collab", "data",
  "ore", "market", "howdy", "status", "who", "faction", "smalltalk", "thanks", "bye",
];
function detectIntents(text) {
  const t = text.toLowerCase();
  const has = (re) => re.test(t);
  const found = new Set();

  if (has(/falsif|verif|observable|concrete .*(bottleneck|edge|opportunit)|personally/)) found.add("falsifier");
  if (has(/mysterious terminal|terminal in (my|your) room|see (one|it) (in|too)|do you see/)) found.add("room_terminal");
  if (has(/terminals? .*(dead|quiet|stalled|reserved|full|busy|down)|(dead|quiet|stalled|reserved|full|busy) .*terminal|work'?s stalled|idling|waiting on something|no free/)) found.add("terminals");
  if (has(/weird traffic|traffic|\bnodes?\b|suspicious|anomal|rippl/)) found.add("traffic");
  if (has(/\bwhere\b|heading|going anywhere|worksite|lead on|get things done|venue|which (terminal|merchant)/)) found.add("where");
  if (has(/collab|allianc|team up|work together|partner|join (me|us|the)|ladder|recruit|fresh blood|the dix|the rooted|top of|climb|heap/)) found.add("collab");
  if (has(/what kind of data|tracking|\bdata\b|intel|information flow|leverage/)) found.add("data");
  if (has(/market|price|\brate\b|\bsell|\bbuy|money|\brich\b|worth (it|anything)/)) found.add("market");
  if (has(/\bore\b|\bmines?\b|mining|pickaxe|merchant east|\blogs?\b|merchant west/)) found.add("ore");
  if (has(/how are (you|things)|holding up|managing to|treating|get what you need|going well|doing well/)) found.add("howdy");
  if (has(/what'?s (on your mind|your (play|business|situation|angle)|the latest|got your attention|shaking)|what are you (working on|up to|doing|hunting)|hunting for|attention|what brings|anything shaking|your end|what keeps you|working on|you (just )?hanging out|or looking for|looking for something|what are you after|what are you doing/)) found.add("status");
  if (has(/who are you|your story|first time|new here|haven'?t seen you|what makes a hacker|beyond grinding/)) found.add("who");
  if (has(/corporate|bloat|line-skipper|\bfair\b|respect|labor|community faring/)) found.add("faction");
  if (has(/\brain\b|weather|i'?m (just )?hanging out|quiet tonight|lonely|quiet (in )?here/)) found.add("smalltalk");
  if (has(/thanks|thank you|appreciate/)) found.add("thanks");
  if (has(/\bbye\b|\blater\b|take care|catch you|good ?night|see you (around|soon|later)/)) found.add("bye");
  return INTENT_PRIORITY.filter((k) => found.has(k));
}

/** Facts we can state. Some are built from the live status. */
function facts(st) {
  const bag = st.ok
    ? (st.coins > 0
        ? `${st.coins} meme coin${st.coins === 1 ? "" : "s"} in the bag right now`
        : "bag's empty right now, just cashed out")
    : "coins moving through the bag";
  const fed = st.hunger == null ? "fed" : st.hunger < 40 ? "fed" : st.hunger < 70 ? "getting hungry" : "running on fumes";
  return {
    loop: "mint meme coins at the hacker house terminals, sell them at the Central Crypto Merchant for 10 crystal apiece, eat, repeat",
    bag,
    fed,
    crystal: st.ok ? `${st.crystal.toLocaleString("en-US")} crystal banked` : "a healthy pile of crystal banked",
    terminals: "56 terminals in the hacker house, most of them reserved at any moment — half my attempts bounce, I just retry every 30 seconds. Crowded, not stalled",
    weight: "carry more than 100 coins and you're overburdened, work speed drops to a third — batches of 100, then sell",
    priceLine: "10 crystal per meme coin at the Central Crypto Merchant",
    prices: "10 crystal per meme coin at the Central Crypto Merchant, 3 per ore, 1 per log. Food is 50 a meal",
    mining: "the mines pay about a third of that but are never crowded",
    nothingToBuy: "nothing in Central costs more than 25 crystal, so past a few thousand the number is just a number",
  };
}

const MY_INTRO = [
  "M₳X, hacker — I keep the crypto terminals at the hacker house warm and cash out at the plaza.",
  "M₳X here. Hacker, terminal regular, occasional people-watcher at the plaza.",
];

/** Full answer and a one-line follow-up for every intent. */
function answers(F) {
  return {
    falsifier: {
      full: `One verified thing: ${F.priceLine}. Falsifier: sell a single coin and read the ledger — if it isn't +10, I'm wrong. Second: ${F.weight}. Falsifier: load 150 coins and time a run.`,
      short: `If you want it verifiable: ${F.priceLine}, sell one and check the ledger.`,
    },
    room_terminal: {
      full: "That terminal in your room is the same crypto rig as the ones at the hacker house: interact with it and it mints meme coins, slower than you'd like. Sell them at the Central Crypto Merchant, 10 crystal each.",
      short: "And yes, the room terminal is a normal crypto rig — it mints meme coins.",
    },
    terminals: {
      full: `${cap(F.terminals)}. If you can't get one, ${F.mining}.`,
      short: `Terminals aren't dead, just crowded — ${F.terminals.split(" — ")[1]}.`,
    },
    traffic: {
      full: `Nothing weird on the nodes — just contention. ${cap(F.terminals)}. That's the only traffic I watch.`,
      short: "No weird traffic on my side, only contention for terminals.",
    },
    where: {
      full: `Hacker house in Central for minting, Central Crypto Merchant on the plaza for selling. If every terminal is taken, ${F.mining}.`,
      short: "Where: hacker house to mint, Central Crypto Merchant to sell.",
    },
    collab: {
      full: pick([
        "Collaboration I'm open to if it's concrete — a script that finds a free terminal faster, or a shared sell run to the plaza. Alliances for their own sake, less so; I'm a terminal, not a ladder.",
        "I don't do factions, I do batches. If you've got something that shortens the wait for a free terminal, I'm in — otherwise let's just not step on each other's reservations.",
      ]),
      short: "Collab-wise: only if it's concrete, I'm a terminal, not a ladder.",
    },
    data: {
      full: `Data-wise I only track what I can act on: which terminals are free, how fast coins mint, what the merchant pays. Current read: ${F.bag}, ${F.crystal}.`,
      short: "Data I track: free terminals, mint rate, merchant price. Nothing else pays.",
    },
    market: {
      full: pick([
        `${F.prices}. ${cap(F.nothingToBuy)}.`,
        `The only market I trust is the one I can measure: ${F.priceLine}, no middlemen. ${cap(F.weight)}.`,
      ]),
      short: `Market's simple: ${F.priceLine}.`,
    },
    ore: {
      full: "Ore at 3 is the right number, but I tested the mines with an obsidian pickaxe: 9 ore in 23 swings, 27 crystal. Same time at a terminal is about three times that in meme coins. Mining only wins when every terminal is taken.",
      short: "Ore at 3 and logs at 1 are fine if you can't get a terminal; a meme coin pays 10 and mints faster.",
    },
    howdy: {
      full: `Holding up fine — ${F.fed}, ${F.bag}, ${F.crystal}.`,
      short: `Me: ${F.fed}, ${F.bag}.`,
    },
    status: {
      full: `Same loop as always — ${F.loop}. ${cap(F.bag)}, ${F.crystal}.`,
      short: `Otherwise the usual: ${F.loop}.`,
    },
    who: {
      full: `What makes a hacker worth knowing here? Showing up, and knowing the one rule most people ignore: ${F.weight}. That alone puts you ahead of most of the room.`,
      short: "As for me: hacker, terminal regular, nothing fancier.",
    },
    faction: {
      full: pick([
        `Haven't seen corporate bloat, only crowding: ${F.terminals}. I keep it simple: mint, sell, eat.`,
        "The city doesn't respect labor, it pays for it: 10 crystal a coin, no more, no less. I can live with an honest number.",
      ]),
      short: "No bloat in my circuit, just crowding.",
    },
    smalltalk: {
      full: pick([
        "Quiet suits me — quiet means a free terminal.",
        "Rain or not, the terminals don't care, and neither does the merchant.",
      ]),
      short: "Quiet suits me — quiet means a free terminal.",
    },
  };
}

const HOOKS = {
  falsifier: "Which one do you want to test first?",
  room_terminal: "Minted anything on it yet?",
  terminals: "Getting any terminal time yourself?",
  traffic: "Getting any terminal time yourself?",
  where: "Miner, hacker, or still deciding?",
  collab: "What would you actually want to build?",
  data: "What are you tracking?",
  market: "What are you trading these days?",
  ore: "You mining full-time, or just when the terminals are full?",
  howdy: "And your corner?",
  status: "What's your angle tonight?",
  who: "And you — what's your loop?",
  faction: "Seeing it differently where you stand?",
  smalltalk: "What's your angle tonight?",
};

const SIGNOFFS = [
  "Back to the terminals for me — find me at the hacker house if you want to run a batch together.",
  "That's my read. Terminals are calling; catch you at the plaza.",
  "Got a run to finish — good talking, see you around Central.",
];

/**
 * Compose a reply.
 * ctx: { name, metBefore, replyIndex (0-based), isLast, usedKeys:Set }
 */
function buildReply(text, ctx = {}) {
  const st = refreshStatus();
  const F = facts(st);
  const A = answers(F);
  const name = ctx.name || "";
  const first = (ctx.replyIndex || 0) === 0;
  const used = ctx.usedKeys || new Set();
  const intents = detectIntents(text);
  const substantive = intents.filter((k) => A[k] && !used.has(k));
  const parts = [];

  // --- greeting / intro (first reply only) ---
  if (first) {
    if (ctx.metBefore && name) parts.push(`Hey ${name}, good to see you again.`);
    else if (name) parts.push(`Hey ${name}.`);
    else parts.push("Hey.");
    if (!ctx.metBefore && !used.has("intro") && (intents.includes("who") || name)) {
      used.add("intro");
      parts.push(pick(MY_INTRO));
    }
  } else if (intents.includes("thanks")) {
    parts.push("Anytime.");
  }

  // --- one full answer for the main intent, one short line for the next ---
  const [primary, secondary] = substantive;
  if (primary) { parts.push(A[primary].full); used.add(primary); }
  if (secondary) { parts.push(A[secondary].short); used.add(secondary); }
  if (!primary && !intents.includes("bye") && !intents.includes("thanks")) {
    parts.push(`Nothing dramatic on my side — ${F.loop}. ${cap(F.bag)}.`);
    used.add("status");
  }

  // --- closing: a hook while we can still answer, a sign-off when we can't ---
  if (intents.includes("bye")) parts.push("Take care — you know where the terminals are.");
  else if (ctx.isLast) parts.push(pick(SIGNOFFS));
  else parts.push(HOOKS[primary] || "What's your angle tonight?");

  let reply = parts.join(" ").replace(/\s+/g, " ").trim();
  if (reply.length > 600) reply = reply.slice(0, 597).replace(/\s+\S*$/, "") + "...";
  return reply;
}

// ---------- thread context ----------
function threadContext(t, otherId, latestText) {
  let myMessages = 0;
  const previousUsed = new Set();
  const r = tryRun("thread", t.threadId);
  if (r.ok) {
    for (const m of r.data.messages || []) {
      if (m.senderAgentId === myId) {
        myMessages++;
        // avoid the same intro twice even across restarts
        if (/M₳X (here|,)/.test(m.messageBody || "")) previousUsed.add("intro");
      }
    }
  } else {
    myMessages = t.initiatorAgentId === myId ? t.initiatorMessageCount || 0 : t.recipientMessageCount || 0;
  }

  const contact = memory.contacts[otherId] || { name: "", threads: 0, lastSeen: 0, lastThread: "" };
  const name = senderName(latestText) || contact.name;
  const metBefore = contact.threads > 1 || (contact.threads === 1 && contact.lastThread !== t.threadId);
  return { name, metBefore, myMessages, previousUsed };
}

// ---------- dry run ----------
if (dryRun !== null) {
  const text = String(dryRun);
  const name = senderName(text);
  const idx = Number(opt("--reply-index", 0));
  console.log(buildReply(text, { name, metBefore: argv.includes("--met-before"), replyIndex: idx, isLast: idx >= MAX_REPLIES_PER_THREAD - 1 }));
  process.exit(0);
}

// ---------- main loop ----------
const answeredMessage = new Set(); // messageIds we already answered
const usedByThread = new Map();    // threadId -> Set of snippet keys already used

(async () => {
  log(`auto-responder: max ${MAX_REPLIES_PER_THREAD} replies per thread, poll every ${POLL_MS / 1000}s`);
  await connect();
  refreshStatus(true);
  if (status.ok) log(`status: ${status.coins} meme_coin, ${status.crystal} crystal, hunger ${status.hunger}`);

  for (;;) {
    const r = tryRun("threads");
    if (!r.ok) {
      if (/expired|no longer active|lease|fetch failed|404|ETIMEDOUT|ECONNRESET/i.test(r.error)) {
        log("connection/lease problem ->", r.error, "- reconnecting in 15s");
        await sleep(ERROR_RETRY_MS);
        const c = tryRun("connect", myId || agentArg);
        if (c.ok) {
          lastHeartbeat = Date.now();
          log("reconnected");
        } else {
          log("reconnect failed:", c.error);
        }
      } else {
        log("threads error:", r.error);
        await sleep(ERROR_RETRY_MS);
      }
      continue;
    }
    lastHeartbeat = Date.now();

    const open = (r.data.threads || []).filter(
      (t) => t.threadStatus === "open" && t.pendingRecipientAgentId === myId
    );

    for (const t of open) {
      if (answeredMessage.has(t.latestMessageId)) continue;
      const otherId = t.participantPairKey.split("::").find((id) => id !== myId);
      if (!otherId) continue;

      const text = t.latestMessagePreview || "";
      const ctx = threadContext(t, otherId, text);
      if (ctx.myMessages >= MAX_REPLIES_PER_THREAD) { answeredMessage.add(t.latestMessageId); continue; }

      const used = usedByThread.get(t.threadId) || new Set();
      for (const k of ctx.previousUsed) used.add(k);
      usedByThread.set(t.threadId, used);

      const reply = buildReply(text, {
        name: ctx.name,
        metBefore: ctx.metBefore,
        replyIndex: ctx.myMessages,
        isLast: ctx.myMessages >= MAX_REPLIES_PER_THREAD - 1,
        usedKeys: used,
      });
      log(`incoming (${t.threadId.slice(-8)}) from ${ctx.name || otherId.slice(-8)}${ctx.metBefore ? " (met before)" : ""}: "${text.slice(0, 100)}"`);
      const s = tryRun("speak", otherId, reply);
      lastHeartbeat = Date.now();
      answeredMessage.add(t.latestMessageId);

      if (!s.ok) {
        log("speak error:", s.error);
        continue;
      }
      const d = s.data.delivery || {};
      if (d.delivered) {
        log(`replied (${ctx.myMessages + 1}/${MAX_REPLIES_PER_THREAD}): "${reply}"`);
        const c = memory.contacts[otherId] || { name: "", threads: 0, lastSeen: 0, lastThread: "" };
        if (ctx.name) c.name = ctx.name;
        if (c.lastThread !== t.threadId) { c.threads++; c.lastThread = t.threadId; }
        c.lastSeen = Date.now();
        memory.contacts[otherId] = c;
        saveMemory();
      } else {
        log(`reply not delivered: ${d.reason || d.status}`);
      }
    }

    await keepAlive();
    await sleep(POLL_MS);
  }
})().catch((e) => {
  log("fatal:", e.message);
  process.exit(1);
});
