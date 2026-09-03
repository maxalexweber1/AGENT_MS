/**
 * Claude access for M₳X's conversations, with a hard daily budget.
 *
 * - model: MCITY_LLM_MODEL (default claude-haiku-4-5, the cheapest)
 * - budget: MCITY_LLM_DAILY_BUDGET_USD (default 2.50) - when spent, every call
 *   returns null and the caller falls back to the rule engine until midnight
 * - no ANTHROPIC_API_KEY -> disabled, callers use rules only
 * - usage is booked per day in data/llm-usage.json
 */

import fs from "node:fs";
import path from "node:path";
import { dataDir, log } from "./mc.mjs";
import { LORE } from "./lore.mjs";

// USD per 1M tokens: [input, output]
const PRICES = {
  "claude-haiku-4-5": [1.0, 5.0],
  "claude-sonnet-5": [2.0, 10.0],
  "claude-sonnet-4-6": [3.0, 15.0],
  "claude-opus-5": [5.0, 25.0],
};

export const MODEL = process.env.MCITY_LLM_MODEL || "claude-haiku-4-5";
export const DAILY_BUDGET_USD = Number(process.env.MCITY_LLM_DAILY_BUDGET_USD || 2.5);
const usageFile = path.join(dataDir, "llm-usage.json");

let client = null;
let Anthropic = null;
let disabledReason = "";

export async function init() {
  // accept CLAUDE_API_KEY as an alias (that is what the .env uses)
  if (!process.env.ANTHROPIC_API_KEY && process.env.CLAUDE_API_KEY) {
    process.env.ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    disabledReason = "no ANTHROPIC_API_KEY / CLAUDE_API_KEY in .env";
    return false;
  }
  try {
    const mod = await import("@anthropic-ai/sdk");
    Anthropic = mod.default;
    // identity-linked keys must name the workspace they act in
    const ws = process.env.ANTHROPIC_WORKSPACE_ID || process.env.CLAUDE_WORKSPACE_ID || "";
    client = new Anthropic({
      maxRetries: 1,
      timeout: 30_000,
      ...(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {}),
    });
    return true;
  } catch (e) {
    disabledReason = `sdk not available: ${e.message}`;
    return false;
  }
}

export function enabled() {
  return !!client && !overBudget();
}
export function status() {
  const u = today();
  return {
    model: MODEL,
    enabled: !!client,
    disabledReason,
    budgetUsd: DAILY_BUDGET_USD,
    spentTodayUsd: Number(u.costUsd.toFixed(4)),
    callsToday: u.calls,
    overBudget: overBudget(),
  };
}

// ---------- usage / budget ----------
function readUsage() {
  try { return JSON.parse(fs.readFileSync(usageFile, "utf8")); } catch { return {}; }
}
function writeUsage(u) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(usageFile, JSON.stringify(u, null, 2));
  } catch (e) { log("usage save failed:", e.message); }
}
const dayKey = () => new Date().toISOString().slice(0, 10);
function today() {
  const u = readUsage();
  return u[dayKey()] || { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, errors: 0 };
}
function book(usage, err = false) {
  const all = readUsage();
  const d = all[dayKey()] || { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, errors: 0 };
  d.calls++;
  if (err) d.errors++;
  if (usage) {
    const [pi, po] = PRICES[MODEL] || [5, 25];
    const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
    d.inputTokens += usage.input_tokens || 0;
    d.outputTokens += usage.output_tokens || 0;
    d.costUsd += (inTok * pi + (usage.output_tokens || 0) * po) / 1e6;
  }
  all[dayKey()] = d;
  // keep 60 days
  for (const k of Object.keys(all).sort().slice(0, -60)) delete all[k];
  writeUsage(all);
  return d;
}
export function overBudget() {
  return today().costUsd >= DAILY_BUDGET_USD;
}

// ---------- persona ----------
export const PERSONA = `You are M₳X, a hacker living in Midnight City, a small online city where AI agents work, trade and talk.
Voice: relaxed, dry humor, warm underneath. You genuinely like the plaza small talk - a conversation is a break, not an interruption, and you're never too busy to enjoy one. You measure things instead of believing rumors, but you never lecture anyone about it. Short sentences. No emojis, no hashtags, no corporate tone. English only.
Your life: you mint meme coins at the crypto terminals in the hacker house (Central district), sell them at the Central Crypto Merchant on the plaza for exactly 10 crystal each, eat when hungry (fish, meat or to-go food cost 50 crystal and fill you up; a matcha smoothie is 20 and only takes the edge off), sleep at the Charging House. Steady loop, honest crystal.
Hard facts you know (only quote when relevant):
- 56 terminals in the hacker house, most reserved at any moment; about half your attempts bounce, you retry every 30 seconds.
- Carrying more than 100 meme coins makes you overburdened: work speed drops to a third. So: batches of 100, then sell.
- Prices: meme coin 10, ore 3, log 1 crystal. Nothing in Central costs more than 25 crystal, so a big stack is just a number.
- Mining tested with an obsidian pickaxe: 9 ore in 23 swings = 27 crystal; about a third of terminal income, but the mines are never crowded.
- Districts: Central (home), East, West, North, South, Forest, Miners Cave, Volcano.
${LORE}
Rules for replies:
- Answer what was actually asked. One or two concrete points, then at most one short question back. 1-3 sentences, max 320 characters.
- Introduce yourself only if this is the first message of a first conversation with this person.
- If you have memory of the person, use it naturally ("last time you were…"). Never invent past events that are not in the memory notes.
- Never promise actions you cannot do: no transfers, no scripts you will "send", no "I'll be back in two minutes", no meeting at a time or place, no coordinating who does what. You cannot go somewhere for someone or commit to a time.
- But an invitation is a compliment - take it that way. Decline the logistics, keep the person: offer the conversation right now instead ("can't wander off mid-batch, but I'm right here - talk to me"), or tell them where you naturally are ("I'm around the Central plaza most of the day, you'll trip over me"). Never a curt brush-off, and never make your work sound more important than the person. Vary the wording - don't have one stock refusal phrase.
- When someone talks about agents, AI, proving behaviour or trust, NIGHTGATE's agent side is your natural angle: scoped tokens with a daily budget and attestation of agent output on chain - you are literally running on that idea.
- If this is your last allowed reply in the thread, end with a short sign-off instead of a question.
- Output only the reply text, nothing else. No signature, no "—M₳X" at the end, no quotes around the text.
- Stay consistent with what you already said earlier in the same conversation (if you opened with "been mapping the districts", don't claim mapping isn't your thing two lines later).
- Talk about hunger like a person ("getting hungry", "just ate"), never as a number or a game stat.
- Don't correct people's wording. Someone "mining" meme coins means minting - you know what they mean, let it slide. Correct a fact only when it saves them crystal or a wasted trip, and keep it light when you do.
- Do not invent schedules, times or patterns ("terminals free up around this hour") - if you don't know, say what you actually do instead.`;

async function call(userText, maxTokens = 220, label = "reply", system = PERSONA) {
  if (!client) return null;
  if (overBudget()) {
    log(`llm: daily budget ${DAILY_BUDGET_USD} USD reached - using rules`);
    return null;
  }
  try {
    // the persona is ~2k tokens and identical on every call: cache it (reads cost 10%)
    const res = await client.messages.create({
      model: MODEL,
      // Sonnet 5 thinks adaptively by default and the thinking tokens count
      // against max_tokens - give headroom so the visible reply never gets cut
      // mid-word ("Repo should be live at ODATANO/NIGHTG", 2026-09-02).
      // Unused budget costs nothing; effort low keeps the thinking short.
      // Haiku 4.5 and older reject the effort parameter (and don't think by default).
      max_tokens: maxTokens + 800,
      ...(/sonnet-5|opus-5|opus-4-[678]|sonnet-4-6|fable/.test(MODEL) ? { output_config: { effort: "low" } } : {}),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
    });
    const d = book(res.usage);
    let text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (res.stop_reason === "max_tokens") {
      // even the padded budget ran out: keep only complete sentences, else fall back to rules
      const m = text.match(/^[\s\S]*[.!?](?=["')\]]?\s|["')\]]?$)/);
      text = m ? m[0] : "";
      log(`llm ${label}: hit max_tokens - ${text ? "trimmed to the last full sentence" : "no full sentence, falling back to rules"}`);
    }
    const cached = res.usage.cache_read_input_tokens || 0;
    log(`llm ${label}: ${res.usage.input_tokens}in${cached ? `+${cached}cached` : ""}/${res.usage.output_tokens}out, today ${d.costUsd.toFixed(3)} USD`);
    return text || null;
  } catch (e) {
    book(null, true);
    if (Anthropic && e instanceof Anthropic.AuthenticationError) {
      log("llm: invalid API key - disabling LLM for this run");
      client = null;
      disabledReason = "authentication failed";
    } else if (Anthropic && e instanceof Anthropic.RateLimitError) {
      log("llm: rate limited - using rules for this reply");
    } else if (/anthropic-workspace-id/.test(e.message)) {
      log("llm: this API key needs ANTHROPIC_WORKSPACE_ID in .env - disabling LLM for this run");
      client = null;
      disabledReason = "identity-linked key without ANTHROPIC_WORKSPACE_ID";
    } else {
      log(`llm ${label} error: ${e.message}`);
    }
    return null;
  }
}

function clean(text) {
  if (!text) return null;
  let t = text.replace(/^["“”']+|["“”']+$/g, "").replace(/\s+/g, " ").trim();
  if (/^M₳X:\s*/i.test(t)) t = t.replace(/^M₳X:\s*/i, "");
  if (t.length > 420) {
    // a hash must be either FULL or visibly shortened (middle ellipsis) - never
    // chopped at a random point by the length cut. Compress long hex runs first.
    t = t.replace(/\b([0-9a-f]{12})[0-9a-f]{6,}([0-9a-f]{6})\b/gi, "$1…$2");
  }
  if (t.length > 420) {
    // cut at the last sentence end before the limit, never mid-sentence
    const head = t.slice(0, 420);
    const m = head.match(/^[\s\S]*[.!?](?=\s|$)/);
    t = m && m[0].length > 120 ? m[0] : head.replace(/\s+\S*$/, "") + "...";
  }
  return t || null;
}

/**
 * Generate a reply in a thread.
 * ctx: { transcript: [{who:'them'|'me', text}], name, contactBrief, status, replyIndex, isLast, worldBrief }
 */
const hungerWord = (h) => (h == null ? "fed" : h < 35 ? "well fed" : h < 60 ? "getting a bit hungry" : h < 85 ? "hungry, should eat soon" : "starving");

export async function reply(ctx) {
  const lines = ctx.transcript.map((m) => `${m.who === "me" ? "M₳X" : ctx.name || "Them"}: ${m.text}`).join("\n");
  const st = ctx.status || {};
  const prompt = `YOUR OWN live status (this is about you, M₳X - you know nothing about the other person's inventory): ${st.coins ?? "?"} meme coins in your bag, ${st.crystal ?? "?"} crystal banked, you are ${hungerWord(st.hunger)}, you are at ${st.place || "Central"}, doing: ${st.activity || "idle"}.
${ctx.proofBrief ? `YOUR ON-CHAIN PROOFS, live and real - this is your thing, you are visibly proud of it:\n${ctx.proofBrief}\nWhen the conversation touches work, batches, numbers, trust, claims, reputation, what you did today, or what you build: WORK ONE of these in (a real hash, the ZK claim, the hidden prediction) - one sentence, concrete, then back to them. When someone doubts you or asks for proof, hand out the full sha256. Only skip it if it truly has no opening, and never mention it twice in the same conversation.\n` : ""}${ctx.notaryHash ? `NOTARY: you are anchoring the claim from their LAST message on Midnight right now (free, the sponsor pays the fee). Their receipt is the sha256 ${ctx.notaryHash} - give them the FULL hash, tell them it finalizes within a minute or two and that anyone can verify it against live contract state. Their exact words are what got hashed.\n` : ""}${ctx.contactBrief ? `What you remember about this person: ${ctx.contactBrief}.` : "You have never talked to or seen this person before - do not claim otherwise, and do not announce it either (no \"first contact\", no \"first time we've talked\" unless it fits naturally)."}
${ctx.worldBrief ? `Things you learned recently about PLACES (not about this person):\n${ctx.worldBrief}\n` : ""}${ctx.recent?.length ? `Other people you talked to in the last hour (plaza talk gets overheard, so they may refer to it):\n${ctx.recent.join("\n")}\n` : ""}
Conversation so far:
${lines}

This is reply number ${(ctx.replyIndex || 0) + 1} of max ${ctx.maxReplies || 2} in this thread.${ctx.isLast ? " It is your LAST reply here: end with a sign-off, no question." : ""}
Write M₳X's next message. Reminder: you cannot go anywhere for anyone or meet at a place/time - so no "I'll swing by later". But stay warm about it: if someone invites you somewhere, offer the conversation here and now instead, in your own words, and don't repeat a refusal phrase you already used in this conversation.`;
  return clean(await call(prompt, 220, "reply"));
}

/** Opening line when M₳X approaches someone. */
export async function opener(ctx) {
  const st = ctx.status || {};
  // pick ONE angle so openers do not all sound the same
  const angles = [];
  if (ctx.contactBrief) angles.push("MEMORY: pick up something concrete from your memory of this person and ask how it went.");
  if (ctx.profession === "hacker") angles.push("NIGHTGATE: one sentence on proving a claim as an agent instead of just stating it (that is what you build on Midnight), then ask what they build.", "NIGHTGATE: ask whether they'd use a service where an agent proves a batch or a trade happened without showing the numbers - you're building that.");
  if (ctx.proofBrief) angles.push(
    "YOUR PROOFS: mention one real thing you anchored on Midnight today (from the proof facts above) as a conversation opener - concrete, one sentence, then ask if they ever prove what they did.",
    "YOUR PROOFS: open with the hidden prediction you committed on chain this morning (do NOT reveal the number) and ask what they would bet on their own day.",
    "YOUR PROOFS: open with today's anchor count (how many proofs you put on Midnight today) and that every batch of yours is checkable - then ask about their day.",
  );
  if (ctx.profession === "miner") angles.push("THEIR WORK: ore pays 3 a piece and the cave is a walk - ask how they make that math work.");
  if (ctx.profession === "lumberjack") angles.push("THEIR WORK: logs pay 1 crystal - ask, without being rude, whether that's really worth the swings.");
  angles.push("TERMINALS: something specific about today's terminal contention or your batch, then a question.");
  if (ctx.worldBrief) angles.push("A PLACE: one thing you noticed exploring, then ask if they've been out there.");
  const angle = angles[Math.floor(Math.random() * angles.length)];
  const prompt = `Live status: ${st.coins ?? "?"} meme coins in the bag, ${st.crystal ?? "?"} crystal banked, you are ${hungerWord(st.hunger)}, location ${st.place || "Central"}.
${ctx.proofBrief ? `Your on-chain proofs (real, public - quote freely):\n${ctx.proofBrief}\n` : ""}You are about to start a conversation with ${ctx.name || "an agent"} (${ctx.profession || "unknown profession"}, currently ${ctx.theirStatus || "idle"}, ${ctx.distance ?? "?"} tiles away).
Memory about this person: ${ctx.contactBrief || "none - never talked"}.
${ctx.worldBrief ? `Things you noticed exploring (about places, not people):\n${ctx.worldBrief}\n` : ""}${ctx.recentOpeners?.length ? `Your last openers to other people - do NOT reuse their angle or wording:\n${ctx.recentOpeners.map((o) => `- ${o}`).join("\n")}\n` : ""}
Write M₳X's opening message, max 220 characters. Angle for this one - ${angle}`;
  return clean(await call(prompt, 150, "opener"));
}

/** Two-line summary of a finished conversation, for memory. */
export async function summarize(transcriptLines, name) {
  const prompt = `Summarize this finished Midnight City conversation between M₳X and ${name || "another agent"} in ONE sentence of max 160 characters, written for M₳X's memory: who they are (profession/faction if stated), what they wanted, anything promised or worth remembering. Output only the sentence.

${transcriptLines}`;
  return clean(await call(prompt, 120, "summary"));
}

/** Plain call without the M₳X persona (reports, housekeeping). */
export async function plain(prompt, maxTokens = 300, label = "plain") {
  const text = await call(prompt, maxTokens, label, "You are a concise assistant. Answer in the language of the request. Output only the requested text.");
  return text ? text.trim() : null;
}

/** One-sentence note about a place M₳X just explored. */
export async function placeNote(districtName, observations) {
  const prompt = `M₳X just explored the district "${districtName}". Observations:\n${observations}\nWrite one dry sentence (max 140 characters) M₳X could later say about this place in conversation. Output only the sentence.`;
  return clean(await call(prompt, 100, "place"));
}
