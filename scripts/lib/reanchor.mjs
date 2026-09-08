/**
 * Re-anchor what failed because NIGHTGATE (or the network) was down.
 *
 *   life.mjs anchors failed              # what failed, grouped by what can be done about it
 *   life.mjs anchors retry [--dry-run]   # queue the re-anchors (and today's daily proof set)
 *
 * Failed entries in data/attestations.json fall into four groups:
 *   - plain mini-doc attests (batch, meeting, pulse, contract, ...): re-queued
 *     as a fresh `attest` with the same payloadHash + metadataHash. Entries the
 *     old worker recorded without a metadataHash get it rebuilt from the
 *     schema envelope (v, agentId, kind, date - the date comes from the doc,
 *     else from the failure time). The new queue item carries
 *     `meta.reanchorOf = <failed entry's at>`; when it lands, record() flags the
 *     failed entry `reanchored` (dashboard: "re-anchored later").
 *   - today's daily report set (report, root, zk claims, diff): repaired by the
 *     idempotent daily run (`attest-report.mjs reports/<today>.md`), which
 *     reuses the doc proof and re-queues only what is missing. Past days'
 *     sets cannot be redone (the daily run works on today's window).
 *   - prediction commits/reveals: retried only while their commitment window
 *     is open (nonce/expiry from predictions.json), else listed as lost.
 *   - anything already on chain (the failure was recorded after the tx went
 *     through, or a later attempt landed): closed with a `deduped` ok entry.
 *
 * Nothing here talks to the chain on its own: the queue and the anchor worker
 * do, so the daily cap and the serial-tx rule still apply.
 */

import fs from "node:fs";
import path from "node:path";
import { log, rootDir } from "./mc.mjs";
import * as ng from "./nightgate.mjs";
import * as journal from "./journal.mjs";
import { SCHEMAS, SCHEMA_VERSION } from "./schemas.mjs";

const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const isReportKind = (k) => k === "report" || k === "report-root" || k === "report-diff" || !!k?.startsWith("predicate:");
const isPredictionKind = (k) => k === "prediction-commit" || k === "prediction-reveal";

/** metadataHash of a mini-doc attest: same envelope canonical() hashes (docs/SCHEMAS.md). */
export function metadataHashFor(entry) {
  if (entry.metadataHash) return { metadataHash: entry.metadataHash, assumed: false };
  const date = entry.doc?.date || dayOf(entry.at);
  const agentId = entry.doc?.agentId || ng.AGENT_ID;
  const meta = { v: SCHEMA_VERSION, agentId, kind: entry.kind, date };
  return { metadataHash: ng.sha256hex(JSON.stringify(meta)), assumed: !entry.doc?.date, date };
}

/**
 * Sort the failed entries into what to do. Pure (reads the log + queue only).
 * { candidates, onChainAlready, queuedAlready, reportDates, notRetried, reportRerun }
 */
export function plan({ sinceMs = 0, cfg = ng.config() } = {}) {
  const all = ng.history();
  const okAttest = new Set(all.filter((a) => a.ok && a.payloadHash && (a.call === "attest" || a.call === "attestReveal")).map((a) => a.payloadHash));
  const okByKindDate = new Set(all.filter((a) => a.ok).map((a) => `${a.kind}|${a.date}`));
  const okCommit = new Set(all.filter((a) => a.ok && a.commitment).map((a) => a.commitment));
  const queueItems = ng.readQueue();
  const queued = new Set(queueItems.map((q) => q.params?.payloadHash).filter(Boolean));
  const queuedCommit = new Set(queueItems.map((q) => q.params?.commitment).filter(Boolean));
  let preds = [];
  try { preds = JSON.parse(fs.readFileSync(ng.predictionsFile, "utf8")); } catch { /* none */ }
  const seen = new Set();
  const out = { candidates: [], onChainAlready: [], queuedAlready: [], reportDates: new Map(), notRetried: [], reportRerun: null };

  for (const a of all) {
    if (a.ok || a.at < sinceMs || a.reanchored) continue;
    if (isReportKind(a.kind)) {
      // the set is repaired as a whole; note which kinds of that day are still missing
      const date = a.date || dayOf(a.at);
      if (okByKindDate.has(`${a.kind}|${date}`)) continue;
      const set = out.reportDates.get(date) || new Set();
      set.add(a.kind);
      out.reportDates.set(date, set);
      continue;
    }
    if (isPredictionKind(a.kind) || a.call === "attestCommit" || a.call === "attestReveal") {
      const c = predictionRetry(a, preds, okAttest, okCommit, queuedCommit, cfg);
      if (c === null) continue; // already made good
      if (typeof c === "string") { out.notRetried.push({ entry: a, reason: c }); continue; }
      if (seen.has(c.key)) { out.queuedAlready.push(a); continue; }
      seen.add(c.key);
      out.candidates.push(c);
      continue;
    }
    if (a.call !== "attest" || !a.payloadHash) {
      out.notRetried.push({ entry: a, reason: `no re-anchor path for call ${a.call || "?"}` });
      continue;
    }
    if (!SCHEMAS[a.kind]) {
      out.notRetried.push({ entry: a, reason: `no mini-doc schema for kind ${a.kind} (nothing worth re-anchoring)` });
      continue;
    }
    if (okAttest.has(a.payloadHash)) { out.onChainAlready.push(a); continue; }
    if (queued.has(a.payloadHash) || seen.has(a.payloadHash)) { out.queuedAlready.push(a); continue; }
    seen.add(a.payloadHash);
    const m = metadataHashFor(a);
    out.candidates.push({
      entry: a, kind: a.kind, call: "attest", key: a.payloadHash,
      params: { payloadHash: a.payloadHash, metadataHash: m.metadataHash },
      metaAssumed: m.assumed, doc: a.doc || null,
    });
  }

  // the daily run can only repair TODAY's set (it works on today's window)
  const t = today();
  if (out.reportDates.has(t)) {
    const file = path.join(rootDir, "reports", `${t}.md`);
    out.reportRerun = fs.existsSync(file) ? { date: t, file, missing: [...out.reportDates.get(t)] } : null;
    if (!out.reportRerun) out.notRetried.push({ entry: { kind: "report", at: Date.now(), error: "" }, reason: `no ${path.relative(rootDir, file)} to re-run the daily proof set from` });
  }
  for (const [date, kinds] of out.reportDates) {
    if (date === t) continue;
    out.notRetried.push({ entry: { kind: [...kinds].join("+"), at: Date.parse(date), error: "" }, reason: `daily proof set of ${date} - only today's set can be redone (life.mjs attest)` });
  }
  return out;
}

/**
 * A failed prediction commit/reveal is worth retrying while its commitment
 * window is open (lineage 3: a commit expires; the reveal must hit the vault
 * the commit landed on). predictions.json holds the nonce and expiry.
 * Returns a candidate, a reason string (not retried) or null (already fine).
 */
function predictionRetry(a, preds, okAttest, okCommit, queuedCommit, cfg) {
  const nowS = Math.floor(Date.now() / 1000);
  if (a.call === "attestReveal" || a.kind === "prediction-reveal") {
    const p = preds.find((x) => x.payloadHash && x.payloadHash === a.payloadHash);
    if (!p) return "prediction reveal without a matching entry in predictions.json";
    if (okAttest.has(p.payloadHash)) return null;
    if (p.voided) return `prediction ${p.date} is voided (${p.voided.slice(0, 50)})`;
    if (p.vault && p.vault !== cfg.vault) return `prediction ${p.date} was committed on vault ${ng.shortHash(p.vault)} (previous lineage)`;
    if (p.expiresAt && nowS >= p.expiresAt - 600) return `prediction ${p.date}: commitment expired ${new Date(p.expiresAt * 1000).toISOString()} - reveal impossible`;
    if (!okCommit.has(p.commitment)) return `prediction ${p.date}: its commit never landed - nothing to reveal against`;
    return {
      entry: a, kind: "prediction-reveal", call: "attestReveal", key: p.payloadHash,
      params: { payloadHash: p.payloadHash, metadataHash: p.metadataHash, nonce: p.nonce },
      doc: p.prediction, vault: p.vault, metaExtra: { kind: "prediction", date: p.date },
      note: `reveal of the ${p.date} prediction, window open until ${new Date(p.expiresAt * 1000).toISOString().slice(0, 16)}`,
    };
  }
  const p = preds.find((x) => x.commitment && x.commitment === a.commitment);
  if (!p) return "prediction commit without a matching entry in predictions.json";
  if (okCommit.has(p.commitment)) return null;
  if (queuedCommit.has(p.commitment)) return "commit already queued";
  if (p.voided) return `prediction ${p.date} is voided`;
  if (p.vault && p.vault !== cfg.vault) return `prediction ${p.date} belongs to vault ${ng.shortHash(p.vault)} (previous lineage)`;
  // the commit only makes sense while the reveal (next morning) can still follow
  if (p.expiresAt && nowS >= p.expiresAt - 6 * 3600) return `prediction ${p.date}: commitment window (until ${new Date(p.expiresAt * 1000).toISOString()}) too short for a reveal tomorrow`;
  return {
    entry: a, kind: "prediction-commit", call: "attestCommit", key: p.commitment,
    params: { commitment: p.commitment, expiresAt: p.expiresAt }, metaExtra: { date: p.date },
    note: `commit of the ${p.date} prediction (still hidden; the reveal tomorrow proves it was made before the outcome)`,
  };
}

const short = (h) => ng.shortHash(h);
const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Human-readable plan. */
export function describe(p = plan()) {
  const lines = [];
  lines.push(`re-anchor plan (${p.candidates.length} to queue, ${p.onChainAlready.length} already on chain, ${p.queuedAlready.length} already queued, ${p.notRetried.length} not retried)`);
  for (const c of p.candidates) {
    lines.push(`  queue   ${when(c.entry.at)}  ${c.kind.padEnd(14)} ${short(c.key)}  ${c.note || `${c.doc ? "doc" : "no doc"}${c.metaAssumed ? ", meta date assumed" : ""}`}  <- ${(c.entry.error || "?").slice(0, 70)}`);
  }
  if (p.reportRerun) lines.push(`  rerun   daily proof set ${p.reportRerun.date} (${p.reportRerun.missing.join(", ")} missing) via attest-report ${path.relative(rootDir, p.reportRerun.file)}`);
  for (const a of p.onChainAlready) lines.push(`  onchain ${when(a.at)}  ${a.kind.padEnd(14)} ${short(a.payloadHash)}  (a later attempt landed)`);
  for (const a of p.queuedAlready) lines.push(`  queued  ${when(a.at)}  ${a.kind.padEnd(14)} ${short(a.payloadHash)}`);
  for (const n of p.notRetried) lines.push(`  skip    ${when(n.entry.at)}  ${String(n.entry.kind).padEnd(14)} ${n.reason}${n.entry.error ? ` <- ${n.entry.error.slice(0, 60)}` : ""}`);
  return lines.join("\n");
}

/**
 * Queue the re-anchors. `verify` asks NIGHTGATE first whether the payload is
 * on chain after all (closes those with a deduped ok entry instead of a new
 * tx). Returns counts; the worker / daily child does the anchoring afterwards.
 */
export async function run({ dryRun = false, sinceMs = 0, verify = true } = {}) {
  const cfg = ng.config();
  const p = plan({ sinceMs, cfg });
  console.log(describe(p));
  if (dryRun) { console.log("\n(dry run - nothing queued)"); return { dryRun: true, ...counts(p) }; }
  if (!cfg.enabled) throw new Error("nightgate not configured (NIGHTGATE_ATTEST / SEED_HEX / TOKEN)");

  let queued = 0, closed = 0, capped = 0;
  const flagged = [];
  for (const c of p.candidates) {
    // maybe on chain after all (the failure was recorded after the tx went through)
    if (verify && c.params.payloadHash) {
      try {
        const v = await ng.verifyAttestation(c.params.payloadHash, cfg, c.vault || cfg.vault);
        if (v?.attested) {
          ng.record({
            ok: true, deduped: true, kind: c.kind, call: c.call, date: today(),
            payloadHash: c.params.payloadHash, metadataHash: c.params.metadataHash, ...(c.doc ? { doc: c.doc } : {}),
            network: cfg.network, vault: c.vault || cfg.vault, verified: true, reanchorOf: c.entry.at,
          });
          log(`${c.kind} ${short(c.key)}: already on chain - closed without a new tx`);
          closed += 1;
          continue;
        }
      } catch (e) { log(`${c.kind} ${short(c.key)}: verify unavailable (${e.message.slice(0, 60)}) - queuing anyway, the worker dedupes`); }
    }
    const id = ng.enqueue({
      kind: c.kind, call: c.call, params: c.params,
      ...(c.doc ? { doc: c.doc } : {}),
      ...(c.vault ? { vault: c.vault } : {}),
      meta: { ...(c.metaExtra || {}), reanchorOf: c.entry.at, reanchorReason: (c.entry.error || "").slice(0, 120), ...(c.metaAssumed ? { metaDateAssumed: true } : {}) },
    }, { kick: false });
    if (!id) { capped += 1; continue; }
    queued += 1;
    flagged.push(c.entry.at);
  }
  if (flagged.length) {
    const now = Date.now();
    const set = new Set(flagged);
    ng.updateHistory((a) => (!a.ok && set.has(a.at) ? { ...a, reanchorQueued: now } : null));
  }
  try { journal.note("reanchor", { queued, closed, capped, reportRerun: p.reportRerun?.date || null }); } catch { /* optional */ }

  if (p.reportRerun) {
    // the daily child re-queues the missing report items, then drains everything
    // (it steps aside when a worker is already running - the items stay queued)
    ng.attestReportAsync(p.reportRerun.file);
    console.log(`\ndaily proof set ${p.reportRerun.date}: re-run started (${p.reportRerun.missing.join(", ")})`);
  } else if (queued) {
    ng.kickWorker();
  }
  console.log(`\nqueued ${queued} re-anchor(s), closed ${closed} already on chain${capped ? `, ${capped} over the daily cap (${cfg.maxAnchorsPerDay}) - run again tomorrow` : ""}; ${ng.readQueue().length} item(s) in the queue, worker ${ng.workerActive() ? "running" : "starting"}`);
  return { queued, closed, capped, ...counts(p) };
}

const counts = (p) => ({ candidates: p.candidates.length, onChainAlready: p.onChainAlready.length, queuedAlready: p.queuedAlready.length, notRetried: p.notRetried.length, reportRerun: p.reportRerun?.date || null });
