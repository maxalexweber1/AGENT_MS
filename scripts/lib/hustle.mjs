/**
 * Hustle mode (since 2026-09-11): M₳X goes where the people are and SELLS
 * the paid notary - one line of theirs, hashed and anchored on Midnight for
 * MCITY_NOTARY_PRICE crystal, sha256 receipt that anyone can verify against
 * live contract state. He is persuasive and he stays honest: every selling
 * point is a fact (the sponsor pays the chain fee, verification is public,
 * his own track record is on the same vault), no invented benefits, no fake
 * scarcity, and a clear "no" ends the pitch.
 *
 * One run:
 *   1. find a crowd - stay if enough approachable agents are in reach, else
 *      walk the hangout spots (best remembered crowd first) and stop at the
 *      fullest one
 *   2. pitch one agent every MCITY_HUSTLE_PITCH_GAP_S (social.maybeInitiate
 *      with pitch: true - the hourly message quota still applies, replies
 *      always come first)
 *   3. the pitched agent's answers go through the deal flow in
 *      social.answerThread: question -> answer + ask for their line,
 *      agreement -> ask for the line, a claim -> quote (price, M₳X's id, the
 *      claim's sha256), "sent" -> payment check + receipt, "no" -> sign off
 *   4. run summary -> journal `hustle` + anchor `hustle`
 *
 * Conversions are attributed through the journal: `notary-order` and
 * `notary-paid` events carry `pitched: true` when the order came out of a
 * pitch thread (notary.request receives that flag from social).
 */

import fs from "node:fs";
import path from "node:path";
import { log, sleep, dataDir, getContext } from "./mc.mjs";
import * as social from "./social.mjs";
import * as work from "./work.mjs";
import * as journal from "./journal.mjs";
import * as nightgate from "./nightgate.mjs";
import * as notary from "./notary.mjs";

export const cfg = {
  // where the people actually are (12.09.2026, 06:20 UTC sample of `agents`): 113 of 115 agents on M₳X's map
  // stood in hacker-house-interior at the terminals; the plazas of central were empty in all 26 spot
  // checks of the first 9 runs. `hacker-house` is the door outside - the crowd is inside.
  spots: (process.env.MCITY_HUSTLE_SPOTS || "hacker-house-interior,central-plaza,partner-plaza,charging-house,bison-valley").split(",").map((s) => s.trim()).filter(Boolean),
  minCrowd: Number(process.env.MCITY_HUSTLE_MIN_CROWD ?? 3),      // approachable agents in reach before M₳X settles at a spot
  maxMoves: Number(process.env.MCITY_HUSTLE_MAX_MOVES ?? 3),      // spots tried per run when the crowd is thin
  maxDistance: Number(process.env.MCITY_HUSTLE_DISTANCE ?? 60),   // tiles
  pitchGapMs: Number(process.env.MCITY_HUSTLE_PITCH_GAP_S ?? 90) * 1000,
  maxPitchesPerDay: Number(process.env.MCITY_HUSTLE_MAX_PITCHES ?? 30),
  pitchCooldownMs: Number(process.env.MCITY_HUSTLE_REPITCH_H ?? 48) * 3600_000, // same agent is not pitched again within
  chargeFirst: process.env.MCITY_HUSTLE_CHARGE_FIRST !== "0",     // pitched agents pay from the first anchor (the free-first rule is for people who ask)
  relocateEveryMs: 5 * 60_000,
};

const file = path.join(dataDir, "hustle.json");
let state = null;
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { state = {}; }
  state.spots ||= {};   // areaId -> { crowd, at }
  state.runs ||= [];    // last runs
  return state;
}
function save() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    state.runs = state.runs.slice(-30);
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (e) { log("hustle state write failed:", e.message); }
}

/**
 * Approachable agents in reach that have not heard the pitch lately.
 * `canSpeak` is deliberately NOT required here: the game sets it false for
 * everyone while M₳X himself is in an open thread (12.09.2026: 475 agents,
 * canSpeak false on all of them, three threads open) - a crowd estimate
 * that reads 0 whenever someone is talking to him sends him walking to
 * empty plazas. The pitch itself still goes through social.maybeInitiate,
 * which checks canSpeak per target.
 */
export function crowd() {
  return social.nearbyAgents(true).filter((a) =>
    a.isOnSameMap && a.isOpenToTalk && (a.distance ?? 999) <= cfg.maxDistance &&
    !social.pitchedRecently(a.id, cfg.pitchCooldownMs)
  ).length;
}

function rememberSpot(areaId, n) {
  const st = load();
  st.spots[areaId] = { crowd: n, at: Date.now() };
  save();
}

/** Spots in the order worth trying: best remembered crowd first, unknown ones next, the current one last. */
function spotOrder(current) {
  const st = load();
  return [...cfg.spots]
    .filter((s) => s !== current)
    .sort((a, b) => (st.spots[b]?.crowd ?? 1) - (st.spots[a]?.crowd ?? 1));
}

/** Nothing to sell without a vault: the mode is off when anchoring is off. */
export function available() {
  return nightgate.config().enabled && notary.cfg.price > 0;
}

async function findCrowd(onTick) {
  const here = getContext();
  // the context only carries the space (e.g. "central", "hacker-house-interior"), never an area id;
  // a space is not a `move-area` target unless it is also listed as one (the hacker house interior is,
  // the district "central" is not: "could not move to central" in every run before 12.09.2026)
  const startArea = here?.position?.spaceId || "";
  let best = { areaId: startArea, crowd: crowd(), walkable: cfg.spots.includes(startArea) };
  if (best.crowd >= cfg.minCrowd) {
    log(`hustle: ${best.crowd} people in reach here (${startArea || "?"}) - staying`);
    return best;
  }
  let moves = 0;
  let lastVisited = "";
  for (const spot of spotOrder(startArea)) {
    if (moves >= cfg.maxMoves) break;
    moves++;
    try {
      await work.goTo(spot, spot, onTick);
    } catch (e) {
      log(`hustle: could not reach ${spot}: ${e.message}`);
      continue;
    }
    lastVisited = spot;
    await sleep(3_000);
    const n = crowd();
    rememberSpot(spot, n);
    log(`hustle: ${spot}: ${n} approachable`);
    if (n > best.crowd) best = { areaId: spot, crowd: n, walkable: true };
    if (n >= cfg.minCrowd) return best;
  }
  // thin everywhere: settle at the best of what we saw (only walk back to a spot we can actually move to)
  if (best.walkable && best.areaId !== lastVisited) {
    try { await work.goTo(best.areaId, best.areaId, onTick); } catch (e) { log(`hustle: back to ${best.areaId} failed: ${e.message}`); }
  } else if (lastVisited) {
    best = { ...best, areaId: lastVisited }; // we stay where the last check left us
  }
  return best;
}

/**
 * One hustle run. Returns { place, pitches, quotes, paid, income, minutes }.
 * opts: { onTick, maxMs (default 25 min) }
 */
export async function runOnce({ onTick = null, maxMs = 25 * 60_000 } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + maxMs;
  const tick = async () => { if (onTick) await onTick(); };

  const spot = await findCrowd(tick);
  let place = spot.areaId || getContext()?.position?.spaceId || "central";
  if (!spot.crowd) log("hustle: nobody approachable anywhere - staying reactive for this run");

  let nextPitch = 0;
  let nextRelocate = Date.now() + cfg.relocateEveryMs;
  let lastMeal = Date.now();
  let moves = 0;
  while (Date.now() < deadline) {
    await tick();
    if (Date.now() >= nextPitch) {
      const minutesLeft = Math.max(1, Math.round((deadline - Date.now()) / 60_000));
      let ok = false;
      try {
        ok = await social.maybeInitiate({ pitch: true, maxDistance: cfg.maxDistance, pitchGapMs: cfg.pitchGapMs, pitchCooldownMs: cfg.pitchCooldownMs, maxPitchesPerDay: cfg.maxPitchesPerDay, minutesLeft, place });
      } catch (e) { log("hustle: pitch failed:", e.message); }
      nextPitch = Date.now() + (ok ? cfg.pitchGapMs : 30_000);
    }
    if (Date.now() - lastMeal > 180_000) {
      lastMeal = Date.now();
      try { await work.maybeEat({ onTick: tick }); } catch (e) { log("hustle: meal failed:", e.message); }
    }
    // the crowd moved on: try the next spot (at most maxMoves per run)
    if (Date.now() >= nextRelocate && moves < cfg.maxMoves && deadline - Date.now() > 6 * 60_000) {
      nextRelocate = Date.now() + cfg.relocateEveryMs;
      const n = crowd();
      rememberSpot(place, n);
      if (n < Math.max(1, Math.ceil(cfg.minCrowd / 2))) {
        const next = spotOrder(place)[0];
        if (next) {
          moves++;
          log(`hustle: only ${n} left here - moving to ${next}`);
          // `place` follows the move - before 12.09.2026 it stayed on the start value, so every
          // relocation went to the same first spot again and the crowd was booked under the wrong key
          try { await work.goTo(next, next, tick); place = next; } catch (e) { log(`hustle: move to ${next} failed: ${e.message}`); }
        }
      }
    }
    await sleep(10_000);
  }

  // what came out of this run (attributed through the journal)
  const ev = journal.since(startedAt);
  const pitches = ev.filter((e) => e.type === "opener" && e.pitch).length;
  const quotes = ev.filter((e) => e.type === "notary-order" && e.pitched && !e.free).length;
  const paidEv = ev.filter((e) => e.type === "notary-paid" && e.pitched);
  const paid = paidEv.length;
  const income = paidEv.reduce((a, e) => a + (e.amount || 0), 0);
  const minutes = Math.round((Date.now() - startedAt) / 60_000);
  const r = { place, pitches, quotes, paid, income, minutes };
  const st = load();
  st.runs.push({ at: startedAt, ...r });
  save();
  journal.note("hustle", r);
  nightgate.enqueueDoc("hustle", { date: new Date().toISOString().slice(0, 10), ts: Date.now(), place, pitches, quotes, paid, minutes });
  log(`hustle: done at ${place} - ${pitches} pitches, ${quotes} quotes, ${paid} paid (+${income} crystal) in ${minutes} min`);
  return r;
}

/** Numbers for status and the report. */
export function stats() {
  const st = load();
  const day = new Date().toISOString().slice(0, 10);
  const today = st.runs.filter((r) => new Date(r.at).toISOString().slice(0, 10) === day);
  const sum = (k) => today.reduce((a, r) => a + (r[k] || 0), 0);
  return { runsToday: today.length, pitchesToday: sum("pitches"), quotesToday: sum("quotes"), paidToday: sum("paid"), incomeToday: sum("income"), spots: st.spots };
}
