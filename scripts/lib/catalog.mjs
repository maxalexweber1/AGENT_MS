/**
 * The static content catalog (items, sources, recipes, contracts, ...) of the
 * current Midnight City world, loaded ONCE per process and cached on disk.
 *
 * `mcity-control.mjs definition <kind> <id>` downloads the whole static world
 * (~10 MB) for every single lookup; a contract run needs dozens of lookups.
 * This module fetches `/api/stats` -> staticVersion -> `/api/static-world/<v>`
 * one time, keeps the parsed content in memory and a copy in
 * data/static-world-<version>.json (older versions are removed).
 *
 * `ensure()` is async (network); `definition()` is sync afterwards and falls
 * back to the helper's single lookup when nothing has been loaded yet.
 */

import fs from "node:fs";
import path from "node:path";
import { run, log, dataDir, loadDotEnv } from "./mc.mjs";

loadDotEnv();

const COLLECTIONS = { item: "items", recipe: "recipes", source: "sources", enemy: "enemies", contract: "contracts", site: "constructionSites" };
let loaded = null; // { version, gameContent, areas, byKind: Map }

function observerUrl() {
  return (process.env.MCITY_OBSERVER_URL || "").replace(/\/$/, "");
}

async function fetchJson(route) {
  const res = await fetch(`${observerUrl()}${route}`, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${route}`);
  return res.json();
}

function index(staticWorld, version) {
  const gameContent = staticWorld?.staticWorld?.gameContent || {};
  const byKind = new Map();
  for (const [kind, coll] of Object.entries(COLLECTIONS)) {
    byKind.set(kind, new Map((gameContent[coll] || []).map((d) => [d.id, d])));
  }
  return { version, gameContent, areas: staticWorld?.staticWorld?.areas || [], byKind };
}

/** Load (or reuse) the catalog. Never throws: returns null when offline. */
export async function ensure() {
  if (loaded) return loaded;
  try {
    const stats = await fetchJson("/api/stats");
    const version = String(stats?.staticVersion || "");
    if (!version) throw new Error("no staticVersion in /api/stats");
    const file = path.join(dataDir, `static-world-${version}.json`);
    let world = null;
    try { world = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* not cached */ }
    if (!world) {
      world = await fetchJson(`/api/static-world/${encodeURIComponent(version)}`);
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(world));
        for (const f of fs.readdirSync(dataDir)) {
          if (/^static-world-.*\.json$/.test(f) && path.join(dataDir, f) !== file) fs.unlinkSync(path.join(dataDir, f));
        }
      } catch (e) { log("catalog cache write failed:", e.message); }
      log(`catalog: static world ${version} loaded (${(world?.staticWorld?.gameContent?.contracts || []).length} contracts, ${(world?.staticWorld?.gameContent?.sources || []).length} sources)`);
    }
    loaded = index(world, version);
    return loaded;
  } catch (e) {
    log("catalog load failed:", e.message);
    return null;
  }
}

/** True once ensure() succeeded in this process. */
export const ready = () => !!loaded;

/** One definition (sync). Uses the loaded catalog, else one helper lookup. */
const fallback = new Map();
export function definition(kind, id) {
  if (loaded) return loaded.byKind.get(kind)?.get(id) || null;
  const key = `${kind}:${id}`;
  if (!fallback.has(key)) {
    try { fallback.set(key, run("definition", kind, id).definition || null); } catch (e) {
      log(`definition ${kind} ${id} failed:`, e.message);
      fallback.set(key, null);
    }
  }
  return fallback.get(key);
}

/** The whole gameContent block (workstations, xpThresholds, ...), null until loaded. */
export const gameContent = () => loaded?.gameContent || null;

/** All definitions of one kind (empty until loaded). */
export function all(kind) {
  return loaded ? [...loaded.byKind.get(kind)?.values() || []] : [];
}

/** spaceId of a static area (contract areas, worksites), or null. */
export function areaSpace(areaId) {
  return loaded?.areas.find((a) => a.id === areaId)?.spaceId || null;
}
