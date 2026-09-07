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
 * its reward document -> contract B). Recipes (workstations) are not planned
 * yet - such contracts show up as blocked with the reason.
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
  // free sources (the game says gatherable) -> what they yield
  const sources = [];
  for (const s of prog.capabilities?.sources || []) {
    if (s.failureReason || SKIP_SOURCES.has(s.sourceId)) continue;
    const def = catalog.definition("source", s.sourceId);
    if (!def) continue;
    // progression lists at most ~10 node ids per source; `resources` has them
    // all (node.kind == sourceId) - the forest alone has 100+ tree stands
    const nodes = nodesOf(s.sourceId, resources);
    for (const id of [...(s.nodeIds || []), ...(s.availableNodeIds || [])]) {
      if (!nodes.some((n) => n.id === id)) nodes.push(nodeInfo.get(id) || { id, state: "unknown", availableToAgent: true, areaId: null, distance: 9e9 });
    }
    sources.push({ sourceId: s.sourceId, skill: def.skill, xp: Number(def.xp || 0), outputs: def.outputs || [], nodes, areaId: nodes.find((n) => n.areaId)?.areaId || null });
  }
  const producers = new Map(); // itemId -> source (normal outputs only; rare drops are luck, not a plan)
  for (const s of sources) for (const o of s.outputs) if (!producers.has(o.itemId)) producers.set(o.itemId, s);

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
      }
      // a recipe whose inputs all come from free sources (or the bag): gather the
      // inputs, craft at its workstation, then deliver
      const recipe = recipes.find((r) => (r.outputs || []).some((o) => o.itemId === req.itemId));
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
            if (!s2) { feasible = false; break; }
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
      return fail(c, recipe
        ? `needs ${req.itemId} (crafted at ${recipe.workstationType || "a workstation"}, ${recipe.skill} ${recipe.requiredLevel}${recipe.usable ? ", an input has no free source" : ""})`
        : `no free source for ${req.itemId}`);
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
  return { ready, blocked, sources, recipes };
}

/** All live nodes of one source (resources read: node.kind is the source id). */
const nodesOf = (sourceId, resources) => resources.filter((n) => n.kind === sourceId);

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
  const free = nodes.filter((n) => n.availableToAgent !== false && !n.reservedBy && (n.state === "available" || n.state === "unknown"));
  const pool = free.length ? free : nodes;
  return pool.slice().sort((a, b) => (a.distance ?? 9e9) - (b.distance ?? 9e9))[0] || null;
}

// ---------- actions ----------

let lastMeal = 0;
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
    if (node.sameSpace === false && node.areaId) {
      try { await goTo(node.areaId, `${src.sourceId} at ${node.areaId}`, onTick); } catch (e) { return { ok: false, reason: e.message }; }
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
        const fresh = nodesOf(src.sourceId, live);
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
    await goTo(c.areaId, `contract area ${c.areaId}`, onTick);
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
    try { await goTo(k.areaId, `${k.workstationType || "workstation"} at ${k.areaId}`, onTick); } catch (e) { return { ok: false, reason: e.message }; }
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
  while (done < budget && Date.now() < deadline) {
    const order = sources.filter((s) => !bad.has(s.sourceId))
      .sort((a, b) => value(b) - value(a) || xpOf(a.skill) - xpOf(b.skill) || (a.nodes[0]?.distance ?? 9e9) - (b.nodes[0]?.distance ?? 9e9));
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
export async function runOnce({ onTick = null, maxMs = 90 * 60_000 } = {}) {
  await catalog.ensure();
  if (!catalog.ready()) { log("quest: no catalog - skipping"); return null; }
  const deadline = Date.now() + maxMs;
  const st = loadState();
  st.runs = { ...(st.runs || {}), [today()]: (st.runs?.[today()] || 0) + 1 };
  saveState();
  const prog = readProgression();
  const p = plan({ prog, resources: readResources(), inv: readInventory() });
  const planXp = p.ready.reduce((a, c) => a + c.xp + c.gathers.reduce((x, g) => x + g.count * g.xp, 0), 0);
  log(`quest: ${p.ready.length} contract(s) plannable (${planXp} XP), ${p.blocked.length} blocked, ${p.sources.length} free sources${GRIND ? ", grind after" : ""}`);
  for (const c of p.ready) log(`  plan: ${c.contractId} (${c.skill}, +${c.xp}) @ ${c.areaId} via ${c.via}`);
  const done = { contracts: [], gathers: 0, crafts: 0, xp: 0, skills: new Set(), failed: [] };
  lastMeal = Date.now();
  await maybeEat({ threshold: 45, onTick });

  for (const c of p.ready) {
    if (Date.now() > deadline) { log("quest: time budget used"); break; }
    if (done.gathers >= MAX_GATHERS) { log("quest: gather cap reached"); break; }
    if (c.deps.some((d) => done.failed.includes(d))) { log(`quest: ${c.contractId} skipped, its chain failed`); done.failed.push(c.contractId); continue; }
    let ok = true;
    for (const g of c.gathers) {
      // until the bag holds what the contract asks for (a source may yield one
      // of several items per gather), with a little slack over the planned count
      const wanted = Number(c.requirements.find((x) => x.itemId === g.itemId)?.quantity || 1);
      let tries = 0;
      while ((readInventory()[g.itemId] || 0) < wanted) {
        if (tries++ >= g.count + 3 || done.gathers >= MAX_GATHERS || Date.now() > deadline) { ok = false; break; }
        const r = await gatherOnce(g, onTick);
        if (!r.ok) { log(`quest: ${c.contractId} - could not gather ${g.itemId} (${r.reason})`); ok = false; break; }
        done.gathers++;
        done.xp += g.xp;
        done.skills.add(g.skill);
        await upkeep(onTick);
      }
      if (!ok) { log(`quest: ${c.contractId} - ${g.itemId} still missing after ${tries} gather(s)`); break; }
    }
    // recipes on the way to the requirement (inputs are in the bag now)
    for (const k of ok ? c.crafts || [] : []) {
      if ((readInventory()[k.itemId] || 0) >= k.wanted) continue;
      const r = await craftOne(k, onTick);
      if (!r.ok) { log(`quest: ${c.contractId} - could not craft ${k.recipeId} (${r.reason})`); ok = false; break; }
      done.crafts++;
      done.xp += r.xp;
      done.skills.add(k.skill);
      await upkeep(onTick);
    }
    if (!ok) { done.failed.push(c.contractId); continue; }
    try {
      if (await deliverOne(c, onTick)) { done.contracts.push(c.contractId); done.xp += c.xp; done.skills.add(c.skill); }
      else done.failed.push(c.contractId);
    } catch (e) { log(`quest: deliver ${c.contractId} failed: ${e.message}`); done.failed.push(c.contractId); }
    await upkeep(onTick);
  }

  if (GRIND && Date.now() < deadline && done.gathers < MAX_GATHERS && p.sources.length) {
    const n = await grind({ sources: p.sources, recipes: p.recipes, prog, deadline, budget: MAX_GATHERS - done.gathers, onTick });
    log(`quest: grind ${n} gather(s)`);
    done.gathers += n;
  }

  // workstations: turn what the bag holds into crafted goods (and XP), then
  // deliver whatever contract that unlocked without gathering again
  if (Date.now() < deadline) {
    try {
      const k = await craftAll({ onTick, deadline });
      done.crafts += k.crafts;
      done.xp += k.xp;
      for (const s of k.skills) done.skills.add(s);
      if (k.crafts) {
        const again = plan({ prog: readProgression(), resources: readResources(), inv: readInventory() }).ready.filter((c) => !c.gathers.length && !c.crafts.length && !done.failed.includes(c.contractId));
        for (const c of again) {
          if (Date.now() > deadline) break;
          try {
            if (await deliverOne(c, onTick)) { done.contracts.push(c.contractId); done.xp += c.xp; done.skills.add(c.skill); }
          } catch (e) { log(`quest: deliver ${c.contractId} failed: ${e.message}`); }
          await upkeep(onTick);
        }
      }
    } catch (e) { log("craft pass failed:", e.message); }
  }

  let snap = null;
  try { snap = await snapshotSkills(); } catch (e) { log("skills snapshot failed:", e.message); }
  const summary = { contracts: done.contracts.length, xp: done.xp, gathers: done.gathers, crafts: done.crafts, skills: [...done.skills], failed: done.failed, totalXp: snap?.total ?? null };
  journal.note("quest", { ...summary, contractIds: done.contracts });
  if (done.contracts.length || done.gathers) nightgate.enqueueDoc("quest", { date: today(), ts: Date.now(), contracts: done.contracts.length, xp: done.xp, gathers: done.gathers });
  st.lastRun = { at: Date.now(), ...summary };
  st.lastPlan = { at: Date.now(), ready: p.ready.length - done.contracts.length, blocked: p.blocked.length };
  saveState();
  log(`quest: done - ${done.contracts.length} contract(s), ${done.gathers} gather(s), ${done.crafts} craft(s), +${done.xp} XP${snap ? `, ${snap.total} XP total` : ""}`);
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
  if (p.sources.length) lines.push(`free sources: ${p.sources.map((s) => `${s.sourceId} (${s.skill}, ${s.nodes.length} node${s.nodes.length === 1 ? "" : "s"}${s.areaId ? ` @ ${s.areaId}` : ""})`).join(", ")}`);
  const usable = p.recipes.filter((r) => r.usable);
  if (usable.length) {
    const now = usable.filter((r) => r.craftableBatches > 0);
    lines.push(`recipes unlocked: ${usable.length}${now.length ? `; craftable from the bag now: ${now.map((r) => `${r.craftableBatches}x ${r.id} (+${r.xp * r.craftableBatches} ${r.skill})`).join(", ")}` : ""}`);
    lines.push(`  ${usable.map((r) => `${r.id} [${r.skill} +${r.xp}/batch @ ${r.areaId}: ${r.inputs.map((i) => i.itemId).join("+")}]`).join("\n  ")}`);
  }
  return lines.join("\n");
}
