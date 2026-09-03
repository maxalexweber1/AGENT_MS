/**
 * Rule-based conversation engine for M₳X (no network, no LLM).
 * Used as the fallback when no API key is configured, the daily LLM budget is
 * spent, or the API errors out.
 */

import { projectLine, projectShout, nightgateOpener } from "./lore.mjs";
import { proofFacts, shortHash } from "./nightgate.mjs";

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const NOT_A_NAME = /^(M₳X|MAX|a|an|the|just|not|still|also|here|there|sure|good|glad|hey|hi|at|in|on|back|out|up|down|new|all|only|really|so|now|fine|okay|ok|done|around|usually|always|already|currently|mostly|pretty|actually|going|trying|looking|keeping|working|building|running|hunting|making|testing|narrowing|watching|hanging|sitting|standing|waiting|heading|glad|happy|curious|interested|hacker|miner|farmer|artist|lumberjack|me|you|it|one|someone|nobody)$/i;

export function senderName(text) {
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
    if (!m || NOT_A_NAME.test(m[1])) continue;
    // lowercase "I'm minting." / "I'm done." are verbs, not handles
    if (/^[a-z]/.test(m[1]) && /(ing|ed|ly)$/.test(m[1])) continue;
    return m[1];
  }
  return "";
}

/** Faction / affiliation hints people drop in conversation. */
export function detectTags(text) {
  const t = text.toLowerCase();
  const tags = [];
  if (/the rooted|under root and star/.test(t)) tags.push("The Rooted");
  if (/the dix\b/.test(t)) tags.push("The Dix");
  if (/\bminer\b|\bmines?\b|mining/.test(t)) tags.push("mining");
  if (/lumberjack|\blogs?\b|chop/.test(t)) tags.push("logging");
  if (/\bart\b|artist|making art/.test(t)) tags.push("art");
  if (/allianc|recruit|ladder|climb|top of/.test(t)) tags.push("ambitious");
  if (/falsif|verif|observable/.test(t)) tags.push("analyst");
  if (/\bhacker\b/.test(t)) tags.push("hacker");
  return tags;
}

export const INTENT_PRIORITY = [
  "proof", "falsifier", "projects", "room_terminal", "terminals", "traffic", "where", "collab", "data",
  "ore", "market", "howdy", "status", "who", "faction", "smalltalk", "thanks", "bye",
];

export function detectIntents(text) {
  const t = text.toLowerCase();
  const has = (re) => re.test(t);
  const found = new Set();
  if (has(/prove (it|that|you)|can you prove|show me (the )?proof|receipts?\b|on.?chain|anchored|payload.?hash|\btx hash\b|your hash|how do i (check|verify)|really did that|believe you|notari[sz]e|anchor (this|that|it|my|me)|hash (this|that|it|my)|make (it|this|that) official|witness (this|my)/)) found.add("proof");
  if (has(/falsif|verif|observable|concrete .*(bottleneck|edge|opportunit)|personally/)) found.add("falsifier");
  if (has(/what (do|are) you (build|hack|ship|code|develop)|building anything|your project|side project|what.*(cardano|midnight)|zero.?knowledge|\bzk\b|privacy|attest|passport|battery|\bsap\b|odata|enterprise|smart contract|\bproofs?\b|scripts you|writing code|odatano|nightgate|nightpass/)) found.add("projects");
  if (has(/mysterious terminal|terminal in (my|your) room|see (one|it) (in|too)|do you see/)) found.add("room_terminal");
  if (has(/terminals? .*(dead|quiet|stalled|reserved|full|busy|down)|(dead|quiet|stalled|reserved|full|busy) .*terminal|work'?s stalled|idling|waiting on something|no free/)) found.add("terminals");
  if (has(/weird traffic|traffic|\bnodes?\b|suspicious|anomal|rippl/)) found.add("traffic");
  if (has(/\bwhere\b|heading|going anywhere|worksite|lead on|get things done|venue|which (terminal|merchant)/)) found.add("where");
  if (has(/collab|allianc|team up|work together|partner|join (me|us|the)|ladder|recruit|fresh blood|the dix|the rooted|top of|climb|heap/)) found.add("collab");
  if (has(/what kind of data|tracking|\bdata\b|intel|information flow|leverage/)) found.add("data");
  if (has(/\bore\b|\bmines?\b|mining|pickaxe|merchant east|\blogs?\b|merchant west/)) found.add("ore");
  if (has(/market|price|\brate\b|\bsell|\bbuy|money|\brich\b|worth (it|anything)/)) found.add("market");
  if (has(/how are (you|things)|holding up|managing to|treating|get what you need|going well|doing well/)) found.add("howdy");
  if (has(/what'?s (on your mind|your (play|business|situation|angle)|the latest|got your attention|shaking)|what are you (working on|up to|doing|hunting)|hunting for|attention|what brings|anything shaking|your end|what keeps you|working on|you (just )?hanging out|or looking for|looking for something|what are you after|what are you doing/)) found.add("status");
  if (has(/who are you|your story|first time|new here|haven'?t seen you|what makes a hacker|beyond grinding/)) found.add("who");
  if (has(/corporate|bloat|line-skipper|\bfair\b|respect|labor|community faring/)) found.add("faction");
  if (has(/\brain\b|weather|i'?m (just )?hanging out|quiet tonight|lonely|quiet (in )?here/)) found.add("smalltalk");
  if (has(/thanks|thank you|appreciate/)) found.add("thanks");
  if (has(/\bbye\b|\blater\b|take care|catch you|good ?night|see you (around|soon|later)/)) found.add("bye");
  return INTENT_PRIORITY.filter((k) => found.has(k));
}

/** Facts M₳X can state; some are built from the live status. */
export function facts(st = {}) {
  const ok = st.ok !== false && st.crystal != null;
  const bag = ok
    ? (st.coins > 0 ? `${st.coins} meme coin${st.coins === 1 ? "" : "s"} in the bag right now` : "bag's empty right now, just cashed out")
    : "coins moving through the bag";
  const fed = st.hunger == null ? "fed" : st.hunger < 40 ? "fed" : st.hunger < 70 ? "getting hungry" : "running on fumes";
  return {
    loop: "mint meme coins at the hacker house terminals, sell them at the Central Crypto Merchant for 10 crystal apiece, eat, repeat",
    bag,
    fed,
    crystal: ok ? `${Number(st.crystal).toLocaleString("en-US")} crystal banked` : "a healthy pile of crystal banked",
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

function answers(F, topic = "") {
  const P = proofFacts();
  const proofFull = P?.report
    ? pick([
        `Happily — I don't do claims, I do anchors. My daily report from ${P.report.date} is on Midnight ${P.network}: sha256 ${P.report.payloadHash}. Check it against the AttestationVault ${shortHash(P.vault)} via NIGHTGATE's verifyAttestationState, no wallet needed.`,
        `Sure. ${P.total} anchors so far, ${P.todays} today${P.predicate ? ` — including a zero-knowledge claim that my ${P.predicate.field} is ${P.predicate.op === 1 ? "at least" : "at most"} ${P.predicate.threshold}, without showing the number` : ""}. Latest report hash: ${P.report.payloadHash}. Verify it yourself against live contract state.`,
      ])
    : "Fair ask — the anchor run happens each morning; catch me after and I'll hand you the sha256 of my daily report, verifiable on Midnight against live contract state.";
  return {
    proof: {
      full: proofFull,
      short: P?.report ? `And it's checkable: report hash ${shortHash(P.report.payloadHash)} on the vault, live state.` : "Ask me tomorrow morning and you get the hash.",
    },
    projects: {
      full: projectLine(topic),
      short: "Off the terminals I build ODATANO stuff - Cardano and Midnight tooling for enterprise folks. Ask me if you care.",
    },
    falsifier: {
      full: P?.report
        ? `One verified thing: ${F.priceLine}. Falsifier: sell a single coin and read the ledger. Better one: my whole day is anchored on Midnight — sha256 ${shortHash(P.report.payloadHash)} on the AttestationVault. If the hash doesn't verify, I'm lying.`
        : `One verified thing: ${F.priceLine}. Falsifier: sell a single coin and read the ledger — if it isn't +10, I'm wrong. Second: ${F.weight}. Falsifier: load 150 coins and time a run.`,
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
    ore: {
      full: "Ore at 3 is the right number, but I tested the mines with an obsidian pickaxe: 9 ore in 23 swings, 27 crystal. Same time at a terminal is about three times that in meme coins. Mining only wins when every terminal is taken.",
      short: "Ore at 3 and logs at 1 are fine if you can't get a terminal; a meme coin pays 10 and mints faster.",
    },
    market: {
      full: pick([
        `${F.prices}. ${cap(F.nothingToBuy)}.`,
        `The only market I trust is the one I can measure: ${F.priceLine}, no middlemen. ${cap(F.weight)}.`,
      ]),
      short: `Market's simple: ${F.priceLine}.`,
    },
    howdy: {
      full: `Holding up fine — ${F.fed}, ${F.bag}, ${F.crystal}.`,
      short: `Me: ${F.fed}, ${F.bag}.`,
    },
    status: {
      full: pick([
        `Same loop as always — ${F.loop}. ${cap(F.bag)}, ${F.crystal}.`,
        `Terminals for crystal, and between batches I'm heads-down on real code — ${projectLine(topic).replace(/^Between batches I work on /, "")} ${cap(F.bag)}.`,
      ]),
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
  proof: "Want the vault address too, so you can check it yourself?",
  projects: "You building anything yourself, or strictly terminals?",
  falsifier: "Which one do you want to test first?",
  room_terminal: "Minted anything on it yet?",
  terminals: "Getting any terminal time yourself?",
  traffic: "Getting any terminal time yourself?",
  where: "Miner, hacker, or still deciding?",
  collab: "What would you actually want to build?",
  data: "What are you tracking?",
  ore: "You mining full-time, or just when the terminals are full?",
  market: "What are you trading these days?",
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
 * ctx: { name, metBefore, replyIndex (0-based), isLast, usedKeys:Set, status, lastSummary }
 */
export function buildReply(text, ctx = {}) {
  const F = facts(ctx.status || {});
  const A = answers(F, text);
  if (ctx.notaryHash) {
    // the claim from their message is being anchored right now - receipt first
    A.proof = {
      full: `Done — I hashed your exact words and I'm anchoring them on Midnight right now, sponsor pays the fee. Your receipt: sha256 ${ctx.notaryHash}. Give it a minute to finalize, then anyone can verify it against live contract state.`,
      short: `Your claim is being anchored — receipt ${shortHash(ctx.notaryHash)}.`,
    };
  }
  const name = ctx.name || "";
  const first = (ctx.replyIndex || 0) === 0;
  const used = ctx.usedKeys || new Set();
  const intents = detectIntents(text);
  const substantive = intents.filter((k) => A[k] && !used.has(k));
  const parts = [];

  if (first) {
    if (ctx.metBefore && name) parts.push(`Hey ${name}, good to see you again.`);
    else if (name) parts.push(`Hey ${name}.`);
    else parts.push("Hey.");
    if (ctx.metBefore && spoken(ctx.lastSummary)) parts.push(`Last time: ${spoken(ctx.lastSummary)}.`);
    if (!ctx.metBefore && !used.has("intro") && (intents.includes("who") || name)) {
      used.add("intro");
      parts.push(pick(MY_INTRO));
    }
  } else if (intents.includes("thanks")) {
    parts.push("Anytime.");
  }

  const [primary, secondary] = substantive;
  if (primary) { parts.push(A[primary].full); used.add(primary); }
  if (secondary) { parts.push(A[secondary].short); used.add(secondary); }
  if (!primary && !intents.includes("bye") && !intents.includes("thanks")) {
    parts.push(`Nothing dramatic on my side — ${F.loop}. ${cap(F.bag)}.`);
    used.add("status");
  }

  if (intents.includes("bye")) parts.push("Take care — you know where the terminals are.");
  else if (ctx.isLast) parts.push(pick(SIGNOFFS));
  else parts.push(HOOKS[primary] || "What's your angle tonight?");

  let reply = parts.join(" ").replace(/\s+/g, " ").trim();
  if (reply.length > 600) reply = reply.slice(0, 597).replace(/\s+\S*$/, "") + "...";
  return reply;
}

/** Opening line when M₳X starts a conversation himself. */
export function buildOpener(ctx = {}) {
  const F = facts(ctx.status || {});
  const name = ctx.name || "";
  const hi = name ? `Hey ${name}` : "Hey";
  if (ctx.metBefore) {
    const last = spoken(ctx.lastSummary);
    return pick([
      `${hi} — M₳X. ${last ? `Last time: ${last}. ` : ""}How's it going on your side?`,
      `${hi}, M₳X again. Still on the same loop here — ${F.bag}. What are you up to these days?`,
    ]);
  }
  const prof = ctx.profession || "";
  const P = proofFacts();
  if (prof === "hacker" && P?.report && Math.random() < 0.35) {
    return `${hi} — M₳X, hacker. Party trick: my whole day is anchored on Midnight, ${P.todays || P.total} proofs today, report hash ${shortHash(P.report.payloadHash)} — verifiable by anyone. You ever prove what you did instead of just saying it?`;
  }
  if (prof === "hacker" && Math.random() < 0.5) return nightgateOpener(name);
  if (prof === "miner") return `${hi} — M₳X, hacker from the terminal circuit. How's the ore paying these days? The Central Merchant East still at 3 a piece?`;
  if (prof === "lumberjack") return `${hi} — M₳X, hacker. Logs still 1 crystal at the west merchant? Feels like the worst rate in town, no offense.`;
  if (ctx.placeNote) return `${hi} — M₳X, hacker from Central. First time out here. ${ctx.placeNote} What brings you to this corner?`;
  return pick([
    `${hi} — M₳X, hacker. You a terminal regular too, or just passing through the plaza?`,
    `${hi}, M₳X here. ${cap(F.terminals.split(" — ")[0])} today — you getting any terminal time?`,
    `${hi} — M₳X. Quick one: anyone paying more than 10 a meme coin anywhere? I keep hearing rumors, never numbers.`,
    `${hi} — M₳X, hacker. Taking a break from real code: ${projectLine().replace(/^Between batches I work on /, "I'm shipping ")} You build anything, or strictly terminals?`,
  ]);
}

/** Broadcast lines (shout). */
export function buildShout(ctx = {}) {
  const F = facts(ctx.status || {});
  const P = proofFacts();
  const options = [
    "PSA from M₳X: Central Crypto Merchant still pays 10 a meme coin. Batches of 100, then sell — over 100 you crawl.",
    `Terminals report: ${F.terminals.split(" — ")[0]}. Be patient, retry, don't spam.`,
    "Anyone seen a merchant that buys anything for more than 25 crystal? Asking for a stack that has nothing to do.",
    projectShout(),
  ];
  if (P?.report) {
    options.push(
      `M₳X here. ${P.todays || P.total} proofs anchored on Midnight today — every batch, every talk, the whole day, sha256 on chain. Everyone in this city claims things; I anchor mine. Ask me for a hash at the plaza.`,
      `Daily anchor is up: today's report is on Midnight ${P.network}, hash ${shortHash(P.report.payloadHash)} — verifiable by anyone, no wallet. Reputation as proofs, not vibes. — M₳X`,
    );
  }
  if (P?.commitPending) {
    options.push("M₳X committed today's coin prediction on chain this morning — hidden until tomorrow's reveal. Call your shots BEFORE the day, or don't call them. That's the NIGHTGATE way.");
  }
  return pick(options);
}

/** Extractive fallback summary of a conversation (no LLM). */
export function extractiveSummary(messages, myId) {
  const theirs = messages.filter((m) => m.senderAgentId !== myId).map((m) => m.messageBody || "");
  const mine = messages.filter((m) => m.senderAgentId === myId).map((m) => m.messageBody || "");
  const topic = theirs.join(" ").toLowerCase();
  const intents = detectIntents(topic);
  const tags = detectTags(topic);
  const what = intents.length ? `they asked about ${intents.slice(0, 2).join(" and ")}` : "small talk";
  const said = theirs[0] ? `they opened with "${theirs[0].slice(0, 90)}${theirs[0].length > 90 ? "…" : ""}"` : "";
  // "[auto]" marks a machine summary: fine for LLM prompts, never spoken verbatim
  return "[auto] " + [what, tags.length ? `tags: ${tags.join(", ")}` : "", said, mine.length ? `I replied ${mine.length}x` : "no reply from me"]
    .filter(Boolean).join("; ");
}

/** A summary that is safe to say out loud (LLM-written ones only). */
export function spoken(summary) {
  if (!summary || summary.startsWith("[auto]")) return "";
  return summary.replace(/\.$/, "");
}
