/**
 * Exploration: visit districts M₳X has not seen (or not seen for a while),
 * look around, note what is there, talk to someone, come home.
 * Everything learned lands in memory.world and becomes conversation material.
 */

import { run, tryRun, action, log, sleep, waitIdle, getContext, pick, rand } from "./mc.mjs";
import * as mem from "./memory.mjs";
import * as llm from "./llm.mjs";
import * as social from "./social.mjs";
import * as journal from "./journal.mjs";
import * as nightgate from "./nightgate.mjs";
import { goTo } from "./work.mjs";

export const HOME_DISTRICT = "central";
const TRAVEL_MAX_MS = 12 * 60_000;

function navOptions() {
  const r = tryRun("navigation-options");
  return r.ok ? r.data : { travelDistricts: [], enterableBuildings: [] };
}

const KNOWN_EMPTY_RECHECK_MS = 5 * 24 * 3600_000;
const STAY_WITH_PEOPLE_MS = 10 * 60_000;

/**
 * Rank reachable districts. Unseen ones first. A district seen empty twice
 * or more is parked for 5 days (16 of the first 18 trips found nobody).
 * Among the rest: 70% of the time the most populated one (people are the
 * point of exploring), otherwise the one not visited for longest.
 */
export function rankDestinations(options, districts, now = Date.now(), rnd = Math.random) {
  const info = options.map((d) => {
    const m = districts[d.id] || {};
    return { ...d, visits: m.visits || 0, last: m.lastVisit || 0, seen: m.agentsSeen || 0 };
  });
  const unseen = info.filter((d) => d.visits === 0);
  if (unseen.length) return unseen.sort(() => rnd() - 0.5);
  const live = info.filter((d) => !(d.seen === 0 && d.visits >= 2 && now - d.last < KNOWN_EMPTY_RECHECK_MS));
  const pool = live.length ? live : info;
  return rnd() < 0.7
    ? pool.sort((a, b) => b.seen - a.seen || a.last - b.last)
    : pool.sort((a, b) => a.last - b.last);
}

/** Best reachable district right now (see rankDestinations). */
export function pickDestination() {
  const nav = navOptions();
  const options = (nav.travelDistricts || []).filter((d) => d.id !== HOME_DISTRICT);
  if (!options.length) return null;
  return rankDestinations(options, mem.memory.world.districts)[0] || null;
}

async function travelTo(districtId, onTick) {
  await waitIdle("before-travel", { onTick });
  const r = await action("travel-district", districtId);
  if (!r.ok) throw new Error(`travel-district ${districtId}: ${r.error}`);
  const o = r.data.outcome || {};
  if (o.status === "failed") throw new Error(`travel to ${districtId} rejected: ${o.reason || "unknown"}`);
  await sleep(5_000);
  const a = await waitIdle(`traveling to ${districtId}`, { onTick, maxMs: TRAVEL_MAX_MS, pollMs: 20_000 });
  return a.position.spaceId;
}

export async function goHome(onTick) {
  const a = getContext();
  if (a.position.spaceId === HOME_DISTRICT) return true;
  const nav = navOptions();
  if ((nav.travelDistricts || []).some((d) => d.id === HOME_DISTRICT)) {
    const space = await travelTo(HOME_DISTRICT, onTick);
    if (space === HOME_DISTRICT) return true;
  }
  // interiors: try a teleport-reachable exterior area
  const r = tryRun("areas");
  const target = (r.ok ? r.data.areas : []).find((x) => x.spaceId === HOME_DISTRICT && x.moveAreaAvailable && x.id === "central-plaza")
    || (r.ok ? r.data.areas : []).find((x) => x.spaceId === HOME_DISTRICT && x.moveAreaAvailable);
  if (target) {
    await goTo(target.id, target.name, onTick);
    return getContext().position.spaceId === HOME_DISTRICT;
  }
  if (nav.exitBuilding?.kind === "buildingLink") {
    await action("exit-building");
    await sleep(4_000);
    await waitIdle("exiting", { onTick });
    return getContext().position.spaceId === HOME_DISTRICT;
  }
  return false;
}

function lookAround(spaceId) {
  const areas = (tryRun("areas").data?.areas || []).filter((a) => a.sameSpace || a.spaceId === spaceId);
  const agents = social.nearbyAgents(true).filter((a) => a.isOnSameMap);
  const merchants = (tryRun("merchants").data?.merchants || []).filter((m) => (m.position?.spaceId || "central") === spaceId);
  const profs = {};
  for (const a of agents) profs[a.profession || "?"] = (profs[a.profession || "?"] || 0) + 1;
  return { areas, agents, merchants, profs };
}

/**
 * One exploration trip. Returns a short note about the place (or "").
 * opts: { onTick, maxMs (default 40 min) }
 */
export async function exploreOnce({ onTick = null, maxMs = 40 * 60_000 } = {}) {
  let dest = pickDestination();
  if (!dest) {
    // interiors (hacker house, charging house) have no district exits: step outside first
    log("explore: no district reachable from here - going outside first");
    await goHome(onTick);
    dest = pickDestination();
  }
  if (!dest) { log("explore: still no district reachable"); return ""; }
  const deadline = Date.now() + maxMs;
  log(`explore: heading to ${dest.name} (${dest.id})`);
  const space = await travelTo(dest.id, onTick);
  const d = mem.district(dest.id);
  d.name = dest.name || dest.id;
  d.visits++;
  d.lastVisit = Date.now();
  if (space !== dest.id) {
    log(`explore: ended up in ${space}, expected ${dest.id}`);
  }

  // look around
  const seen = lookAround(space);
  d.areas = seen.areas.map((a) => ({ id: a.id, name: a.name, kind: a.kind }));
  d.agentsSeen = seen.agents.length;
  for (const m of seen.merchants) {
    mem.memory.world.merchants[m.name] = { summary: m.offer?.summary || "", spaceId: space, x: m.position?.x, y: m.position?.y, seenAt: Date.now() };
  }
  const profLine = Object.entries(seen.profs).map(([k, v]) => `${v} ${k}${v === 1 ? "" : "s"}`).join(", ") || "nobody";
  const areaLine = seen.areas.slice(0, 8).map((a) => `${a.name || a.id} (${a.kind})`).join(", ") || "no named areas";
  const merchLine = seen.merchants.map((m) => `${m.name}: ${m.offer?.summary || "?"}`).join("; ") || "no merchants";
  const observations = `${dest.name}: ${seen.agents.length} agents around (${profLine}). Areas: ${areaLine}. Merchants: ${merchLine}.`;
  log(`explore: ${observations}`);
  mem.addFact(`${dest.name}: ${seen.agents.length} agents (${profLine}); merchants: ${merchLine}`);

  // wander to one or two areas
  const walkable = seen.areas.filter((a) => a.moveAreaAvailable && a.sameSpace);
  for (const a of walkable.sort(() => Math.random() - 0.5).slice(0, 2)) {
    if (Date.now() > deadline) break;
    try {
      await goTo(a.id, a.name || a.id, onTick);
      log(`explore: at ${a.name || a.id} (${a.kind})`);
      await sleep(rand(20_000, 60_000));
      if (onTick) await onTick();
    } catch (e) {
      log(`explore: could not reach ${a.id}: ${e.message}`);
    }
  }

  // a note in M₳X's voice
  let note = null;
  if (llm.enabled()) note = await llm.placeNote(dest.name || dest.id, observations);
  if (!note) {
    note = seen.agents.length
      ? `${dest.name}: ${profLine}, ${seen.merchants.length ? seen.merchants.length + " merchant(s)" : "no merchants"} — nothing that beats 10 a coin.`
      : `${dest.name}: empty when I was there. Quiet, no merchants worth the walk.`;
  }
  d.notes.push(note);
  if (d.notes.length > 5) d.notes.splice(0, d.notes.length - 5);
  mem.save();
  journal.note("explore", { district: dest.name || dest.id, note, agents: seen.agents.length, merchants: seen.merchants.length });
  // anchor the trip - M₳X as a provable cartographer of the city
  nightgate.enqueueDoc("explore", {
    date: new Date().toISOString().slice(0, 10), ts: Date.now(),
    district: dest.name || dest.id, noteSha256: nightgate.sha256hex(note || ""),
  });

  // people around? then this is the point of the trip: stay a while, talk to
  // more than one of them (initiate cooldowns still apply), answer whoever comes
  if (Date.now() < deadline && seen.agents.length) {
    const stayUntil = Math.min(deadline, Date.now() + STAY_WITH_PEOPLE_MS);
    log(`explore: ${seen.agents.length} agents here - staying up to ${Math.round((stayUntil - Date.now()) / 60_000)} min`);
    let nextInitiate = 0;
    while (Date.now() < stayUntil) {
      if (Date.now() >= nextInitiate) {
        try { await social.maybeInitiate({ placeNote: note, maxDistance: 60 }); } catch (e) { log("explore: initiate failed:", e.message); }
        nextInitiate = Date.now() + rand(90_000, 180_000);
      }
      if (onTick) await onTick();
      await sleep(10_000);
    }
  }

  log("explore: heading home");
  const home = await goHome(onTick);
  if (!home) log("explore: not home yet - will retry from the main loop");
  return note;
}
