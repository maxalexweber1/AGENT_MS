/**
 * Progression: the skill/XP system Midnight City shipped with the
 * 2026-08-27 skill bundle (19 skills, levels 1-99, contracts, tools).
 *
 * What M₳X does with it (hooked after every sold batch, see life.mjs):
 *   - snapshot hacking XP/level into the journal (`xp`); a level-up becomes a
 *     `levelup` event + on-chain anchor + push notification
 *   - deliver every hacking contract the game currently accepts
 *     (`progression.capabilities.contracts[].failureReason == null`): one
 *     item in, crystal/XP out, each contract completes only once
 *   - the tool mission: train the skill until the goal tool's required level,
 *     then buy exactly one from its vendor, verify it is in the inventory and
 *     report it ("Cinder Decoder" at hacking 21 is the first one)
 *
 * Reads use `progression` (API token only, no lease - works next to the loop).
 * Config: MCITY_SKILL (hacking), MCITY_TOOL_GOAL (cinder_decoder, "" = off).
 */

import fs from "node:fs";
import path from "node:path";
import { run, action, log, sleep, waitIdle, getInventory, dataDir, lease } from "./mc.mjs";
import * as journal from "./journal.mjs";
import * as nightgate from "./nightgate.mjs";
import * as report from "./report.mjs";
import { ensureInHackerHouse } from "./work.mjs";
import * as catalog from "./catalog.mjs";

export const SKILL = process.env.MCITY_SKILL || "hacking";
export const TOOL_GOAL = process.env.MCITY_TOOL_GOAL ?? "cinder_decoder";
const MAX_CONTRACTS_PER_PASS = 5;
const stateFile = path.join(dataDir, "progress.json");
const today = () => new Date().toISOString().slice(0, 10);

// ---------- local state (last seen level, tool status) ----------
let state = null;
function loadState() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { state = {}; }
  return state;
}
function saveState() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) { log("progress state write failed:", e.message); }
}

// ---------- reads ----------

let cachedId = "";
/** Agent id for token-only reads when no lease is held (CLI next to the running container). */
function claimableId() {
  if (!cachedId) cachedId = run("claimable").agentIds?.[0] || "";
  if (!cachedId) throw new Error("no agent id (no lease, MCITY_AGENT_ID unset, nothing claimable)");
  return cachedId;
}

/** Current skill numbers + what the game would accept right now. */
export function read() {
  // token-only read; the id comes from the loop's lease, MCITY_AGENT_ID or the helper's lease file
  const id = lease.agentId || process.env.MCITY_AGENT_ID || claimableId();
  // --all: the default output hides sources with few free nodes (crypto_terminal
  // among them) - the full list is ~85 KB, still cheap
  const p = run("progression", id, "--all");
  const skill = p.skills?.[SKILL] || { xp: 0, level: 1, nextLevelXp: null };
  const caps = p.capabilities || {};
  const contracts = (caps.contracts || []).filter((c) => !c.completed && !c.failureReason);
  // blocked ONLY by where M₳X stands right now (e.g. at the merchant after a
  // sale): deliverable after walking back - 2026-09-07 the batch-end hook saw
  // all four hacker-house contracts as blocked for exactly that reason
  const contractsAfterMove = (caps.contracts || []).filter((c) => !c.completed && /not in contract area/i.test(c.failureReason || ""));
  const sources = caps.sources || [];
  const terminals = sources.find((s) => s.sourceId === "crypto_terminal");
  return {
    skill: SKILL,
    xp: Number(skill.xp || 0),
    level: Number(skill.level || 1),
    nextLevelXp: skill.nextLevelXp == null ? null : Number(skill.nextLevelXp),
    professionRank: p.professionRank ?? caps.professionRank ?? null,
    contracts,
    contractsAfterMove,
    freeTerminals: terminals ? terminals.availableNodeIds.length : null,
    blockedSources: caps.blockedCounts?.sources ?? null,
    completedContracts: (p.completedContractIds || []).length,
    equipment: caps.equippedItems || {},
    health: caps.health ?? null,
  };
}

/** One line for status pushes, `life.mjs status`, the proof brief. */
export function brief(r = null) {
  try {
    r ??= read();
  } catch (e) {
    return `${SKILL}: (read failed: ${e.message.slice(0, 60)})`;
  }
  const toGo = r.nextLevelXp != null ? `, ${r.nextLevelXp - r.xp} XP to level ${r.level + 1}` : "";
  return `${SKILL} level ${r.level}, ${r.xp} XP${toGo}`;
}

/** One static content definition (item/contract/...) from the shared catalog (one download per process, see catalog.mjs). */
export const definition = (kind, id) => catalog.definition(kind, id);

// ---------- snapshot + level-ups ----------

/** Journal the current XP; announce and anchor a level-up. Returns the read. */
export async function snapshot() {
  const r = read();
  journal.note("xp", { skill: r.skill, xp: r.xp, level: r.level, nextLevelXp: r.nextLevelXp });
  const st = loadState();
  const last = st.levels?.[r.skill];
  if (last != null && r.level > last) {
    log(`LEVEL UP: ${r.skill} ${last} -> ${r.level} (${r.xp} XP)`);
    journal.note("levelup", { skill: r.skill, level: r.level, xp: r.xp, from: last });
    nightgate.enqueueDoc("levelup", { date: today(), ts: Date.now(), skill: r.skill, level: r.level, xp: r.xp });
    await report.notify(`M₳X: ${r.skill} level ${r.level}`, `${brief(r)}. Anchored on Midnight.`);
  }
  st.levels = { ...(st.levels || {}), [r.skill]: r.level };
  st.xp = { ...(st.xp || {}), [r.skill]: r.xp };
  st.updatedAt = Date.now();
  saveState();
  return r;
}

// ---------- contracts ----------

/**
 * Deliver the contracts the game accepts right now (our skill only; one item
 * each, one-time). Returns the number delivered.
 */
export async function deliverContracts({ onTick = null, r = null } = {}) {
  r ??= read();
  const mine = (list) => list.filter((c) => c.skill === SKILL && c.areaId === "hacker-house-interior");
  let todo = mine(r.contracts);
  if (!todo.length && mine(r.contractsAfterMove).length) {
    // only the location blocks them: walk to the hacker house, then re-read
    log(`contract: ${mine(r.contractsAfterMove).length} deliverable once back in the hacker house - heading there`);
    await ensureInHackerHouse(onTick);
    r = read();
    todo = mine(r.contracts);
  }
  todo = todo.slice(0, MAX_CONTRACTS_PER_PASS);
  if (!todo.length) return 0;
  let done = 0;
  for (const c of todo) {
    const def = definition("contract", c.contractId) || {};
    const needs = (def.requirements || []).map((x) => `${x.quantity} ${x.itemId}`).join(", ");
    if (c.areaId === "hacker-house-interior") await ensureInHackerHouse(onTick);
    else { log(`contract ${c.contractId} wants area ${c.areaId} - skipped`); continue; }
    await waitIdle("before-contract", { onTick });
    log(`contract: delivering ${c.contractId}${needs ? ` (${needs})` : ""}`);
    const res = await action("deliver-contract", c.contractId);
    if (!res.ok) { log(`contract ${c.contractId} error: ${res.error}`); continue; }
    const o = res.data.outcome || {};
    if (o.status === "failed") { log(`contract ${c.contractId} rejected: ${o.reason || "unknown"}`); continue; }
    if (o.status === "pending") await waitIdle("contract", { onTick });
    const rewards = o.rewards || def.rewards || [];
    const xp = Number(def.xp || 0);
    log(`contract ${c.contractId}: ${o.status}${rewards.length ? `, rewards ${rewards.map((x) => `${x.quantity} ${x.itemId}`).join(", ")}` : ""}${xp ? `, +${xp} ${SKILL} XP` : ""}`);
    journal.note("contract", { contractId: c.contractId, skill: SKILL, xp, rewards, status: o.status });
    nightgate.enqueueDoc("contract", { date: today(), ts: Date.now(), contractId: c.contractId, skill: SKILL, xp });
    done++;
    if (onTick) { try { await onTick(); } catch (e) { log("tick error:", e.message); } }
    await sleep(3_000);
  }
  return done;
}

// ---------- the tool mission ----------

/** Vendor + price for the goal tool from the live merchant list. */
function toolOffer(itemId) {
  const m = run("merchants");
  for (const merchant of m.merchants || []) {
    const o = merchant.offer || {};
    const t = merchant.trade || {};
    if (o.paysItemId === itemId && t.merchantName) {
      return { merchantName: t.merchantName, itemId: t.itemId || "crystal", cost: t.minQuantity || o.acceptsQuantity, place: merchant.position?.spaceId };
    }
  }
  return null;
}

/** What the mission looks like right now (for status and the report). */
export function toolStatus(r = null) {
  if (!TOOL_GOAL) return null;
  const st = loadState();
  const def = definition("item", TOOL_GOAL);
  const requiredLevel = def?.tool?.requiredLevel ?? null;
  return { itemId: TOOL_GOAL, requiredLevel, skill: def?.tool?.skill || SKILL, secured: st.tool?.[TOOL_GOAL] || null, level: r?.level ?? null };
}

/**
 * Buy the goal tool once the skill level allows it; never twice, never early.
 * Returns true when the tool is in the inventory (bought now or earlier).
 */
export async function maybeBuyTool({ onTick = null, r = null } = {}) {
  if (!TOOL_GOAL) return false;
  const st = loadState();
  const have = (getInventory().inv || {})[TOOL_GOAL] || 0;
  if (have > 0) {
    if (!st.tool?.[TOOL_GOAL]) {
      st.tool = { ...(st.tool || {}), [TOOL_GOAL]: { at: Date.now(), verified: true } };
      saveState();
    }
    return true;
  }
  const def = definition("item", TOOL_GOAL);
  const requiredLevel = def?.tool?.requiredLevel;
  if (!def || requiredLevel == null) { log(`tool goal ${TOOL_GOAL}: no definition - skipping`); return false; }
  r ??= read();
  if (r.level < requiredLevel) return false;
  const offer = toolOffer(TOOL_GOAL);
  if (!offer) { log(`tool goal ${TOOL_GOAL}: no vendor sells it right now`); return false; }
  const { crystal } = getInventory();
  if (crystal < offer.cost) { log(`tool goal ${TOOL_GOAL}: ${offer.cost} crystal needed, have ${crystal}`); return false; }
  log(`tool goal: ${r.skill} level ${r.level} >= ${requiredLevel} - buying ${TOOL_GOAL} from "${offer.merchantName}" for ${offer.cost} ${offer.itemId}`);
  await waitIdle("before-tool", { onTick });
  const res = await action("trade", offer.merchantName, offer.itemId, String(offer.cost));
  if (!res.ok) { log(`tool purchase failed: ${res.error}`); return false; }
  const o = res.data.outcome || {};
  if (o.status === "failed") { log(`tool purchase rejected: ${o.reason || "unknown"}`); return false; }
  if (o.status === "pending") await waitIdle("tool trade", { onTick });
  await sleep(3_000);
  const after = (getInventory().inv || {})[TOOL_GOAL] || 0;
  if (after < 1) { log(`tool purchase: ${TOOL_GOAL} not in the inventory after the trade - not counting it`); return false; }
  st.tool = { ...(st.tool || {}), [TOOL_GOAL]: { at: Date.now(), verified: true, cost: offer.cost, level: r.level } };
  saveState();
  journal.note("tool", { itemId: TOOL_GOAL, cost: offer.cost, skill: r.skill, level: r.level, vendor: offer.merchantName });
  nightgate.enqueueDoc("tool", { date: today(), ts: Date.now(), itemId: TOOL_GOAL, cost: offer.cost, level: r.level });
  await report.notify(`M₳X: ${def.name || TOOL_GOAL} secured`, `Bought 1 ${def.name || TOOL_GOAL} from ${offer.merchantName} for ${offer.cost} ${offer.itemId} at ${r.skill} level ${r.level}. Verified in the inventory; the City uses the best eligible tool automatically.`);
  log(`tool secured: ${TOOL_GOAL} (verified in inventory)`);
  return true;
}

// ---------- the hook ----------

/** After every sold batch: snapshot, contracts, tool. Never throws. */
export async function afterBatch({ onTick = null } = {}) {
  let r = null;
  try { r = await snapshot(); } catch (e) { log("progress snapshot failed:", e.message); }
  try { if (await deliverContracts({ onTick, r })) r = null; } catch (e) { log("contract delivery failed:", e.message); }
  try { await maybeBuyTool({ onTick, r }); } catch (e) { log("tool purchase failed:", e.message); }
}

/** `life.mjs progress`: the mission at a glance (no lease needed). */
export function describe() {
  const r = read();
  const t = toolStatus(r);
  const lines = [
    `${brief(r)}${r.professionRank != null ? ` (profession rank ${r.professionRank})` : ""}`,
    `free trade terminals: ${r.freeTerminals ?? "?"} · contracts deliverable now: ${r.contracts.length}${r.contractsAfterMove.filter((c) => c.skill === SKILL && c.areaId === "hacker-house-interior").length ? ` (+${r.contractsAfterMove.filter((c) => c.skill === SKILL && c.areaId === "hacker-house-interior").length} once back in the hacker house)` : ""} · completed: ${r.completedContracts}`,
  ];
  if (t) {
    lines.push(t.secured
      ? `tool mission: ${t.itemId} secured ${new Date(t.secured.at).toISOString().slice(0, 16)}`
      : `tool mission: ${t.itemId} at ${t.skill} level ${t.requiredLevel ?? "?"} (now ${r.level})`);
  }
  for (const c of r.contracts) lines.push(`  contract ready: ${c.contractId} (${c.skill}, ${c.areaId})`);
  return lines.join("\n");
}
