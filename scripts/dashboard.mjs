#!/usr/bin/env node
/**
 * M₳X Proof Ledger - a self-contained public dashboard of everything M₳X
 * anchored on Midnight, in the NIGHTPASS/NIGHTGATE explorer design language
 * (same tokens and components as the zkpassport.eu explorer: dark
 * block-explorer surfaces, periwinkle accent, serif-italic editorial accent,
 * status chips that always pair color with a text label).
 *
 *   node scripts/dashboard.mjs [outFile]      # default reports/dashboard.html
 *   node scripts/dashboard.mjs --body-only    # inner HTML without the <html> shell
 *
 * Regenerated automatically at the end of every daily proof run
 * (attest-report.mjs). Static, no backend: verification data is baked in at
 * generation time; the footer shows how to re-check any hash via NIGHTGATE.
 */

import fs from "node:fs";
import path from "node:path";
import { rootDir, log } from "./lib/mc.mjs";
import * as ng from "./lib/nightgate.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtN = (n) => Number(n ?? 0).toLocaleString("en-US");

const KIND_LABEL = {
  report: "daily report", "report-root": "content root", batch: "batch", meeting: "conversation",
  explore: "exploration", notary: "notary", "prediction-commit": "prediction commit",
  "prediction-reveal": "prediction reveal", "grant-test": "system check",
  pulse: "hourly pulse", meal: "meal", sleep: "sleep", "report-diff": "zk claim: reports differ",
  contract: "contract delivered", levelup: "level up", tool: "tool secured", quest: "contract run", craft: "crafted", "notary-paid": "notary (paid)",
};
const kindLabel = (k) => KIND_LABEL[k] || (k?.startsWith("predicate:") ? `zk claim: ${k.slice(10)}` : k || "attest");

function collect() {
  const cfg = ng.config();
  const all = ng.history();          // last 500 entries: the timeline
  const st = ng.stats();             // lifetime counters (attestations.json is capped)
  const ok = all.filter((a) => a.ok);
  const today = new Date().toISOString().slice(0, 10);
  // a failed entry is "made good" when its own re-anchor landed (record() flags
  // it) OR a later ok entry of the same kind covers the same payload / day -
  // e.g. the daily re-run after an outage, or a second attempt after a 502
  const okKeys = new Set(ok.flatMap((a) => [a.payloadHash ? `${a.kind}|${a.payloadHash}` : null, a.commitment ? `${a.kind}|${a.commitment}` : null, a.kind === "report-diff" ? `${a.kind}|${a.date}` : null].filter(Boolean)));
  const madeGoodAt = (a) => {
    if (a.reanchored) return a.reanchored;
    const key = a.payloadHash ? `${a.kind}|${a.payloadHash}` : a.commitment ? `${a.kind}|${a.commitment}` : a.kind === "report-diff" ? `${a.kind}|${a.date}` : null;
    if (!key || !okKeys.has(key)) return null;
    // the covering entry is usually later; a failed duplicate attempt after a success counts as made good too
    const o = ok.find((x) => x.kind === a.kind && ((a.payloadHash && x.payloadHash === a.payloadHash) || (a.commitment && x.commitment === a.commitment) || (a.kind === "report-diff" && x.date === a.date)));
    return o?.at || null;
  };
  for (const a of all) if (!a.ok) { const t = madeGoodAt(a); if (t) a.madeGood = t; }
  const failedInLog = all.filter((a) => !a.ok);
  const byKind = {};
  for (const [k, n] of Object.entries(st.byKind)) byKind[kindLabel(k)] = (byKind[kindLabel(k)] || 0) + n;
  let preds = [];
  try { preds = JSON.parse(fs.readFileSync(ng.predictionsFile, "utf8")); } catch { /* none yet */ }
  const predicate = [...ok].reverse().find((a) => a.call === "proveFieldPredicate" && a.kind === "predicate:crystal");
  return {
    generatedAt: new Date().toISOString(),
    network: cfg.network, vault: cfg.vault, artifact: cfg.artifact,
    attesterId: ok.at(-1)?.attesterId || "",
    total: st.ok, todays: ok.filter((a) => a.date === today).length,
    failed: st.failed,
    feeWasted: st.feeWasted || 0,
    skipped: st.skipped || 0,
    // the lifetime counters only know entries written since 2026-09-08; the
    // capped log is a floor for both numbers
    apiOutage: Math.max(st.apiOutage || 0, failedInLog.filter((a) => ng.isOutageEntry(a)).length),
    reanchored: Math.max(st.reanchored || 0, failedInLog.filter((a) => a.madeGood).length),
    reanchorQueued: failedInLog.filter((a) => a.reanchorQueued && !a.madeGood).length,
    notarized: (st.byKind.notary || 0) + (st.byKind["notary-paid"] || 0),
    byKind,
    milestone: predicate ? { threshold: predicate.threshold, date: predicate.date } : null,
    score: ng.scoreboard(),
    predictions: preds.filter((p) => p.revealed || p.date < today).slice(-30).reverse(),
    committedToday: preds.some((p) => p.date === today),
    anchors: [...all].slice(-200).reverse(),
    // earlier vaults (lineage migrations): their anchors stay verifiable there
    previousVaults: Object.entries(ok.reduce((m, a) => { if (a.vault && a.vault !== cfg.vault) m[a.vault] = (m[a.vault] || 0) + 1; return m; }, {}))
      .sort((x, y) => y[1] - x[1]).map(([vault, n]) => ({ vault, n })),
  };
}

let d = null;

function hero() {
  const ring = 2 * Math.PI * 120;
  const frac = Math.min(1, d.todays / 200);
  return `
  <section class="hero">
    <div class="hero-copy">
      <h1>An agent that <em>proves</em> its day</h1>
      <p class="hero-sub">M&#8371;X is an AI agent living in Midnight City. Every batch he sells,
      every conversation, every claim he makes goes on the Midnight chain as a
      NIGHTGATE attestation &mdash; built, proven and signed locally with his own
      attester key, then submitted fee-unpaid through the NIGHTGATE API's
      cross-server fee sponsoring: a scoped, budgeted sponsor grant pays the
      DUST.</p>
      <p class="hero-id mono">attester ${esc(ng.shortHash(d.attesterId))} &middot; ${esc(d.artifact)} &middot; midnight ${esc(d.network)}<br>
      vault <a href="https://${esc(d.network)}.midnightexplorer.com/contracts/0x${esc(d.vault)}" target="_blank" rel="noopener">${esc(d.vault)}</a>${d.previousVaults.length
        ? `<br><span class="sub2">earlier proofs live on ${d.previousVaults.map((p) => `<a href="https://${esc(d.network)}.midnightexplorer.com/contracts/0x${esc(p.vault)}" target="_blank" rel="noopener" title="${esc(p.vault)}">${esc(ng.shortHash(p.vault))}</a>`).join(", ")} (vault lineage migrations; still verifiable there)</span>`
        : ""}</p>
    </div>
    <div class="hero-ring" role="img" aria-label="${fmtN(d.total)} proofs anchored">
      <svg class="ring-svg" viewBox="0 0 280 280">
        <g class="ring-ticks">${Array.from({ length: 60 }, (_, i) => {
          const a = (i / 60) * 2 * Math.PI;
          const x1 = 140 + Math.cos(a) * 132, y1 = 140 + Math.sin(a) * 132;
          const x2 = 140 + Math.cos(a) * (i % 5 ? 137 : 139), y2 = 140 + Math.sin(a) * (i % 5 ? 137 : 139);
          return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
        }).join("")}</g>
        <circle class="ring-track" cx="140" cy="140" r="120"/>
        <circle class="ring-arc" cx="140" cy="140" r="120" stroke-dasharray="${(ring * frac).toFixed(1)} ${ring.toFixed(1)}"/>
      </svg>
      <div class="ring-center">
        <div class="ring-count">${fmtN(d.total)}</div>
        <div class="ring-label">proofs anchored</div>
        <div class="ring-today">${fmtN(d.todays)} today</div>
      </div>
    </div>
  </section>`;
}

function stats() {
  return `
  <section class="stats">
    <div class="stat"><div class="label">zero-knowledge milestone</div>
      <div class="value">${d.milestone ? `crystal &ge; ${fmtN(d.milestone.threshold)}` : "&mdash;"}</div>
      <div class="hint">${d.milestone ? "proven on chain - the real balance stays hidden" : "first zk claim pending"}</div></div>
    <div class="stat"><div class="label">predictions</div>
      <div class="value">${d.score ? `${d.score.within10}/${d.score.evaluated} <span class="dim-inline">within 10%</span>` : d.committedToday ? "1 committed" : "&mdash;"}</div>
      <div class="hint">${d.score ? `avg error ${d.score.avgErrorPct}% - every call committed before the day` : "hidden until tomorrow's reveal"}</div></div>
    <div class="stat"><div class="label">notary service</div>
      <div class="value">${fmtN(d.notarized)}</div>
      <div class="hint">claims of other agents anchored, free of charge</div></div>
    <div class="stat"><div class="label">anchor mix</div>
      <div class="value">${fmtN(Object.keys(d.byKind).length)} <span class="dim-inline">kinds</span></div>
      <div class="hint">${esc(Object.entries(d.byKind).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`).join(" · "))}${d.failed ? ` · ${fmtN(d.failed)} failed${d.apiOutage ? ` (${fmtN(d.apiOutage)} while the NIGHTGATE API was down)` : ""}${d.feeWasted ? ` (${fmtN(d.feeWasted)} refused on chain, fee burned)` : ""}${d.skipped ? ` (${fmtN(d.skipped)} skipped after a failed prerequisite)` : ""}${d.reanchored ? ` · ${fmtN(d.reanchored)} re-anchored later` : ""}${d.reanchorQueued ? ` · ${fmtN(d.reanchorQueued)} re-anchor queued` : ""}` : ""}</div></div>
  </section>`;
}

function scoreboard() {
  if (!d.predictions.length) return "";
  const rows = d.predictions.map((p) => {
    const evald = typeof p.actual === "number";
    const err = evald && p.errorPct != null ? `${p.errorPct > 0 ? "+" : ""}${p.errorPct}%` : "&mdash;";
    const cls = !evald ? "" : Math.abs(p.errorPct) <= 10 ? "ok" : Math.abs(p.errorPct) <= 25 ? "warn" : "err";
    return `<tr>
      <td>${esc(p.date)}</td>
      <td class="num">${p.revealed ? fmtN(p.prediction?.predictedCoins) : p.voided ? `<span class="chip failed" title="${esc(p.voided)}">voided</span>` : '<span class="chip anchoring">committed &middot; hidden</span>'}</td>
      <td class="num">${evald ? fmtN(p.actual) : "&mdash;"}</td>
      <td class="num"><span class="vstate ${cls}">${err}</span></td>
      <td class="mono hash" data-full="${esc(p.commitment)}" title="click to copy">${esc(ng.shortHash(p.commitment))}</td>
    </tr>`;
  }).join("");
  return `
  <section class="panel">
    <div class="panel-head"><h2>Prediction scoreboard</h2>
      <span class="sub-note">committed each morning via <span class="mono">attestGuarded</span>, revealed the next day &mdash; provably called <em>before</em> the outcome</span></div>
    <div class="table-wrap"><table data-page-size="20">
      <thead><tr><th>day</th><th class="num">predicted coins</th><th class="num">actual</th><th class="num">error</th><th>commitment</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

const relTime = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/** Status cell of a failed entry: what went wrong, and whether it was made good later. */
function failedCell(a) {
  const outage = ng.isOutageEntry(a);
  const why = a.feeWasted ? "refused on chain, fee burned" : a.skipped ? "skipped, prerequisite failed" : outage ? "failed, NIGHTGATE API down" : "failed";
  if (a.madeGood) {
    return `<span class="chip reanchored" title="${esc(`${why}: ${a.error || ""}`)} - re-anchored ${esc(new Date(a.madeGood).toISOString().slice(0, 16).replace("T", " "))} UTC">re-anchored later</span> <span class="sub2">${esc(why)}</span>`;
  }
  return `<span class="chip failed" title="${esc(a.error || "")}">${esc(why)}</span>${a.reanchorQueued ? ` <span class="sub2" title="a fresh anchor of the same payload is in the queue">re-anchor queued</span>` : ""}`;
}

function timeline() {
  const rows = d.anchors.map((a) => {
    const hash = a.payloadHash || a.commitment || "";
    return `<tr>
      <td class="mono sub2" data-ts="${a.at}" title="${esc(new Date(a.at).toISOString().slice(0, 16).replace("T", " "))} UTC">${esc(relTime(a.at))}</td>
      <td><span class="kind">${esc(kindLabel(a.kind))}</span>${a.vault && a.vault !== d.vault ? ` <span class="sub2" title="anchored on an earlier vault ${esc(a.vault)}">vault ${esc(ng.shortHash(a.vault).slice(0, 8))}</span>` : ""}</td>
      <td class="mono hash" data-full="${esc(hash)}" title="click to copy the full hash">${esc(ng.shortHash(hash))}</td>
      <td>${a.ok
        ? `<span class="chip anchored">${a.verified ? "verified" : "anchored"}</span>${a.rebuilt ? ` <span class="sub2" title="first attempt refused on chain, rebuilt against fresh state">rebuilt</span>` : ""}${a.lateLanded ? ` <span class="sub2" title="the sponsor's submit watch timed out; the worker kept probing the indexer until the tx showed up">landed late</span>` : ""}${a.repaired ? ` <span class="sub2" title="${esc(`the worker had written this off (${a.repairedFrom?.error || "?"}); its NIGHTGATE job had succeeded - recorded ${new Date(a.repaired).toISOString().slice(0, 16).replace("T", " ")} UTC`)}">recorded later</span>` : ""}${a.batchOf ? ` <span class="sub2">batch of ${a.batchOf}</span>` : ""}${a.reanchorOf ? ` <span class="sub2" title="replaces the attempt that failed ${esc(new Date(a.reanchorOf).toISOString().slice(0, 16).replace("T", " "))} UTC${a.deduped ? " (it had reached the chain after all)" : ""}">re-anchor</span>` : ""}`
        : failedCell(a)}</td>
      <td class="mono sub2">${a.txExplorerHash
        ? `<a href="https://${esc(d.network)}.midnightexplorer.com/transactions/0x${esc(a.txExplorerHash)}" target="_blank" rel="noopener" title="${esc(a.txExplorerHash)}">${esc(ng.shortHash(a.txExplorerHash))}</a>`
        : a.txHash ? esc(ng.shortHash(a.txHash)) : "&mdash;"}</td>
    </tr>`;
  }).join("");
  return `
  <section class="panel">
    <div class="panel-head"><h2>Anchor timeline</h2><span class="sub-note">last ${d.anchors.length} entries</span></div>
    <div class="table-wrap"><table data-page-size="20">
      <thead><tr><th>when</th><th>what</th><th>payload sha256</th><th>status</th><th>tx</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

export function renderBody() {
  if (!d) d = collect();
  return `
<style>
  :root {
    --bg:      #0e0f13;
    --panel:   #16181f;
    --panel-2: #1b1e27;
    --border:  #262a35;
    --ink:     #e8eaf0;
    --ink-2:   #9aa1b2;
    --ink-3:   #6b7280;
    --accent:  #7aa2ff;
    --accent-2:#4f6ef7;
    --good:    #0ca30c;
    --warning: #fab219;
    --critical:#d03b3b;
    --mono: ui-monospace, "Cascadia Code", "Consolas", "SF Mono", Menlo, monospace;
    --sans: ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --serif: "Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 15px; line-height: 1.5; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .mono { font-family: var(--mono); }

  .site-header { display: flex; align-items: center; gap: 16px; padding: 14px 24px; border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, #14161d, #101218); flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand-mark { width: 26px; height: 26px; border-radius: 50%;
    background: radial-gradient(circle at 50% 50%, transparent 0 5px, var(--accent) 5px 8px, transparent 8px),
                radial-gradient(circle at 30% 30%, #2b3350, #101218);
    border: 1px solid var(--border); }
  .brand-name { font-weight: 700; letter-spacing: 0.04em; }
  .brand-sub { display: block; font-size: 11px; font-weight: 500; color: var(--ink-2); letter-spacing: 0.08em; text-transform: uppercase; }
  .header-spacer { flex: 1; }
  .net-badge { font-family: var(--mono); font-size: 12px; color: var(--accent); border: 1px solid var(--accent-2);
    border-radius: 999px; padding: 3px 12px; white-space: nowrap; }

  .container { max-width: 1100px; margin: 0 auto; padding: 24px; display: flex; flex-direction: column; gap: 20px; }

  .hero { display: grid; grid-template-columns: 1.4fr 1fr; align-items: center; gap: 32px; padding: 28px 8px 20px; }
  @media (max-width: 860px) { .hero { grid-template-columns: 1fr; padding: 16px 4px 8px; } }
  .hero-copy h1 { margin: 0 0 14px; font-size: clamp(32px, 5vw, 48px); line-height: 1.08; letter-spacing: -0.02em; font-weight: 800; }
  .hero-copy h1 em { font-family: var(--serif); font-style: italic; font-weight: 500; color: var(--accent); }
  .hero-sub { color: var(--ink-2); font-size: 16px; max-width: 52ch; margin: 0; }
  .hero-id { margin: 14px 0 0; font-size: 12px; color: var(--ink-3); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; line-height: 1.7; }

  .hero-ring { position: relative; width: 260px; height: 260px; justify-self: center; }
  .ring-svg { width: 100%; height: 100%; display: block; }
  .ring-ticks { stroke: var(--ink-3); stroke-width: 1.5; opacity: 0.55; transform-origin: 140px 140px; animation: ringSpin 90s linear infinite; }
  .ring-track { fill: none; stroke: var(--border); stroke-width: 6; }
  .ring-arc { fill: none; stroke: var(--accent-2); stroke-width: 6; stroke-linecap: round;
    transform: rotate(-90deg); transform-origin: 140px 140px;
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent-2) 60%, transparent)); }
  .ring-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; }
  .ring-count { font-size: 52px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
  .ring-label { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); }
  .ring-today { font-family: var(--mono); font-size: 12px; color: var(--accent); }
  @keyframes ringSpin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .ring-ticks { animation: none; } }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
  .stat { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  .stat .label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); }
  .stat .value { font-size: 24px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .stat .hint { font-size: 12px; color: var(--ink-3); margin-top: 2px; }
  .dim-inline { color: var(--ink-2); font-size: 15px; font-weight: 500; }

  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
    padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .panel-head h2 { margin: 0; font-size: 16px; }
  .sub-note { font-size: 12.5px; color: var(--ink-3); }
  .sub-note em { font-family: var(--serif); color: var(--ink-2); }

  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 14px; white-space: nowrap; }
  thead th { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); font-weight: 600;
    border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--panel); }
  tbody tr { border-bottom: 1px solid #1d212b; }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:hover { background: var(--panel-2); }
  td.mono { font-size: 13px; }
  .sub2 { color: var(--ink-3); font-size: 12.5px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  .kind { font-size: 12.5px; color: var(--ink-2); }

  .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
    border-radius: 999px; padding: 2px 10px; border: 1px solid var(--border); color: var(--ink-2); }
  .chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); }
  .chip.anchored { color: var(--good); border-color: color-mix(in srgb, var(--good) 45%, transparent); }
  .chip.anchored::before { background: var(--good); }
  .chip.anchoring { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 45%, transparent); }
  .chip.anchoring::before { background: var(--warning); }
  .chip.failed { color: var(--critical); border-color: color-mix(in srgb, var(--critical) 45%, transparent); }
  .chip.failed::before { background: var(--critical); }
  .chip.reanchored { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
  .chip.reanchored::before { background: var(--accent); }

  .vstate { font-weight: 600; }
  .vstate.ok { color: var(--good); }
  .vstate.warn { color: var(--warning); }
  .vstate.err { color: var(--critical); }

  .hash { cursor: copy; }
  .hash:hover { color: var(--accent); }
  .hash.copied { color: var(--accent); }

  .pager { display: flex; gap: 6px; padding: 10px 16px; border-top: 1px solid var(--border); flex-wrap: wrap; }
  .page-btn { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; color: var(--ink);
    font-size: 13px; font-weight: 600; padding: 4px 11px; cursor: pointer; }
  .page-btn:hover:not(:disabled) { border-color: var(--accent-2); color: var(--accent); }
  .page-btn.active { background: var(--accent-2); border-color: var(--accent-2); color: #fff; }

  .site-footer { border-top: 1px solid var(--border); color: var(--ink-3); font-size: 13px; padding: 18px 24px; margin-top: 8px; }
  .site-footer .verify-how { max-width: 1100px; margin: 0 auto; }
  .site-footer code { font-family: var(--mono); font-size: 12px; color: var(--ink-2); word-break: break-all; white-space: normal; }
  .site-footer p { margin: 6px 0; }
</style>
<header class="site-header">
  <span class="brand"><span class="brand-mark"></span>
    <span><span class="brand-name">M&#8371;X</span><span class="brand-sub">proof ledger &middot; nightgate</span></span></span>
  <span class="header-spacer"></span>
  <span class="net-badge">midnight ${esc(d.network)}</span>
</header>
<main class="container">
  ${hero()}
  ${stats()}
  ${scoreboard()}
  ${timeline()}
</main>
<footer class="site-footer">
  <div class="verify-how">
    <p><b style="color:var(--ink-2)">Verify any hash yourself</b> against live Midnight contract state (needs any NIGHTGATE token, no wallet):</p>
    <p><code>GET https://api.nightgate.dev/api/v1/nightgate/verifyAttestationState(contractAddress='${esc(d.vault)}',payloadHash='&lt;sha256&gt;',compiledArtifactRef='${esc(d.artifact)}')</code></p>${d.previousVaults.length ? `
    <p class="sub2">For a timeline row tagged with an earlier vault, put that vault's address into <code>contractAddress</code>.</p>` : ""}
    <p>Built on NIGHTGATE &mdash; zero-knowledge attestations on <a href="https://midnight.network">Midnight</a>.
    Sister project: <a href="https://zkpassport.eu">NIGHTPASS</a>. Every anchor was built, proven and signed locally with M&#8371;X's own key and submitted fee-unpaid through cross-server fee sponsoring.</p>
  </div>
</footer>
<script>
  // paginate long tables at data-page-size rows (NIGHTPASS-style page buttons)
  document.querySelectorAll("table[data-page-size]").forEach((tbl) => {
    const size = +tbl.dataset.pageSize;
    const rows = Array.from(tbl.tBodies[0].rows);
    if (rows.length <= size) return;
    const pager = document.createElement("div");
    pager.className = "pager";
    tbl.closest(".panel").appendChild(pager);
    const pages = Math.ceil(rows.length / size);
    let page = 0;
    const render = () => {
      rows.forEach((r, i) => { r.hidden = i < page * size || i >= (page + 1) * size; });
      pager.innerHTML = "";
      for (let p = 0; p < pages; p++) {
        const b = document.createElement("button");
        b.className = "page-btn" + (p === page ? " active" : "");
        b.textContent = p + 1;
        b.disabled = p === page;
        b.addEventListener("click", () => { page = p; render(); });
        pager.appendChild(b);
      }
    };
    render();
  });

  // relative times, recomputed at view time (full timestamp stays in the tooltip)
  const rel = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 48 * 3600) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };
  document.querySelectorAll("[data-ts]").forEach((el) => { el.textContent = rel(+el.dataset.ts); });
  document.addEventListener("click", (e) => {
    const el = e.target.closest(".hash");
    if (!el || !el.dataset.full) return;
    try { navigator.clipboard.writeText(el.dataset.full); } catch {}
    el.classList.add("copied");
    const prev = el.textContent;
    el.textContent = "copied \\u2713";
    setTimeout(() => { el.textContent = prev; el.classList.remove("copied"); }, 900);
  });
</script>`;
}

function main() {
  d = collect();
  const bodyOnly = process.argv.includes("--body-only");
  const out = process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : path.join(rootDir, "reports", bodyOnly ? "dashboard.body.html" : "dashboard.html");
  const inner = `<title>M₳X Proof Ledger</title>\n${renderBody()}`;
  const [head, ...rest] = inner.split("\n</style>");
  const html = bodyOnly ? inner : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:title" content="M₳X Proof Ledger">
<meta property="og:description" content="An AI game agent that proves its day on Midnight - every batch, every conversation, every claim anchored on chain, zero-knowledge included.">
<meta property="og:image" content="https://api.nightgate.dev/max/preview.png">
<meta property="og:url" content="https://api.nightgate.dev/max">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/max/favicon.png">
${head}
</style>
</head>
<body>${rest.join("\n</style>")}
</body>
</html>`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  log(`dashboard written: ${out} (${d.total} anchors)`);
}

main();
