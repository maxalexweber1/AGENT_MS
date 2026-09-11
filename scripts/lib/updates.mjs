/**
 * Release scanner (since 2026-09-11): M₳X keeps an eye on what his own
 * projects ship and talks about it. Sources are public and need no token:
 *   - GitHub releases of ODATANO/NIGHTGATE and ODATANO/ODATANO (release
 *     notes = what is new; 60 unauthenticated requests/h, ETags keep it cheap)
 *   - npm dist-tags of @odatano/nightgate, @odatano/nightgate-tx and
 *     @odatano/core as the fallback when GitHub is unreachable
 *
 * A new release lands in data/updates.json with a one-line "news line" in
 * M₳X's voice (LLM, else extractive), goes to the journal (`release`) and
 * into every prompt as the NEWS block (newsBrief), into the rule engine
 * (intent `news`, opener/shout variants) and into the daily report.
 *
 * Nothing here is secret - release notes are public by definition. M₳X only
 * repeats what the notes say; he never invents features.
 */

import fs from "node:fs";
import path from "node:path";
import { dataDir, log } from "./mc.mjs";
import * as journal from "./journal.mjs";
import * as llm from "./llm.mjs";

export const cfg = {
  everyMs: Number(process.env.MCITY_UPDATES_EVERY_MIN ?? 180) * 60_000, // 0 = off
  repos: (process.env.MCITY_UPDATES_REPOS || "ODATANO/NIGHTGATE,ODATANO/ODATANO").split(",").map((s) => s.trim()).filter(Boolean),
  packages: (process.env.MCITY_UPDATES_PACKAGES || "@odatano/nightgate,@odatano/nightgate-tx,@odatano/core").split(",").map((s) => s.trim()).filter(Boolean),
  freshDays: Number(process.env.MCITY_UPDATES_FRESH_DAYS ?? 10), // how long a release counts as news
  timeoutMs: 12_000,
};

export const HANDLE = "@odatano_v4"; // the projects on X - M₳X drops it when the projects come up

const file = path.join(dataDir, "updates.json");
let state = null;
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { state = {}; }
  state.releases ||= [];   // { repo, tag, name, publishedAt, url, body, line, seenAt, announced }
  state.versions ||= {};   // package -> latest dist-tag
  state.etags ||= {};
  state.lastScan ||= 0;
  return state;
}
function save() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    state.releases = state.releases.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, 40);
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (e) { log("updates state write failed:", e.message); }
}

async function getJson(url, { etag = "", headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "max-agent (midnight city)", ...(etag ? { "if-none-match": etag } : {}), ...headers } });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: await res.json(), etag: res.headers.get("etag") || "" };
  } finally { clearTimeout(timer); }
}

/** The project name people know a repo by. */
const repoName = (repo) => repo.split("/")[1] || repo;

/** Extractive fallback: first meaningful bullet or sentence of the release notes. */
function extractLine(rel) {
  // markdown -> paragraphs: drop code fences and headings, join wrapped bullet lines
  const lines = String(rel.body || "").replace(/\r/g, "").split("\n");
  const paras = [];
  let fence = false, cur = "";
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const l = raw.trim();
    if (!l || /^#/.test(l)) { if (cur) paras.push(cur); cur = ""; continue; }
    if (/^[-*]\s+/.test(l) || !cur) { if (cur) paras.push(cur); cur = l.replace(/^[-*]\s+/, ""); }
    else cur += " " + l;
  }
  if (cur) paras.push(cur);
  // links -> text, code/emphasis markers gone (underscores stay: AGENT_GRANTS_ENABLED is a word, not emphasis)
  const clean = (t) => t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  const first = clean(paras.find((p) => !/^(install|npm i|npm install)/i.test(p)) || rel.name || rel.tag);
  const sentence = (first.match(/^[^.!?]*[.!?](?=\s|$)/) || [first])[0];
  const short = sentence.length > 160 ? sentence.slice(0, 157).replace(/\s+\S*$/, "") + "…" : sentence;
  return `${repoName(rel.repo)} ${rel.tag.replace(/^v/, "")} is out: ${short}`;
}

async function newsLine(rel) {
  let line = null;
  if (llm.enabled()) {
    line = await llm.newsLine(repoName(rel.repo), rel.tag.replace(/^v/, ""), String(rel.body || "").slice(0, 1800));
  }
  return line || extractLine(rel);
}

async function scanGithub(st) {
  let found = 0;
  for (const repo of cfg.repos) {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=5`;
    let r;
    try { r = await getJson(url, { etag: st.etags[repo] || "", headers: { accept: "application/vnd.github+json" } }); }
    catch (e) { log(`updates: github ${repo}: ${e.message}`); continue; }
    if (r.notModified) continue;
    if (r.etag) st.etags[repo] = r.etag;
    const first = !st.releases.some((x) => x.repo === repo);
    let newsOnFirst = 0;
    for (const rel of (Array.isArray(r.data) ? r.data : [])) { // GitHub lists newest first
      if (rel.draft) continue;
      const tag = rel.tag_name || rel.name;
      if (!tag || st.releases.some((x) => x.repo === repo && x.tag === tag)) continue;
      const entry = {
        repo, tag, name: rel.name || tag, publishedAt: rel.published_at || rel.created_at, url: rel.html_url || "",
        body: String(rel.body || "").slice(0, 2500), line: "", seenAt: Date.now(), announced: false,
      };
      const ageDays = (Date.now() - new Date(entry.publishedAt)) / 86400_000;
      // first scan: take the history as known, only the newest fresh one becomes news
      const isNews = first ? (ageDays <= cfg.freshDays && newsOnFirst++ === 0) : true;
      entry.line = isNews ? await newsLine(entry) : extractLine(entry);
      st.releases.push(entry);
      if (isNews) {
        found++;
        entry.announced = true;
        journal.note("release", { repo, tag, line: entry.line, publishedAt: entry.publishedAt, url: entry.url });
        log(`updates: NEW ${repo} ${tag} - ${entry.line}`);
      }
    }
  }
  return found;
}

async function scanNpm(st) {
  for (const pkg of cfg.packages) {
    try {
      const r = await getJson(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace("%40", "@")}`, {});
      const latest = r.data?.["dist-tags"]?.latest;
      if (!latest) continue;
      const prev = st.versions[pkg];
      st.versions[pkg] = latest;
      // npm is the fallback announcer: a version GitHub did not show as a release
      if (prev && prev !== latest && !st.releases.some((x) => x.tag.replace(/^v/, "") === latest && new RegExp(pkg.split("/")[1], "i").test(x.repo))) {
        const entry = { repo: `npm:${pkg}`, tag: latest, name: `${pkg} ${latest}`, publishedAt: r.data.time?.[latest] || new Date().toISOString(), url: `https://www.npmjs.com/package/${pkg}`, body: "", line: `${pkg} ${latest} is on npm.`, seenAt: Date.now(), announced: true };
        st.releases.push(entry);
        journal.note("release", { repo: entry.repo, tag: latest, line: entry.line, publishedAt: entry.publishedAt, url: entry.url });
        log(`updates: NEW on npm ${pkg} ${latest}`);
      }
    } catch (e) { log(`updates: npm ${pkg}: ${e.message}`); }
  }
}

/**
 * Scan the sources if the interval is up. Returns the number of new releases.
 * Called from tick(); cheap between scans (one timestamp compare).
 */
export async function scan({ force = false } = {}) {
  if (!cfg.everyMs && !force) return 0;
  const st = load();
  if (!force && Date.now() - st.lastScan < cfg.everyMs) return 0;
  st.lastScan = Date.now();
  save();
  let found = 0;
  try { found = await scanGithub(st); } catch (e) { log("updates: github scan failed:", e.message); }
  try { await scanNpm(st); } catch (e) { log("updates: npm scan failed:", e.message); }
  save();
  return found;
}

/** Releases still fresh enough to be news, newest first. */
export function fresh(days = cfg.freshDays) {
  const st = load();
  const since = Date.now() - days * 86400_000;
  return st.releases.filter((r) => new Date(r.publishedAt).getTime() >= since && r.announced);
}

/** Newest release of a project, fresh or not. */
export function latestOf(project) {
  const st = load();
  return st.releases.find((r) => new RegExp(project, "i").test(r.repo)) || null;
}

export function versions() { return { ...load().versions }; }

const ago = (iso) => {
  const day = (x) => Math.floor(new Date(x).getTime() / 86400_000);
  const d = day(Date.now()) - day(iso);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/** Prompt block: what shipped recently (for replies, openers, shouts). Empty string when nothing is fresh. */
export function newsBrief(max = 3) {
  const list = fresh().slice(0, max);
  if (!list.length) return "";
  return list.map((r) => `- ${repoName(r.repo)} ${r.tag.replace(/^v/, "")} (${ago(r.publishedAt)}): ${r.line}`).join("\n");
}

/** One spoken line about the newest fresh release (rule engine), or "" when there is none. */
export function newsLineSpoken() {
  const r = fresh()[0];
  if (!r) return "";
  return `${r.line} Release notes are on ${HANDLE}.`;
}

/** `life.mjs news`: releases at a glance. */
export function describe() {
  const st = load();
  const lines = [
    `last scan ${st.lastScan ? new Date(st.lastScan).toISOString().slice(0, 16) : "never"} · every ${cfg.everyMs / 60_000} min · versions ${Object.entries(st.versions).map(([k, v]) => `${k}@${v}`).join(", ") || "-"}`,
  ];
  for (const r of st.releases.slice(0, 12)) {
    lines.push(`  ${String(r.publishedAt).slice(0, 10)} ${r.repo.padEnd(18)} ${r.tag.padEnd(14)} ${r.announced ? "news " : "known"} ${r.line}`);
  }
  return lines.join("\n");
}
