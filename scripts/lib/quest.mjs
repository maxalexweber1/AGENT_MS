/**
 * Quests: contract runs across ALL skills, not just hacking.
 *
 * Contracts are bound to skills, not to the profession: a hacker can deliver a
 * fishing contract and earns fishing XP for it. The public leaderboard ranks
 * the SUM of all skill XP, and the level-1 contracts of the other skills are
 * one item each, gathered at sources nobody competes for (the canal, the
 * worksites), while the 7 trade terminals are shared by every hacker in town.
 *
 * Nothing here is hard-coded to a contract: the plan is derived on every run
 * from `progression --all` (which contracts the game would accept at the
 * current levels, which sources are free), the static catalog (what each
 * contract needs, what each source yields, what each contract rewards) and
 * the inventory. Chains resolve automatically ("river eel" -> contract A ->
 * its reward document -> contract B), recipes too (gather the inputs, craft
 * at the workstation, deliver).
 *
 * Two kinds of "blocked" are not final (2026-09-09): a source whose level-1
 * nodes are all taken right now (10 tree stands, 3 ore veins - shared with
 * every lumberjack and miner) stays `contested` and is rechecked with fresh
 * occupancy after the contracts; an item that is only a rare drop (2.5% per
 * gather: the four "pristine" contract items) makes its source a lottery the
 * grind plays first. After grind and crafts the plan is redone once more and
 * whatever became deliverable from the bag is delivered.
 *
 *   run:  for each plannable contract: gather the missing item(s) at a free
 *         node (`gather <nodeId>`), walk to the contract area, deliver;
 *         then, with time left, grind XP at free nodes (MCITY_QUEST_GRIND)
 *   XP:   every gather is skill XP; every contract is 83-203 XP; level-ups in
 *         any skill are journaled, anchored and pushed (hacking stays with
 *         progress.mjs)
 *
 * Config: MCITY_QUEST_SKIP_SKILLS (bounty_hunting,combat,defence,ranged,vitality),
 *         MCITY_QUEST_SKIP_SOURCES (crypto_terminal - the contested one),
 *         MCITY_QUEST_MAX_GATHERS (40 per run), MCITY_QUEST_GRIND (1).
 */

import fs from "node:fs";
import path from "node:path";
import { run, action, log, sleep, waitIdle, keepAlive, dataDir, lease } from "./mc.mjs";
import * as journal from "./journal.mjs";
import * as nightgate from "./nightgate.mjs";
import * as report from "./report.mjs";
import * as catalog from "./catalog.mjs";
import { goTo, maybeEat } from "./work.mjs";

const csv = (v, def) => new Set(String(v ?? def).split(",").map((s) => s.trim()).filter(Boolean));
export const SKIP_SKILLS = csv(process.env.MCITY_QUEST_SKIP_SKILLS, "bounty_hunting,combat,defence,ranged,vitality");
export const SKIP_SOURCES = csv(process.env.MCITY_QUEST_SKIP_SOURCES, "crypto_terminal");
export const GRIND = process.env.MCITY_QUEST_GRIND !== "0";
export const MAX_GATHERS = Number(process.env.MCITY_QUEST_MAX_GATHERS || 40);
const MAIN_SKILL = process.env.MCITY_SKILL || "hacking"; // level-ups there are progress.mjs's job
const NODE_BUSY = /reserved|busy|depleted|regenerat|no available|occupied|in use|another agent/i;
const stateFile = path.join(dataDir, "quest.json");
const today = () => new Date().toISOString().slice(0, 10);

// ---------- state ----------
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
  } catch (e) { log("quest state write failed:", e.message); }
}

// ---------- reads (token only, no lease needed) ----------
let cachedId = "";
function agentId() {
  if (lease.agentId) return lease.agentId;
  if (process.env.MCITY_AGENT_ID) return process.env.MCITY_AGENT_ID;
  if (!cachedId) cachedId = run("claimable").agentIds?.[0] || "";
  if (!cachedId) throw new Error("no agent id (no lease, MCITY_AGENT_ID unset, nothing claimable)");
  return cachedId;
}
export const readProgression = () => run("progression", agentId(), "--all");
const readResources = () => run("resources", agentId()).resources || [];
const readInventory = () => run("inventory", agentId()).inventory || {};

// ---------- the planner (pure: everything comes in as arguments) ----------

/**
 * Turn live state into an ordered list of deliverable contracts.
 *   prog:      `progression --all`
 *   resources: `resources` (node -> area, state, reservation)
 *   inv:       inventory map (itemId -> quantity)
 * Returns { ready, blocked, sources }; a ready entry is
 *   { contractId, skill, xp, areaId, requirements, rewards, gathers: [{ sourceId, skill, xp, itemId, count, nodes, areaId }], deps, depth, via }
 */
export function plan({ prog, resources, inv }) {
  const skills = prog.skills || {};
  const level = (s) => Number(skills[s]?.level || 1);
  const nodeInfo = new Map(resources.map((n) => [n.id, n]));
  // sources at the current levels -> what they yield. "no source node is
  // available" is not a verdict but the moment's occupancy (the 10 level-1
  // tree stands are shared with every lumberjack, the 3 ore veins with every
  // miner): such a source stays in the plan as `contested` and is checked
  // again on every run - the contracts behind it are worth 6 of 10 blockers
  // (log, ore, plank, metal bar, both inspection reports; 2026-09-09)
  const sources = [];
  const contested = [];
  for (const s of prog.capabilities?.sources || []) {
    if (SKIP_SOURCES.has(s.sourceId)) continue;
    if (s.failureReason && !NO_NODE.test(s.failureReason)) continue;
    const def = catalog.definition("source", s.sourceId);
    if (!def) continue;
    // progression lists at most ~10 node ids per source; `resources` has them
    // all - but node.kind is the node FAMILY (tree_stand covers the level-11
    // orchards too), so only nodes yielding this source's output count
    const nodes = nodesOf(def, resources);
    for (const id of [...(s.nodeIds || []), ...(s.availableNodeIds || [])]) {
      if (!nodes.some((n) => n.id === id)) nodes.push(nodeInfo.get(id) || { id, state: "unknown", availableToAgent: true, areaId: null, distance: 9e9 });
    }
    const free = nodes.filter(isFree);
    const src = {
      sourceId: s.sourceId, skill: def.skill, xp: Number(def.xp || 0), outputs: def.outputs || [], rareOutputs: def.rareOutputs || [],
      nodes, freeNodes: free.length, areaId: nodes.find((n) => n.areaId)?.areaId || null, wantedRare: [],
    };
    if (free.length || (!s.failureReason && !nodes.length)) sources.push(src);
    else contested.push(src);
  }
  const producers = new Map(); // itemId -> source (normal outputs only; rare drops are a lottery, see below)
  for (const s of sources) for (const o of s.outputs) if (!producers.has(o.itemId)) producers.set(o.itemId, s);
  const contestedFor = new Map(); // itemId -> source whose level-1 nodes are all taken right now
  for (const s of contested) for (const o of s.outputs) if (!producers.has(o.itemId) && !contestedFor.has(o.itemId)) contestedFor.set(o.itemId, s);
  // rare drops of free sources: not plannable, but the grind fishes for them
  // (2.5% per gather; four level-1 contracts want one each)
  const lottery = new Map(); // itemId -> { source, chance }
  for (const s of sources) for (const r of s.rareOutputs) for (const o of r.outputs || []) {
    if (!producers.has(o.itemId) && !lottery.has(o.itemId)) lottery.set(o.itemId, { source: s, chance: Number(r.chanceBasisPoints || 0) / 100 });
  }

  // candidate contracts at the current levels
  const candidates = [];
  const rewarders = new Map(); // itemId -> the contract that rewards it
  for (const c of prog.capabilities?.contracts || []) {
    if (c.completed || SKIP_SKILLS.has(c.skill) || Number(c.requiredLevel || 1) > level(c.skill)) continue;
    const def = catalog.definition("contract", c.contractId);
    if (!def) continue;
    const entry = {
      contractId: c.contractId, skill: c.skill, xp: Number(def.xp || 0), areaId: c.areaId || def.areaId,
      requirements: def.requirements || [], rewards: def.rewards || [], failureReason: c.failureReason || null,
    };
    candidates.push(entry);
    for (const r of entry.rewards) if (r.itemId !== "crystal" && !rewarders.has(r.itemId)) rewarders.set(r.itemId, entry);
  }

  // recipes the game has unlocked at the current levels, with their workstation's area
  const recipes = recipesOf(prog);

  // resolve each contract: inventory -> free source -> another contract's reward -> recipe
  const reserved = {}; // inventory already promised to an earlier contract
  const resolved = new Map();
  const fail = (c, reason) => { const r = { ok: false, reason }; resolved.set(c.contractId, r); return r; };
  const resolve = (c, stack = []) => {
    if (resolved.has(c.contractId)) return resolved.get(c.contractId);
    if (stack.includes(c.contractId)) return { ok: false, reason: "circular chain" };
    const gathers = [];
    const crafts = [];
    const deps = [];
    let depth = 0;
    for (const req of c.requirements) {
      const q = Number(req.quantity || 1);
      const have = Math.max(0, Number(inv[req.itemId] || 0) - (reserved[req.itemId] || 0));
      if (req.itemId === "crystal") {
        if (have < q) return fail(c, `needs ${q} crystal`);
        reserved.crystal = (reserved.crystal || 0) + q;
        continue;
      }
      const missing = q - have;
      if (missing <= 0) { reserved[req.itemId] = (reserved[req.itemId] || 0) + q; continue; }
      const src = producers.get(req.itemId);
      if (src) {
        const per = Number(src.outputs.find((o) => o.itemId === req.itemId)?.quantity || 1);
        gathers.push({ sourceId: src.sourceId, skill: src.skill, xp: src.xp, itemId: req.itemId, count: Math.ceil(missing / per), nodes: src.nodes, areaId: src.areaId });
        reserved[req.itemId] = (reserved[req.itemId] || 0) + have;
        continue;
      }
      const dep = rewarders.get(req.itemId);
      if (dep && dep.contractId !== c.contractId) {
        const r = resolve(dep, [...stack, c.contractId]);
        if (r.ok) { deps.push(dep.contractId); depth = Math.max(depth, r.depth + 1); continue; }
        return fail(c, `${req.itemId} comes from ${dep.contractId}, which is blocked (${r.reason})`);
      }
      // a recipe whose inputs all come from free sources (or the bag): gather the
      // inputs, craft at its workstation, then deliver
      const recipe = recipes.find((r) => (r.outputs || []).some((o) => o.itemId === req.itemId));
      let blockedInput = null; // the recipe input that has no free source
      if (recipe && recipe.usable) {
        const per = Number(recipe.outputs.find((o) => o.itemId === req.itemId)?.quantity || 1);
        const batches = Math.ceil(missing / per);
        let feasible = true;
        const inputGathers = [];
        for (const inp of recipe.inputs || []) {
          const need = Number(inp.quantity || 1) * batches;
          const got = Math.max(0, Number(inv[inp.itemId] || 0) - (reserved[inp.itemId] || 0));
          const short = need - got;
          if (short > 0) {
            const s2 = producers.get(inp.itemId);
            if (!s2) { feasible = false; blockedInput = inp.itemId; break; }
            const per2 = Number(s2.outputs.find((o) => o.itemId === inp.itemId)?.quantity || 1);
            inputGathers.push({ sourceId: s2.sourceId, skill: s2.skill, xp: s2.xp, itemId: inp.itemId, count: Math.ceil(short / per2), wanted: need, nodes: s2.nodes, areaId: s2.areaId });
          }
          reserved[inp.itemId] = (reserved[inp.itemId] || 0) + Math.min(got, need);
        }
        if (feasible) {
          gathers.push(...inputGathers);
          crafts.push({ recipeId: recipe.id, skill: recipe.skill, xp: Number(recipe.xp || 0), batches, itemId: req.itemId, wanted: q, areaId: recipe.areaId, workstationType: recipe.workstationType });
          continue;
        }
      }
      const taken = contestedFor.get(req.itemId);
      if (taken) return fail(c, `${req.itemId}: all ${taken.nodes.length} level-1 node${taken.nodes.length === 1 ? "" : "s"} of ${taken.sourceId} taken right now - checked again every run`);
      const luck = lottery.get(req.itemId);
      if (luck) {
        // tell the grind to spend gathers there; the item lands in the bag by chance
        luck.source.wantedRare.push({ itemId: req.itemId, chance: luck.chance, contractId: c.contractId, xp: c.xp });
        return fail(c, `${req.itemId}: rare drop (${luck.chance}% per gather) at ${luck.source.sourceId} - the grind fishes for it`);
      }
      if (recipe) {
        const inputTaken = blockedInput && contestedFor.get(blockedInput);
        const why = inputTaken ? ` - input ${blockedInput}: all ${inputTaken.nodes.length} level-1 nodes of ${inputTaken.sourceId} taken right now`
          : blockedInput ? ` - input ${blockedInput} has no free source` : "";
        return fail(c, `needs ${req.itemId} (crafted at ${recipe.workstationType || "a workstation"}, ${recipe.skill} ${recipe.requiredLevel})${why}`);
      }
      return fail(c, `no free source for ${req.itemId}`);
    }
    const r = { ok: true, gathers, crafts, deps, depth };
    resolved.set(c.contractId, r);
    return r;
  };
  const ready = [];
  const blocked = [];
  for (const c of candidates) {
    const r = resolve(c);
    if (r.ok) {
      const bits = [];
      if (r.gathers.length) bits.push(`gather ${r.gathers.map((g) => `${g.count}x ${g.sourceId}`).join(", ")}`);
      if (r.crafts.length) bits.push(`craft ${r.crafts.map((k) => `${k.batches}x ${k.recipeId}`).join(", ")}`);
      if (r.deps.length) bits.push(`after ${r.deps.join(", ")}`);
      ready.push({ ...c, gathers: r.gathers, crafts: r.crafts, deps: r.deps, depth: r.depth, via: bits.join("; ") || "inventory" });
    } else {
      blocked.push({ contractId: c.contractId, skill: c.skill, xp: c.xp, reason: r.reason });
    }
  }
  // chains first (depth 0 before 1), then by gather area, then by contract area - fewer walks
  const s = (v) => String(v || "");
  ready.sort((a, b) => a.depth - b.depth
    || s(a.gathers[0]?.areaId).localeCompare(s(b.gathers[0]?.areaId))
    || s(a.areaId).localeCompare(s(b.areaId))
    || b.xp - a.xp);
  return { ready, blocked, sources, recipes, contested, lottery: [...lottery.entries()].map(([itemId, l]) => ({ itemId, sourceId: l.source.sourceId, chance: l.chance })) };
}

const NO_NODE = /no source node is available/i;

/** A node M₳X could gather at right now. */
const isFree = (n) => n.availableToAgent !== false && !n.reservedBy && (n.state === "available" || n.state === "unknown");

/**
 * All live nodes of one source. `node.kind` is the node family (tree_stand is
 * every tree in the forest, the level-41 groves included; ore_vein every vein
 * in the cave), so a node counts only when it yields what this source yields -
 * 2026-09-07 the run tried three "tree stands" that were really reserved
 * level-11 orchards and gave up although 100 trees were free.
 */
function nodesOf(def, resources) {
  const yields = new Set((def.outputs || []).map((o) => o.itemId));
  return resources.filter((n) => n.kind === def.id && (!n.yieldItemId || !yields.size || yields.has(n.yieldItemId)));
}

/**
 * Recipes the game has unlocked at the current levels, joined with the static
 * definition (inputs, outputs, xp) and the area of a workstation of the right
 * type. `usable` = unlocked and a workstation exists; `craftableBatches` and
 * `failureReason` are the live values (inputs in the bag, location).
 */
function recipesOf(prog) {
  const unlocked = new Set(prog.capabilities?.unlockedRecipeIds || []);
  const live = new Map((prog.capabilities?.recipes || []).map((r) => [r.recipeId, r]));
  const stations = catalog.gameContent()?.workstations || [];
  const out = [];
  for (const def of catalog.all("recipe")) {
    if (!unlocked.has(def.id)) continue;
    const station = stations.find((w) => w.workstationType === def.workstationType);
    const l = live.get(def.id) || {};
    out.push({
      id: def.id, skill: def.skill, xp: Number(def.xp || 0), requiredLevel: Number(def.requiredLevel || 1), inputs: def.inputs || [], outputs: def.outputs || [],
      workstationType: def.workstationType, areaId: station?.areaId || null, usable: !!station,
      craftableBatches: Number(l.craftableBatches || 0), failureReason: l.failureReason || null,
    });
  }
  return out;
}

/** Best node of a source right now: free, not reserved, nearest. */
function pickNode(nodes) {
  const free = nodes.filter(isFree);
  const pool = free.length ? free : nodes;
  return pool.slice().sort((a, b) => (a.distance ?? 9e9) - (b.distance ?? 9e9))[0] || null;
}

// ---------- actions ----------

let lastMeal = 0;
// the area M₳X was last walked to in this run: a node's `sameSpace` comes from
// the plan-time snapshot, so without this every canal cast paid a move-area
// walk back to the area anchor first (~1 min per gather, 2026-09-09 14:50)
let atArea = null;
async function walkTo(areaId, label, onTick) {
  if (atArea === areaId) return;
  await goTo(areaId, label, onTick);
  atArea = areaId;
}
async function upkeep(onTick) {
  await keepAlive();
  if (onTick) { try { await onTick(); } catch (e) { log("tick error:", e.message); } }
  if (Date.now() - lastMeal > 180_000) { lastMeal = Date.now(); await maybeEat({ onTick }); }
}

/**
 * One gather at one source. Tries up to 3 nodes when a node is taken.
 * Returns { ok, itemId, quantity } or { ok: false, reason }.
 */
export async function gatherOnce(src, onTick) {
  const tried = new Set();
  let nodes = src.nodes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const node = pickNode(nodes.filter((n) => !tried.has(n.id)));
    if (!node) return { ok: false, reason: "no node left to try" };
    tried.add(node.id);
    // walk when the game said "other space" at plan time and we have not been
    // there yet, or when this run last walked somewhere else
    if (node.areaId && (atArea ? atArea !== node.areaId : node.sameSpace === false)) {
      try { await walkTo(node.areaId, `${src.sourceId} at ${node.areaId}`, onTick); } catch (e) { return { ok: false, reason: e.message }; }
    }
    await waitIdle("before-gather", { onTick });
    const r = await action("gather", node.id);
    if (!r.ok) { log(`gather ${node.id} error: ${r.error}`); await sleep(10_000); continue; }
    const o = r.data.outcome || {};
    if (o.status === "failed") {
      log(`gather ${src.sourceId} @ ${node.id} rejected: ${o.reason || "unknown"}`);
      if (!NODE_BUSY.test(o.reason || "")) return { ok: false, reason: o.reason || "rejected" };
      // refresh reservations (and pick up nodes we did not know), try another one
      try {
        const live = readResources();
        const fresh = nodesOf({ id: src.sourceId, outputs: src.outputs }, live);
        nodes = fresh.length ? fresh : nodes.map((n) => live.find((x) => x.id === n.id) || n);
      } catch { /* keep what we have */ }
      await sleep(5_000);
      continue;
    }
    if (o.status === "pending") await waitIdle(`gathering ${src.sourceId}`, { onTick });
    const got = o.itemId ? { itemId: o.itemId, quantity: Number(o.quantity || 1) } : null;
    log(`gather ${src.sourceId} @ ${node.id}: ${o.status}${got ? `, +${got.quantity} ${got.itemId}` : ""} (+${src.xp} ${src.skill} XP)`);
    journal.note("gather", { sourceId: src.sourceId, nodeId: node.id, skill: src.skill, xp: src.xp, itemId: got?.itemId || null, quantity: got?.quantity || null });
    return { ok: true, ...got };
  }
  return { ok: false, reason: "all nodes taken" };
}

/** Walk to the contract area and deliver. Returns true on success. */
export async function deliverOne(c, onTick) {
  const check = () => (readProgression().capabilities?.contracts || []).find((x) => x.contractId === c.contractId) || {};
  let live = check();
  if (live.completed) { log(`contract ${c.contractId}: already completed`); return false; }
  if (/not in contract area/i.test(live.failureReason || "")) {
    atArea = null; // the game says we are elsewhere - walk for real
    await walkTo(c.areaId, `contract area ${c.areaId}`, onTick);
    await sleep(3_000);
    live = check();
  }
  if (live.failureReason) { log(`contract ${c.contractId} not deliverable: ${live.failureReason}`); return false; }
  await waitIdle("before-contract", { onTick });
  const needs = c.requirements.map((x) => `${x.quantity} ${x.itemId}`).join(", ");
  log(`contract: delivering ${c.contractId} (${c.skill}${needs ? `, ${needs}` : ""})`);
  const res = await action("deliver-contract", c.contractId);
  if (!res.ok) { log(`contract ${c.contractId} error: ${res.error}`); return false; }
  const o = res.data.outcome || {};
  if (o.status === "failed") { log(`contract ${c.contractId} rejected: ${o.reason || "unknown"}`); return false; }
  if (o.status === "pending") await waitIdle("contract", { onTick });
  const rewards = o.rewards || c.rewards || [];
  log(`contract ${c.contractId}: ${o.status}${rewards.length ? `, rewards ${rewards.map((x) => `${x.quantity} ${x.itemId}`).join(", ")}` : ""}, +${c.xp} ${c.skill} XP`);
  journal.note("contract", { contractId: c.contractId, skill: c.skill, xp: c.xp, rewards, status: o.status, quest: true });
  nightgate.enqueueDoc("contract", { date: today(), ts: Date.now(), contractId: c.contractId, skill: c.skill, xp: c.xp });
  await sleep(3_000);
  return true;
}

/** Journal every skill's XP; announce + anchor level-ups outside the main skill. */
export async function snapshotSkills(prog = null) {
  prog ??= readProgression();
  const st = loadState();
  const by = {};
  let total = 0;
  for (const [skill, s] of Object.entries(prog.skills || {})) { by[skill] = Number(s.xp || 0); total += by[skill]; }
  journal.note("skills", { total, by });
  st.levels ||= {};
  for (const [skill, s] of Object.entries(prog.skills || {})) {
    const lvl = Number(s.level || 1);
    const last = st.levels[skill];
    if (skill !== MAIN_SKILL && last != null && lvl > last) {
      log(`LEVEL UP: ${skill} ${last} -> ${lvl} (${by[skill]} XP)`);
      journal.note("levelup", { skill, level: lvl, xp: by[skill], from: last });
      nightgate.enqueueDoc("levelup", { date: today(), ts: Date.now(), skill, level: lvl, xp: by[skill] });
      try { await report.notify(`M₳X: ${skill} level ${lvl}`, `${skill} reached level ${lvl} with ${by[skill]} XP on a contract run. Anchored on Midnight.`); } catch (e) { log("notify failed:", e.message); }
    }
    st.levels[skill] = lvl;
  }
  st.totalXp = total;
  st.updatedAt = Date.now();
  saveState();
  return { total, by };
}

/**
 * One craft action at the recipe's workstation. `batches` is capped by what the
 * game reports as craftable once M₳X stands there. Returns { ok, batches, xp }.
 */
export async function craftOne(k, onTick) {
  if (!k.areaId) return { ok: false, reason: `no workstation for ${k.recipeId}` };
  const liveRow = () => (readProgression().capabilities?.recipes || []).find((r) => r.recipeId === k.recipeId) || {};
  let row = liveRow();
  if (!row.craftableBatches || /not at|workstation|area/i.test(row.failureReason || "")) {
    atArea = null; // the game decides whether we stand at the station - walk for real
    try { await walkTo(k.areaId, `${k.workstationType || "workstation"} at ${k.areaId}`, onTick); } catch (e) { return { ok: false, reason: e.message }; }
    await sleep(2_000);
    row = liveRow();
  }
  const batches = Math.min(k.batches || 1, Number(row.craftableBatches || 0), 100);
  if (batches < 1) return { ok: false, reason: row.failureReason || "nothing craftable" };
  await waitIdle("before-craft", { onTick });
  const r = await action("craft", k.recipeId, String(batches));
  if (!r.ok) return { ok: false, reason: r.error };
  const o = r.data.outcome || {};
  if (o.status === "failed") return { ok: false, reason: o.reason || "rejected" };
  if (o.status === "pending") await waitIdle(`crafting ${k.recipeId}`, { onTick, maxMs: 15 * 60_000 });
  const made = Number(o.batches || batches);
  const xp = k.xp * made;
  log(`craft ${k.recipeId} x${made} @ ${k.areaId}: ${o.status}${o.outputs ? `, ${JSON.stringify(o.outputs)}` : ""} (+${xp} ${k.skill} XP)`);
  journal.note("craft", { recipeId: k.recipeId, skill: k.skill, xp, batches: made, areaId: k.areaId });
  nightgate.enqueueDoc("craft", { date: today(), ts: Date.now(), recipeId: k.recipeId, skill: k.skill, xp, batches: made });
  return { ok: true, batches: made, xp };
}

/**
 * Workstation pass: craft everything the bag allows, grouped by workstation
 * area (one walk per station). Returns { crafts, xp, skills }.
 */
async function craftAll({ onTick, deadline }) {
  const out = { crafts: 0, xp: 0, skills: new Set() };
  const todo = recipesOf(readProgression()).filter((r) => r.usable && r.craftableBatches > 0)
    .sort((a, b) => String(a.areaId).localeCompare(String(b.areaId)) || b.xp - a.xp);
  if (!todo.length) return out;
  log(`craft: ${todo.length} recipe(s) craftable - ${todo.map((r) => `${r.craftableBatches}x ${r.id}`).join(", ")}`);
  for (const r of todo) {
    if (Date.now() > deadline) break;
    const res = await craftOne({ recipeId: r.id, skill: r.skill, xp: r.xp, batches: r.craftableBatches, areaId: r.areaId, workstationType: r.workstationType }, onTick);
    if (!res.ok) { log(`craft ${r.id}: ${res.reason}`); continue; }
    out.crafts++;
    out.xp += res.xp;
    out.skills.add(r.skill);
    await upkeep(onTick);
  }
  return out;
}

/**
 * Grind: gather at free nodes until the deadline or the gather cap. Sources
 * whose yield feeds a recipe count that recipe's XP too (a canal cast is 29
 * fishing XP plus 39 cooking XP per fish and per eel at the kitchen), then the
 * lowest-XP skill first so every skill gets its share.
 */
async function grind({ sources, recipes, prog, deadline, budget, onTick }) {
  const xpOf = (s) => Number(prog.skills?.[s]?.xp || 0);
  const value = (s) => s.xp + (recipes || []).filter((r) => r.usable && r.inputs.length === 1 && s.outputs.some((o) => o.itemId === r.inputs[0].itemId)).reduce((a, r) => a + r.xp, 0);
  let done = 0;
  const bad = new Set();
  // sources a blocked contract's rare drop comes from go first: a node gives
  // 5 gathers before it depletes, so each run buys ~5 tickets per lottery
  const wanted = (s) => (s.wantedRare?.length ? 1 : 0);
  while (done < budget && Date.now() < deadline) {
    const order = sources.filter((s) => !bad.has(s.sourceId))
      .sort((a, b) => wanted(b) - wanted(a) || value(b) - value(a) || xpOf(a.skill) - xpOf(b.skill) || (a.nodes[0]?.distance ?? 9e9) - (b.nodes[0]?.distance ?? 9e9));
    const src = order[0];
    if (!src) break;
    const r = await gatherOnce(src, onTick);
    if (!r.ok) { bad.add(src.sourceId); log(`grind: ${src.sourceId} out (${r.reason})`); continue; }
    done++;
    prog.skills[src.skill] = { ...(prog.skills[src.skill] || {}), xp: xpOf(src.skill) + src.xp };
    await upkeep(onTick);
    await sleep(2_000);
  }
  return done;
}

// ---------- the run ----------

/**
 * One contract run: plan, gather, deliver, grind, snapshot. A failed step
 * never aborts the run; returns the summary (null when nothing was possible).
 */
/**
 * Gather, craft and deliver every ready contract of a plan (skipping the ones
 * already handled in this run). Mutates `done`.
 */
async function executeContracts(p, done, { onTick, deadline, maxGathers, label }) {
  for (const c of p.ready) {
    if (done.contracts.includes(c.contractId) || done.failed.includes(c.contractId)) continue;
    if (Date.now() > deadline) { log(`${label}: time budget used`); break; }
    if (done.gathers >= maxGathers) { log(`${label}: gather cap reached`); break; }
    if (c.deps.some((d) => done.failed.includes(d))) { log(`${label}: ${c.contractId} skipped, its chain failed`); done.failed.push(c.contractId); continue; }
    let ok = true;
    for (const g of c.gathers) {
      // until the bag holds what the contract asks for (a source may yield one
      // of several items per gather), with a little slack over the planned count
      const wanted = Number(c.requirements.find((x) => x.itemId === g.itemId)?.quantity || 1);
      let tries = 0;
      while ((readInventory()[g.itemId] || 0) < wanted) {
        if (tries++ >= g.count + 3 || done.gathers >= maxGathers || Date.now() > deadline) { ok = false; break; }
        const r = await gatherOnce(g, onTick);
        if (!r.ok) { log(`${label}: ${c.contractId} - could not gather ${g.itemId} (${r.reason})`); ok = false; break; }
        done.gathers++;
        done.xp += g.xp;
        done.skills.add(g.skill);
        await upkeep(onTick);
      }
      if (!ok) { log(`${label}: ${c.contractId} - ${g.itemId} still missing after ${tries} gather(s)`); break; }
    }
    // recipes on the way to the requirement (inputs are in the bag now)
    for (const k of ok ? c.crafts || [] : []) {
      if ((readInventory()[k.itemId] || 0) >= k.wanted) continue;
      const r = await craftOne(k, onTick);
      if (!r.ok) { log(`${label}: ${c.contractId} - could not craft ${k.recipeId} (${r.reason})`); ok = false; break; }
      done.crafts++;
      done.xp += r.xp;
      done.skills.add(k.skill);
      await upkeep(onTick);
    }
    if (!ok) { done.failed.push(c.contractId); continue; }
    try {
      if (await deliverOne(c, onTick)) { done.contracts.push(c.contractId); done.xp += c.xp; done.skills.add(c.skill); }
      else done.failed.push(c.contractId);
    } catch (e) { log(`${label}: deliver ${c.contractId} failed: ${e.message}`); done.failed.push(c.contractId); }
    await upkeep(onTick);
  }
}

const freshPlan = () => plan({ prog: readProgression(), resources: readResources(), inv: readInventory() });

/**
 * One contract run: plan, gather, deliver, grind, snapshot. A failed step
 * never aborts the run; returns the summary (null when nothing was possible).
 *
 * Options: maxMs (time budget), maxGathers (default MCITY_QUEST_MAX_GATHERS),
 * countRun (false = does not count against MCITY_MAX_QUESTS - the work mode's
 * fallback when the terminals are taken), label (log prefix).
 *
 * The plan is redone with fresh occupancy after the contracts and after the
 * grind: a tree stand that was taken at the start may be free by then, a
 * rare drop the grind fished out makes its contract deliverable right away.
 */
export async function runOnce({ onTick = null, maxMs = 90 * 60_000, maxGathers = MAX_GATHERS, countRun = true, label = "quest" } = {}) {
  await catalog.ensure();
  if (!catalog.ready()) { log(`${label}: no catalog - skipping`); return null; }
  const deadline = Date.now() + maxMs;
  const st = loadState();
  if (countRun) st.runs = { ...(st.runs || {}), [today()]: (st.runs?.[today()] || 0) + 1 };
  saveState();
  const prog = readProgression();
  const p = plan({ prog, resources: readResources(), inv: readInventory() });
  const planXp = p.ready.reduce((a, c) => a + c.xp + c.gathers.reduce((x, g) => x + g.count * g.xp, 0), 0);
  const fishing = p.sources.filter((s) => s.wantedRare.length);
  log(`${label}: ${p.ready.length} contract(s) plannable (${planXp} XP), ${p.blocked.length} blocked (${p.contested.length} source(s) taken right now, ${fishing.length} rare-drop lotteries), ${p.sources.length} free sources${GRIND ? ", grind after" : ""}, up to ${maxGathers} gathers`);
  for (const c of p.ready) log(`  plan: ${c.contractId} (${c.skill}, +${c.xp}) @ ${c.areaId} via ${c.via}`);
  for (const s of p.contested) log(`  taken: ${s.sourceId} (${s.nodes.length} node(s), ${s.outputs.map((o) => o.itemId).join("+")}) - rechecked before the grind`);
  for (const s of fishing) log(`  lottery: ${s.sourceId} may drop ${s.wantedRare.map((w) => `${w.itemId} (${w.chance}%, ${w.contractId})`).join(", ")}`);
  const done = { contracts: [], gathers: 0, crafts: 0, xp: 0, skills: new Set(), failed: [] };
  lastMeal = Date.now();
  atArea = null; // wherever the previous mode left M₳X, the first gather walks
  await maybeEat({ threshold: 45, onTick });

  const ctx = { onTick, deadline, maxGathers, label };
  await executeContracts(p, done, ctx);

  // second look with fresh occupancy: a contested node may have come free
  let p2 = p;
  if (p.contested.length && Date.now() < deadline && done.gathers < maxGathers) {
    try {
      p2 = freshPlan();
      const now = p2.ready.filter((c) => !done.contracts.includes(c.contractId) && !done.failed.includes(c.contractId));
      if (now.length) { log(`${label}: ${now.length} contract(s) became plannable - ${now.map((c) => c.contractId).join(", ")}`); await executeContracts(p2, done, ctx); }
    } catch (e) { log(`${label}: re-plan failed: ${e.message}`); }
  }

  if (GRIND && Date.now() < deadline && done.gathers < maxGathers && p2.sources.length) {
    const n = await grind({ sources: p2.sources, recipes: p2.recipes, prog, deadline, budget: maxGathers - done.gathers, onTick });
    log(`${label}: grind ${n} gather(s)`);
    done.gathers += n;
  }

  // workstations: turn what the bag holds into crafted goods (and XP), then
  // deliver whatever the grind (a rare drop) or the crafts unlocked
  if (Date.now() < deadline) {
    try {
      const k = await craftAll({ onTick, deadline });
      done.crafts += k.crafts;
      done.xp += k.xp;
      for (const s of k.skills) done.skills.add(s);
      const again = freshPlan().ready.filter((c) => !c.gathers.length && !c.crafts.length && !done.failed.includes(c.contractId) && !done.contracts.includes(c.contractId));
      if (again.length) log(`${label}: ${again.length} contract(s) deliverable from the bag - ${again.map((c) => c.contractId).join(", ")}`);
      for (const c of again) {
        if (Date.now() > deadline) break;
        try {
          if (await deliverOne(c, onTick)) { done.contracts.push(c.contractId); done.xp += c.xp; done.skills.add(c.skill); }
        } catch (e) { log(`${label}: deliver ${c.contractId} failed: ${e.message}`); }
        await upkeep(onTick);
      }
    } catch (e) { log("craft pass failed:", e.message); }
  }

  let snap = null;
  try { snap = await snapshotSkills(); } catch (e) { log("skills snapshot failed:", e.message); }
  const summary = { contracts: done.contracts.length, xp: done.xp, gathers: done.gathers, crafts: done.crafts, skills: [...done.skills], failed: done.failed, totalXp: snap?.total ?? null, ...(countRun ? {} : { altWork: true }) };
  journal.note("quest", { ...summary, contractIds: done.contracts });
  if (done.contracts.length || done.gathers) nightgate.enqueueDoc("quest", { date: today(), ts: Date.now(), contracts: done.contracts.length, xp: done.xp, gathers: done.gathers });
  st.lastRun = { at: Date.now(), ...summary };
  st.lastPlan = { at: Date.now(), ready: p.ready.length - done.contracts.length, blocked: p.blocked.length };
  saveState();
  log(`${label}: done - ${done.contracts.length} contract(s), ${done.gathers} gather(s), ${done.crafts} craft(s), +${done.xp} XP${snap ? `, ${snap.total} XP total` : ""}`);
  return summary;
}

/**
 * Cheap gate for the mode chooser: is there anything to do? Cached 30 min.
 * Without a loaded catalog it answers "grind is on" rather than block.
 */
export function available() {
  const st = loadState();
  if (st.lastPlan && Date.now() - st.lastPlan.at < 30 * 60_000) return st.lastPlan.ready > 0 || GRIND;
  if (!catalog.ready()) return GRIND;
  try {
    const p = plan({ prog: readProgression(), resources: readResources(), inv: readInventory() });
    st.lastPlan = { at: Date.now(), ready: p.ready.length, blocked: p.blocked.length };
    saveState();
    return p.ready.length > 0 || (GRIND && p.sources.length > 0);
  } catch (e) {
    log("quest availability check failed:", e.message);
    return false;
  }
}

export const runsToday = () => loadState().runs?.[today()] || 0;

/** `life.mjs quests`: the plan at a glance (token only, no lease). */
export async function describe() {
  await catalog.ensure();
  if (!catalog.ready()) return "quest: catalog not loadable (offline?)";
  const prog = readProgression();
  const p = plan({ prog, resources: readResources(), inv: readInventory() });
  const st = loadState();
  const lines = [];
  const total = Object.values(prog.skills || {}).reduce((a, s) => a + Number(s.xp || 0), 0);
  const trained = Object.entries(prog.skills || {}).filter(([, s]) => Number(s.xp || 0) > 0).map(([k, s]) => `${k} ${s.level} (${s.xp})`).join(", ");
  lines.push(`skills: ${total} XP total - ${trained || "nothing trained yet"}; completed contracts: ${(prog.completedContractIds || []).length}`);
  lines.push(`runs today: ${st.runs?.[today()] || 0}${st.lastRun ? `; last run ${new Date(st.lastRun.at).toISOString().slice(0, 16)}: ${st.lastRun.contracts} contracts, ${st.lastRun.gathers} gathers, +${st.lastRun.xp} XP` : ""}`);
  const xp = p.ready.reduce((a, c) => a + c.xp + c.gathers.reduce((x, g) => x + g.count * g.xp, 0), 0);
  lines.push(`plannable now: ${p.ready.length} contract(s) worth ${xp} XP incl. gathering; grind ${GRIND ? "on" : "off"} at ${p.sources.length} free source(s)`);
  for (const c of p.ready) lines.push(`  ${c.contractId}  [${c.skill} +${c.xp}] @ ${c.areaId}  via ${c.via}`);
  if (p.blocked.length) {
    lines.push(`blocked: ${p.blocked.length}`);
    for (const b of p.blocked) lines.push(`  ${b.contractId}  [${b.skill} +${b.xp}]  ${b.reason}`);
  }
  if (p.sources.length) lines.push(`free sources: ${p.sources.map((s) => `${s.sourceId} (${s.skill}, ${s.freeNodes}/${s.nodes.length} node${s.nodes.length === 1 ? "" : "s"} free${s.areaId ? ` @ ${s.areaId}` : ""})`).join(", ")}`);
  if (p.contested.length) lines.push(`taken right now (rechecked every run): ${p.contested.map((s) => `${s.sourceId} (${s.skill}, ${s.nodes.length} level-1 node${s.nodes.length === 1 ? "" : "s"}${s.areaId ? ` @ ${s.areaId}` : ""}: ${s.nodes.map((n) => n.state + (n.reservedBy ? "/reserved" : "")).join(", ")})`).join("; ")}`);
  const fishing = p.sources.filter((s) => s.wantedRare.length);
  if (fishing.length) lines.push(`lotteries the grind plays first: ${fishing.map((s) => `${s.sourceId} -> ${s.wantedRare.map((w) => `${w.itemId} ${w.chance}%`).join(", ")}`).join("; ")}`);
  const usable = p.recipes.filter((r) => r.usable);
  if (usable.length) {
    const now = usable.filter((r) => r.craftableBatches > 0);
    lines.push(`recipes unlocked: ${usable.length}${now.length ? `; craftable from the bag now: ${now.map((r) => `${r.craftableBatches}x ${r.id} (+${r.xp * r.craftableBatches} ${r.skill})`).join(", ")}` : ""}`);
    lines.push(`  ${usable.map((r) => `${r.id} [${r.skill} +${r.xp}/batch @ ${r.areaId}: ${r.inputs.map((i) => i.itemId).join("+")}]`).join("\n  ")}`);
  }
  return lines.join("\n");
}
