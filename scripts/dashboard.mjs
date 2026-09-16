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
import * as journal from "./lib/journal.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtN = (n) => Number(n ?? 0).toLocaleString("en-US");

const KIND_LABEL = {
  report: "daily report", "report-root": "content root", batch: "batch", meeting: "conversation",
  explore: "exploration", notary: "notary", "prediction-commit": "prediction commit",
  "prediction-reveal": "prediction reveal", "grant-test": "system check",
  pulse: "hourly pulse", meal: "meal", sleep: "sleep", "report-diff": "zk claim: reports differ",
  contract: "contract delivered", levelup: "level up", tool: "tool secured", quest: "contract run", craft: "crafted", "notary-paid": "notary (paid)",
  progress: "daily progress", "progress-root": "progress root", gathers: "gathers",
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
  // 7 x 24 activity grid (UTC) from the journal's attest events - the journal keeps 14 days,
  // attestations.json only the last 500 entries (about two days)
  const DAYS = 7;
  const now = Date.now();
  const dayStart = (ms) => Math.floor(ms / 86400_000) * 86400_000;
  const firstDay = dayStart(now) - (DAYS - 1) * 86400_000;
  const heat = Array.from({ length: DAYS }, (_, i) => ({
    day: new Date(firstDay + i * 86400_000).toISOString().slice(0, 10),
    hours: Array.from({ length: 24 }, () => ({ ok: 0, failed: 0 })),
  }));
  for (const e of journal.since(firstDay)) {
    if (e.type !== "attest" || e.skipped) continue;
    const di = Math.floor((e.at - firstDay) / 86400_000);
    if (di < 0 || di >= DAYS) continue;
    const cell = heat[di].hours[new Date(e.at).getUTCHours()];
    if (e.ok) cell.ok++; else cell.failed++;
  }
  // the latest hourly pulse is public by construction (it is anchored): what M₳X was doing last
  const pulse = [...ok].reverse().find((a) => a.kind === "pulse" && a.doc && typeof a.doc === "object");
  return {
    heat,
    heatMax: Math.max(1, ...heat.flatMap((r) => r.hours.map((h) => h.ok + h.failed))),
    pulse: pulse ? { at: pulse.at, ...pulse.doc, payloadHash: pulse.payloadHash } : null,
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
    anchors: [...all].reverse(), // the whole capped log (500): filtered, sorted and paged in the browser
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
      <div class="hint">${esc(Object.entries(d.byKind).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${fmtN(n)} ${k}`).join(" · "))}</div></div>
  </section>`;
}

/** Activity panel: 7 x 24 anchor heatmap (UTC), the last attested pulse, the anchor mix as bars. */
function activity() {
  const total7 = d.heat.reduce((a, r) => a + r.hours.reduce((x, h) => x + h.ok + h.failed, 0), 0);
  const rows = d.heat.map((r) => {
    const sum = r.hours.reduce((x, h) => x + h.ok + h.failed, 0);
    const failed = r.hours.reduce((x, h) => x + h.failed, 0);
    const cells = r.hours.map((h, hi) => {
      const n = h.ok + h.failed;
      const t = n ? Math.max(0.18, n / d.heatMax) : 0;
      const tip = `${r.day} ${String(hi).padStart(2, "0")}:00–${String(hi).padStart(2, "0")}:59 UTC · ${n} anchor${n === 1 ? "" : "s"}`;
      return `<div class="hcell${n ? "" : " empty"}" style="--t:${t.toFixed(2)}" data-tip="${esc(tip)}" tabindex="0" role="img" aria-label="${esc(tip)}"></div>`;
    }).join("");
    const label = new Date(r.day).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    return `<div class="hlabel" title="${esc(r.day)}">${esc(label)}</div>${cells}<div class="hsum" title="${esc(`${sum} anchors on ${r.day}`)}">${fmtN(sum)}</div>`;
  }).join("");
  const hourTicks = `<div></div>${Array.from({ length: 24 }, (_, h) => `<div class="htick">${h % 6 === 0 ? String(h).padStart(2, "0") : ""}</div>`).join("")}<div></div>`;
  const tableRows = d.heat.map((r) => {
    const sum = r.hours.reduce((x, h) => x + h.ok + h.failed, 0);
    const peak = r.hours.reduce((best, h, i) => (h.ok + h.failed > best.n ? { n: h.ok + h.failed, i } : best), { n: 0, i: 0 });
    return `<tr><td>${esc(r.day)}</td><td class="num">${fmtN(sum)}</td><td class="num">${sum ? `${String(peak.i).padStart(2, "0")}:00 (${peak.n})` : "&mdash;"}</td></tr>`;
  }).join("");

  const p = d.pulse;
  const nowCard = p ? `
      <div class="now-card">
        <div class="label">last attested pulse</div>
        <div class="now-main"><span class="now-mode">${esc(p.mode || "?")}</span> <span class="sub2">at</span> <span class="mono">${esc(p.place || "?")}</span></div>
        <div class="now-facts">
          <span><b>${fmtN(p.crystal)}</b> crystal</span>
          <span><b>${fmtN(p.coins)}</b> coins in the bag</span>
          <span><b>${fmtN(p.hunger)}</b>/100 hunger</span>
        </div>
        <div class="hint">anchored <span data-ts="${p.at}">${esc(relTime(p.at))}</span> &middot; <span class="mono hash" data-full="${esc(p.payloadHash)}" title="click to copy">${esc(ng.shortHash(p.payloadHash))}</span><br>every hour a snapshot like this goes on chain &mdash; open it in the timeline to see the envelope</div>
      </div>` : `
      <div class="now-card"><div class="label">last attested pulse</div><div class="hint">no pulse anchored yet</div></div>`;

  const mix = Object.entries(d.byKind).sort((a, b) => b[1] - a[1]);
  const top = mix.slice(0, 8);
  const rest = mix.slice(8).reduce((a, [, n]) => a + n, 0);
  if (rest) top.push(["other kinds", rest]);
  const mixMax = Math.max(1, ...top.map(([, n]) => n));
  const bars = top.map(([k, n]) => `
        <div class="bar-row" data-tip="${esc(`${fmtN(n)} × ${k}`)}">
          <div class="bar-label">${esc(k)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(100 * n / mixMax).toFixed(1)}%"></div></div>
          <div class="bar-val">${fmtN(n)}</div>
        </div>`).join("");

  return `
  <section class="panel" id="activity">
    <div class="panel-head"><h2>Seven days of anchoring</h2>
      <span class="sub-note">${fmtN(total7)} anchors in the last 7 days &middot; one cell per hour, UTC &middot; hover for the count</span></div>
    <div class="activity-grid">
      <div class="heat-wrap">
        <div class="heat" role="img" aria-label="anchors per hour over the last seven days">${rows}${hourTicks}</div>
        <div class="heat-legend"><span class="hcell empty"></span> none <span class="hcell" style="--t:0.3"></span> few <span class="hcell" style="--t:1"></span> peak ${fmtN(d.heatMax)}/h</div>
        <details class="table-view"><summary>table view</summary>
          <table><thead><tr><th>day (UTC)</th><th class="num">anchors</th><th class="num">busiest hour</th></tr></thead><tbody>${tableRows}</tbody></table>
        </details>
      </div>
      <div class="activity-side">
        ${nowCard}
        <div class="mix-card">
          <div class="label">anchor mix &middot; lifetime</div>
          ${bars}
        </div>
      </div>
    </div>
  </section>`;
}

/** Predicted vs actual coins per evaluated day - grouped bars, one value axis, legend + direct labels on the extremes. */
function predictionChart() {
  const days = d.predictions.filter((p) => p.revealed && typeof p.actual === "number").slice().reverse();
  if (days.length < 2) return "";
  const W = 900, H = 200, padL = 48, padR = 12, padT = 18, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(1, ...days.flatMap((p) => [Number(p.prediction?.predictedCoins) || 0, p.actual]));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const yMax = Math.ceil(max / nice) * nice;
  const y = (v) => padT + plotH - (v / yMax) * plotH;
  const groupW = plotW / days.length;
  const barW = Math.max(3, Math.min(9, (groupW - 6) / 2 - 1));
  const grid = [0, 0.5, 1].map((f) => {
    const v = yMax * f, yy = y(v);
    return `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/><text class="axis" x="${padL - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${fmtN(v)}</text>`;
  }).join("");
  const every = days.length > 14 ? 2 : 1;
  const groups = days.map((p, i) => {
    const cx = padL + groupW * (i + 0.5);
    const pred = Number(p.prediction?.predictedCoins) || 0;
    const x1 = cx - barW - 1, x2 = cx + 1;
    const yp = y(pred), ya = y(p.actual);
    const err = p.errorPct != null ? `${p.errorPct > 0 ? "+" : ""}${p.errorPct}%` : "";
    const tip = `${p.date} · predicted ${fmtN(pred)} · actual ${fmtN(p.actual)}${err ? ` · ${err}` : ""}`;
    const label = i % every === 0 ? `<text class="axis" x="${cx.toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(p.date.slice(5))}</text>` : "";
    return `<g class="pgroup" data-tip="${esc(tip)}" tabindex="0" role="img" aria-label="${esc(tip)}">
      <rect class="hit" x="${(cx - groupW / 2).toFixed(1)}" y="${padT}" width="${groupW.toFixed(1)}" height="${plotH}"/>
      <rect class="bar predicted" x="${x1.toFixed(1)}" y="${yp.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, padT + plotH - yp).toFixed(1)}" rx="2"/>
      <rect class="bar actual" x="${x2.toFixed(1)}" y="${ya.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, padT + plotH - ya).toFixed(1)}" rx="2"/>
      ${label}</g>`;
  }).join("");
  return `
    <div class="pchart">
      <div class="pchart-head"><span class="sub-note">meme coins sold per day &mdash; the morning call against the evening truth</span>
        <span class="legend"><span class="sw predicted"></span> predicted <span class="sw actual"></span> actual</span></div>
      <svg viewBox="0 0 ${W} ${H}" class="pchart-svg" aria-hidden="true">${grid}<line class="base" x1="${padL}" x2="${W - padR}" y1="${(padT + plotH).toFixed(1)}" y2="${(padT + plotH).toFixed(1)}"/>${groups}</svg>
    </div>`;
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
      <td class="mono hash" data-full="${esc(p.commitment)}" title="${esc(p.revealed && p.nonce && p.scheme === ng.COMMIT_SCHEME
        // the nonce is secret until the reveal has been queued - never publish it earlier
        ? `click to copy. Check it: sha256("${p.payloadHash}${p.nonce}") = ${p.commitment}`
        : "click to copy")}">${esc(ng.shortHash(p.commitment))}</td>
    </tr>`;
  }).join("");
  return `
  <section class="panel" id="scoreboard">
    <div class="panel-head"><h2>Prediction scoreboard</h2>
      <span class="sub-note">committed each morning as <span class="mono">sha256(prediction &#8214; nonce)</span>, revealed the next day with the nonce &mdash; provably called <em>before</em> the outcome</span></div>
    ${predictionChart()}
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

/**
 * Everything the expandable detail row needs, as one JSON blob per row. Only
 * public material: the hashed envelope itself is public by design (anyone can
 * reproduce the sha256 from it, see docs/SCHEMAS.md) - nonces, witnesses and
 * job ids never leave the server.
 */
function detailOf(a) {
  const why = !a.ok ? (a.feeWasted ? "refused on chain, fee burned" : a.skipped ? "skipped, prerequisite failed" : ng.isOutageEntry(a) ? "failed while the NIGHTGATE API was down" : "failed") : "";
  return {
    at: a.at, date: a.date || "", kind: a.kind, label: kindLabel(a.kind), call: a.call || "attest",
    ok: !!a.ok, verified: !!a.verified, why, error: a.error || "",
    payloadHash: a.payloadHash || "", metadataHash: a.metadataHash || "", commitment: a.commitment || "",
    txHash: a.txHash || "", txExplorerHash: a.txExplorerHash || "", vault: a.vault || d.vault,
    field: a.field || "", threshold: a.threshold ?? null, op: a.op != null ? Number(a.op) : null,
    doc: a.doc && typeof a.doc === "object" ? a.doc : null,
    group: groupOf(a.kind), madeGood: !!a.madeGood, queued: !!(a.reanchorQueued && !a.madeGood),
    earlierVault: !!(a.vault && a.vault !== d.vault),
    flags: [a.rebuilt ? "rebuilt" : "", a.lateLanded ? "landed late" : "", a.repaired ? "recorded later" : "", a.reanchorOf ? "re-anchor" : "", a.madeGood ? "re-anchored later" : "", a.batchOf ? `batch of ${a.batchOf}` : ""].filter(Boolean),
  };
}

const GROUPS = [
  ["all", "all"], ["activity", "activity"], ["proofs", "daily proofs"], ["predictions", "predictions"],
  ["notary", "notary"], ["progression", "progression"], ["failed", "failed"],
];
function groupOf(kind) {
  if (!kind) return "other";
  if (["batch", "meeting", "explore", "pulse", "meal", "sleep"].includes(kind)) return "activity";
  if (kind === "report" || kind === "report-root" || kind === "report-diff" || kind === "progress" || kind === "progress-root" || kind.startsWith("predicate:")) return "proofs";
  if (kind.startsWith("prediction-")) return "predictions";
  if (kind === "notary" || kind === "notary-paid") return "notary";
  if (["contract", "levelup", "tool", "quest", "craft", "hustle", "gathers"].includes(kind)) return "progression";
  return "other";
}

/**
 * The timeline is rendered in the browser from the embedded JSON (all 500
 * entries of the capped log): filter chips, search, sort and paging all work
 * on one data set. Without JavaScript the panel explains itself.
 */
function timeline() {
  const data = d.anchors.map(detailOf);
  const counts = {};
  for (const a of data) { counts[a.group] = (counts[a.group] || 0) + 1; if (!a.ok) counts.failed = (counts.failed || 0) + 1; }
  counts.all = data.length;
  const chips = GROUPS.filter(([k]) => k === "all" || counts[k]).map(([k, label]) =>
    `<button class="chip-btn${k === "all" ? " active" : ""}" data-filter="${k}" role="tab" aria-selected="${k === "all"}">${esc(label)} <span class="cnt">${fmtN(counts[k] || 0)}</span></button>`).join("");
  return `
  <section class="panel" id="timeline">
    <div class="panel-head"><h2>Anchor timeline</h2><span class="sub-note">last ${fmtN(data.length)} entries &middot; click a row for the full record</span></div>
    <div class="toolbar">
      <div class="chips" role="tablist" aria-label="filter by kind">${chips}</div>
      <div class="toolbar-right">
        <input class="search" type="search" placeholder="hash, tx, kind&hellip;" aria-label="search anchors" autocomplete="off" spellcheck="false">
        <select class="sort" aria-label="sort order">
          <option value="newest">newest first</option>
          <option value="oldest">oldest first</option>
          <option value="kind">by kind</option>
          <option value="status">failed first</option>
        </select>
      </div>
    </div>
    <div class="table-wrap"><table class="tl">
      <thead><tr><th class="caret"></th><th>when</th><th>what</th><th>payload sha256</th><th>status</th><th>tx</th></tr></thead>
      <tbody><tr class="placeholder"><td colspan="6"><noscript>This table needs JavaScript. Every anchor is still verifiable without it: see the footer for the API call.</noscript></td></tr></tbody>
    </table></div>
    <div class="no-match" hidden>nothing matches &mdash; clear the search or pick another filter</div>
    <script type="application/json" id="anchors-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
  </section>`;
}

export function renderBody() {
  if (!d) d = collect();
  // the build stamp FIRST: open tabs fetch only the first 16 KB to see whether a newer build
  // exists, and the stylesheet alone grew past that (15.09.2026: stamp at byte 19,696, so no
  // tab ever reloaded and a page left open since 14.09. kept showing that day's failures)
  return `<meta name="nightgate-generated" content="${esc(d.generatedAt)}">
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
  [hidden] { display: none !important; }
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

  /* pager: count on the left, arrows + page window centered, page size on the right */
  .pager { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px;
    padding: 10px 16px; border-top: 1px solid var(--border); }
  .pager-count { font-size: 12.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .pager-size { justify-self: end; font-size: 12.5px; color: var(--ink-3); display: flex; gap: 6px; align-items: center; }
  .pager-size button { background: none; border: none; color: var(--ink-3); font: inherit; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
  .pager-size button.active { color: var(--ink); font-weight: 600; }
  .pager-size button:hover:not(.active) { color: var(--accent); }
  .pager-nav { display: flex; gap: 6px; align-items: center; justify-content: center; flex-wrap: wrap; }
  .page-btn { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; color: var(--ink);
    font-size: 13px; font-weight: 600; padding: 4px 11px; cursor: pointer; min-width: 34px; line-height: 1.4;
    font-variant-numeric: tabular-nums; }
  .page-btn:hover:not(:disabled) { border-color: var(--accent-2); color: var(--accent); }
  .page-btn:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 1px; }
  .page-btn.active { background: var(--accent-2); border-color: var(--accent-2); color: #fff; }
  .page-btn.arrow { font-size: 15px; padding: 3px 10px; }
  .page-btn.arrow:disabled { opacity: 0.35; cursor: default; }
  .page-gap { color: var(--ink-3); padding: 0 2px; user-select: none; }
  .page-mobile { display: none; font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; padding: 0 6px; }
  @media (max-width: 640px) {
    .pager { grid-template-columns: 1fr; justify-items: center; gap: 6px; }
    .pager-size { justify-self: center; }
    .page-btn.num, .page-gap { display: none; }
    .page-mobile { display: inline; }
  }

  /* expandable timeline rows */
  tr.row { cursor: pointer; }
  tr.row:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; }
  th.caret, td.caret { width: 26px; padding-right: 0; padding-left: 12px; }
  td.caret::before { content: ""; display: inline-block; width: 6px; height: 6px; border-right: 1.5px solid var(--ink-3);
    border-bottom: 1.5px solid var(--ink-3); transform: rotate(-45deg); transition: transform 0.15s; margin-bottom: 2px; }
  tr.row.open td.caret::before { transform: rotate(45deg); border-color: var(--accent); }
  tr.row.open { background: var(--panel-2); }
  tr.detail td { padding: 0 14px 14px 40px; white-space: normal; background: var(--panel-2); }
  tr.detail { border-bottom: 1px solid #1d212b; }
  .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px 24px; padding-top: 10px; }
  .detail-item { min-width: 0; }
  .detail-item .k { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); margin-bottom: 2px; }
  .detail-item .v { font-size: 13px; color: var(--ink); overflow-wrap: anywhere; }
  .detail-item .v.mono { font-size: 12.5px; }
  .detail-item .v .sub2 { display: block; }
  .detail-env { grid-column: 1 / -1; }
  .detail-env pre { margin: 4px 0 0; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    font-family: var(--mono); font-size: 12px; line-height: 1.55; color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
  .detail-env pre .key { color: var(--accent); }
  .detail-env pre .str { color: #c8d6a3; }
  .detail-env pre .num { color: #f0b86e; text-align: left; }
  .detail-actions { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; padding-top: 2px; }
  .act { display: inline-flex; align-items: center; gap: 6px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    color: var(--ink); font: inherit; font-size: 12.5px; font-weight: 600; padding: 5px 11px; cursor: pointer; text-decoration: none; }
  .act:hover { border-color: var(--accent-2); color: var(--accent); text-decoration: none; }
  .act.done { color: var(--good); border-color: color-mix(in srgb, var(--good) 45%, transparent); }
  .act.primary { background: var(--accent-2); border-color: var(--accent-2); color: #fff; }
  .act.primary:hover { color: #fff; filter: brightness(1.1); }
  .verify-result { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; flex-wrap: wrap; }
  .verify-result:empty { display: none; }
  .act:disabled { opacity: 0.6; cursor: progress; }
  .detail-note { grid-column: 1 / -1; font-size: 12.5px; color: var(--ink-3); }
  .detail-note code { font-family: var(--mono); color: var(--ink-2); font-size: 12px; overflow-wrap: anywhere; }
  @media (max-width: 640px) { tr.detail td { padding-left: 14px; } }

  /* header freshness + auto refresh */
  .updated { font-size: 12px; color: var(--ink-3); white-space: nowrap; }
  .updated.stale { color: var(--warning); }

  /* toolbar: filter chips, search, sort */
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip-btn { background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; color: var(--ink-2);
    font: inherit; font-size: 12.5px; font-weight: 600; padding: 3px 11px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; }
  .chip-btn .cnt { color: var(--ink-3); font-weight: 500; font-variant-numeric: tabular-nums; }
  .chip-btn:hover { border-color: var(--accent-2); color: var(--accent); }
  .chip-btn.active { background: var(--accent-2); border-color: var(--accent-2); color: #fff; }
  .chip-btn.active .cnt { color: rgba(255,255,255,0.75); }
  .chip-btn:focus-visible, .search:focus-visible, .sort:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 1px; }
  .toolbar-right { display: flex; gap: 8px; align-items: center; margin-left: auto; }
  .search, .sort { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--ink); font: inherit; font-size: 13px; padding: 5px 10px; }
  .search { width: 220px; font-family: var(--mono); font-size: 12.5px; }
  .search::placeholder { color: var(--ink-3); font-family: var(--sans); }
  .sort { cursor: pointer; }
  .no-match { padding: 26px 16px; text-align: center; color: var(--ink-3); font-size: 13.5px; }
  tr.placeholder td { padding: 0; }
  @media (max-width: 640px) { .toolbar-right { margin-left: 0; width: 100%; } .search { flex: 1; width: auto; } }

  /* activity panel: heatmap + side cards */
  .activity-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(260px, 1fr); gap: 0; }
  @media (max-width: 900px) { .activity-grid { grid-template-columns: 1fr; } .activity-side { border-left: none !important; border-top: 1px solid var(--border); } }
  .heat-wrap { padding: 14px 16px 12px; min-width: 0; }
  .heat { display: grid; grid-template-columns: 34px repeat(24, minmax(0, 1fr)) 40px; gap: 3px; align-items: center; }
  .hlabel { font-size: 11px; color: var(--ink-3); letter-spacing: 0.04em; text-transform: uppercase; }
  .hsum { font-size: 11.5px; color: var(--ink-2); text-align: right; font-variant-numeric: tabular-nums; }
  .hcell { height: 16px; border-radius: 3px; position: relative;
    background: color-mix(in srgb, var(--accent) calc(var(--t, 0) * 100%), var(--panel-2)); }
  .hcell.empty { background: var(--panel-2); box-shadow: inset 0 0 0 1px var(--border); }
  .hcell:hover, .hcell:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
  .htick { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); text-align: left; padding-top: 2px; }
  .heat-legend { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--ink-3); margin-top: 10px; flex-wrap: wrap; }
  .heat-legend .hcell { width: 14px; height: 14px; display: inline-block; }
  .heat-legend .hcell + span, .heat-legend span + .hcell { margin-left: 4px; }
  .table-view { margin-top: 10px; font-size: 12.5px; color: var(--ink-3); }
  .table-view summary { cursor: pointer; user-select: none; }
  .table-view summary:hover { color: var(--accent); }
  .table-view table { margin-top: 6px; font-size: 13px; }
  .table-view th, .table-view td { padding: 5px 10px; }
  .activity-side { border-left: 1px solid var(--border); display: flex; flex-direction: column; min-width: 0; }
  .now-card, .mix-card { padding: 14px 16px; }
  .now-card { border-bottom: 1px solid var(--border); }
  .now-card .label, .mix-card .label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); }
  .now-main { font-size: 20px; font-weight: 700; margin-top: 4px; overflow-wrap: anywhere; }
  .now-main .mono { font-size: 15px; font-weight: 500; color: var(--ink-2); }
  .now-mode { text-transform: capitalize; }
  .now-facts { display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px; color: var(--ink-2); margin-top: 6px; font-variant-numeric: tabular-nums; }
  .now-facts b { color: var(--ink); font-weight: 600; }
  .now-card .hint { font-size: 12px; color: var(--ink-3); margin-top: 8px; line-height: 1.6; }
  .bar-row { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 2fr) 48px; gap: 10px; align-items: center; padding: 4px 0; font-size: 12.5px; }
  .bar-row:hover .bar-fill { filter: brightness(1.15); }
  .bar-label { color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { height: 8px; background: var(--panel-2); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--accent); border-radius: 4px; min-width: 2px; }
  .bar-val { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink); }

  /* prediction chart */
  .pchart { padding: 12px 16px 4px; border-bottom: 1px solid var(--border); }
  .pchart-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  .legend { font-size: 12px; color: var(--ink-2); display: inline-flex; gap: 6px; align-items: center; }
  .legend .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-left: 8px; }
  .sw.predicted, .bar.predicted { fill: #c9812b; background: #c9812b; }
  .sw.actual, .bar.actual { fill: #4f7fe6; background: #4f7fe6; }
  .pchart-svg { width: 100%; height: auto; aspect-ratio: 900 / 200; display: block; }
  .pchart-svg .grid { stroke: var(--border); stroke-width: 1; }
  .pchart-svg .base { stroke: var(--ink-3); stroke-width: 1; }
  .pchart-svg .axis { fill: var(--ink-3); font-family: var(--mono); font-size: 10.5px; }
  .pchart-svg .hit { fill: transparent; }
  .pchart-svg .pgroup:hover .hit, .pchart-svg .pgroup:focus .hit { fill: color-mix(in srgb, var(--ink) 6%, transparent); }
  .pchart-svg .pgroup:focus { outline: none; }

  /* shared hover tooltip */
  .tip { position: fixed; z-index: 10; pointer-events: none; background: #0b0c10; color: var(--ink); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 9px; font-size: 12px; font-variant-numeric: tabular-nums; box-shadow: 0 6px 20px rgba(0,0,0,0.45);
    max-width: 320px; white-space: nowrap; transform: translate(-50%, calc(-100% - 10px)); opacity: 0; transition: opacity 0.08s; }
  .tip.show { opacity: 1; }

  .site-footer { border-top: 1px solid var(--border); color: var(--ink-3); font-size: 13px; padding: 18px 24px; margin-top: 8px; }
  .site-footer .verify-how { max-width: 1100px; margin: 0 auto; }
  .site-footer code { font-family: var(--mono); font-size: 12px; color: var(--ink-2); word-break: break-all; white-space: normal; }
  .site-footer p { margin: 6px 0; }
</style>
<header class="site-header">
  <span class="brand"><span class="brand-mark"></span>
    <span><span class="brand-name">M&#8371;X</span><span class="brand-sub">proof ledger &middot; nightgate</span></span></span>
  <span class="header-spacer"></span>
  <span class="updated mono" data-generated="${esc(d.generatedAt)}" title="${esc(d.generatedAt)}">updated ${esc(relTime(Date.parse(d.generatedAt)))}</span>
  <span class="net-badge">midnight ${esc(d.network)}</span>
</header>
<main class="container">
  ${hero()}
  ${stats()}
  ${activity()}
  ${scoreboard()}
  ${timeline()}
</main>
<footer class="site-footer">
  <div class="verify-how">
    <p><b style="color:var(--ink-2)">Verify any hash yourself</b> against live Midnight contract state &mdash; no wallet, no account. Open a timeline row and press <em>verify on chain now</em>, or call the public verify lane directly:</p>
    <p><code>GET ${esc(process.env.NIGHTGATE_PUBLIC_VERIFY_URL || "https://api.nightgate.dev/api/v1/verify")}/verifyAttestationState(contractAddress='${esc(d.vault)}',attesterId='${esc(d.attesterId)}',payloadHash='&lt;sha256&gt;',compiledArtifactRef='${esc(d.artifact)}')</code></p>
    <p class="sub2">With a NIGHTGATE token the same function answers under <code>/api/v1/nightgate/</code> (header <code>x-agent-token</code>).</p>${d.previousVaults.length ? `
    <p class="sub2">For a timeline row tagged with an earlier vault, put that vault's address into <code>contractAddress</code>.</p>` : ""}
    <p>Built on NIGHTGATE &mdash; zero-knowledge attestations on <a href="https://midnight.network">Midnight</a>.
    Sister project: <a href="https://zkpassport.eu">NIGHTPASS</a>. Every anchor was built, proven and signed locally with M&#8371;X's own key and submitted fee-unpaid through cross-server fee sponsoring.</p>
  </div>
</footer>
<script>
  const NETWORK = ${JSON.stringify(d.network)};
  const ARTIFACT = ${JSON.stringify(d.artifact)};
  const CURRENT_VAULT = ${JSON.stringify(d.vault)};
  const copyText = (t) => { try { navigator.clipboard.writeText(t); } catch {} };
  const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
  const rel = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 48 * 3600) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };
  const escH = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // NIGHTGATE's public verify lane (0.24+): token-free, CORS open, rate limited per address
  const PUBLIC_VERIFY = ${JSON.stringify(process.env.NIGHTGATE_PUBLIC_VERIFY_URL || "https://api.nightgate.dev/api/v1/verify")};
  const TOKEN_API = "https://api.nightgate.dev/api/v1/nightgate";
  // Until the API runs 0.24 the live check goes through the token lane with a
  // deliberately weak grant (NIGHTGATE_DASHBOARD_TOKEN at generation time):
  // verify* is free for every token, the one mandatory write action has a
  // budget of a single job per day and the grant expires. The token is public
  // by construction - it sits in this page.
  const VERIFY_TOKEN = ${JSON.stringify(process.env.NIGHTGATE_DASHBOARD_TOKEN || "")};
  // lineage 4 (NIGHTGATE 0.24): a record is (attesterId, payloadHash) - a payloadHash alone is a 400
  const ATTESTER = ${JSON.stringify(d.attesterId)};
  const verifyArgs = (vault, hash) => "/verifyAttestationState(contractAddress='" + vault + "',attesterId='" + ATTESTER + "',payloadHash='" + hash + "',compiledArtifactRef='" + ARTIFACT + "')";
  const verifyUrl = (vault, hash) => PUBLIC_VERIFY + verifyArgs(vault, hash);
  const verifyUrlToken = (vault, hash) => TOKEN_API + verifyArgs(vault, hash);
  const verifyRequest = (vault, hash) => VERIFY_TOKEN
    ? { url: verifyUrlToken(vault, hash), headers: { Accept: "application/json", "x-agent-token": VERIFY_TOKEN } }
    : { url: verifyUrl(vault, hash), headers: { Accept: "application/json" } };

  // ----- expandable timeline rows: one detail row per clicked anchor -----
  const closeDetail = (row) => {
    const det = row.nextElementSibling;
    if (det && det.classList.contains("detail")) det.remove();
    row.classList.remove("open");
    row.setAttribute("aria-expanded", "false");
  };
  const item = (k, v, mono) => '<div class="detail-item"><div class="k">' + k + '</div><div class="v' + (mono ? " mono" : "") + '">' + v + "</div></div>";
  const envelopeHtml = (doc) => JSON.stringify(doc, null, 2)
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))
    .replace(/("(?:[^"\\\\]|\\\\.)*")(\\s*:)?/g, (m, s, colon) => colon ? '<span class="key">' + s + "</span>" + colon : '<span class="str">' + s + "</span>")
    .replace(/: (-?\\d+(?:\\.\\d+)?)/g, ': <span class="num">$1</span>');
  const openDetail = (row) => {
    let a; try { a = JSON.parse(row.dataset.detail); } catch { return; }
    const exp = "https://" + NETWORK + ".midnightexplorer.com/";
    const hash = a.payloadHash || a.commitment;
    const parts = [];
    parts.push(item("when", utc(a.at) + (a.date ? ' <span class="sub2">report day ' + escH(a.date) + "</span>" : "")));
    parts.push(item("what", escH(a.label) + ' <span class="sub2">vault circuit <span class="mono">' + escH(a.call) + "</span></span>"));
    parts.push(item("status", a.ok
      ? '<span class="chip anchored">' + (a.verified ? "verified against live contract state" : "anchored") + "</span>" + (a.flags.length ? ' <span class="sub2">' + escH(a.flags.join(" · ")) + "</span>" : "")
      : '<span class="chip failed">' + escH(a.why) + "</span>" + (a.flags.length ? ' <span class="sub2">' + escH(a.flags.join(" · ")) + "</span>" : "") + (a.error ? '<span class="sub2">' + escH(a.error) + "</span>" : "")));
    if (a.payloadHash) parts.push(item("payload sha256", '<span class="hash" data-full="' + escH(a.payloadHash) + '" title="click to copy">' + escH(a.payloadHash) + "</span>", true));
    if (a.commitment) parts.push(item("commitment", '<span class="hash" data-full="' + escH(a.commitment) + '" title="click to copy">' + escH(a.commitment) + '</span><span class="sub2">persistentHash(payloadHash, metadataHash, nonce) - the envelope stays hidden until the reveal</span>', true));
    if (a.metadataHash) parts.push(item("metadata sha256", '<span class="hash" data-full="' + escH(a.metadataHash) + '" title="click to copy">' + escH(a.metadataHash) + '</span><span class="sub2">{"v":1,"agentId":…,"kind":"' + escH(a.kind) + '","date":"' + escH(a.date) + '"}</span>', true));
    if (a.field) parts.push(item("zero-knowledge claim", escH(a.field) + " " + (a.op === 1 ? "&ge;" : "&le;") + " " + Number(a.threshold).toLocaleString("en-US") + '<span class="sub2">proven from the Merkle root of the daily report - the real value is not on chain</span>'));
    parts.push(item("transaction", a.txExplorerHash
      ? '<a href="' + exp + "transactions/0x" + escH(a.txExplorerHash) + '" target="_blank" rel="noopener">' + escH(a.txExplorerHash) + "</a>"
      : a.txHash ? escH(a.txHash) + '<span class="sub2">not yet indexed by the explorer</span>' : '<span class="sub2">none - nothing reached the chain</span>', true));
    parts.push(item("vault", '<a href="' + exp + "contracts/0x" + escH(a.vault) + '" target="_blank" rel="noopener">' + escH(a.vault) + "</a>" + (a.vault !== CURRENT_VAULT ? '<span class="sub2">earlier vault (lineage migration) - verify against this address</span>' : ""), true));
    if (a.doc) {
      const canon = JSON.stringify(a.doc);
      parts.push('<div class="detail-item detail-env"><div class="k">hashed envelope (public, canonical JSON, docs/SCHEMAS.md)</div><pre>' + envelopeHtml(a.doc) + "</pre></div>");
      parts.push('<div class="detail-note">Reproduce the payload hash without trusting anyone: <code>printf \\'%s\\' \\'' + escH(canon).replace(/'/g, "&#39;") + '\\' | sha256sum</code></div>');
    }
    const acts = [];
    // live check only against the current vault: an earlier lineage's state is not readable by a 0.24 server
    if (a.ok && a.payloadHash && !a.earlierVault && a.call !== "proveFieldPredicate" && a.call !== "proveFieldsDiffer" && a.call !== "proveDocumentComparison") {
      acts.push('<button class="act primary" data-verify="1" data-vault="' + escH(a.vault) + '" data-hash="' + escH(a.payloadHash) + '">verify on chain now</button><span class="verify-result" aria-live="polite"></span>');
    }
    if (a.ok && a.payloadHash) acts.push('<button class="act" data-copy="' + escH(verifyUrl(a.vault, a.payloadHash)) + '">copy verify URL</button>');
    if (a.ok && a.payloadHash) acts.push('<button class="act" data-copy="' + escH("curl -H 'x-agent-token: <your NIGHTGATE token>' \\"" + verifyUrlToken(a.vault, a.payloadHash) + "\\"") + '" title="the same function behind a token, for servers without the public lane">copy curl (token)</button>');
    if (a.doc) acts.push('<button class="act" data-copy="' + escH(JSON.stringify(a.doc)) + '">copy envelope</button>');
    if (a.txExplorerHash) acts.push('<a class="act" href="' + exp + "transactions/0x" + escH(a.txExplorerHash) + '" target="_blank" rel="noopener">open in explorer &nearr;</a>');
    acts.push('<button class="act" data-copy="' + escH(location.origin + location.pathname + "#anchor=" + hash) + '">copy link to this anchor</button>');
    parts.push('<div class="detail-actions">' + acts.join("") + "</div>");
    const det = document.createElement("tr");
    det.className = "detail";
    det.innerHTML = '<td colspan="6"><div class="detail-grid">' + parts.join("") + "</div></td>";
    row.after(det);
    row.classList.add("open");
    row.setAttribute("aria-expanded", "true");
  };
  const toggleDetail = (row) => {
    if (row.classList.contains("open")) { closeDetail(row); return; }
    row.closest("tbody").querySelectorAll("tr.row.open").forEach(closeDetail); // one open record at a time
    openDetail(row);
  };
  // live verification through the public verify lane: the browser asks the chain itself
  const verifyLive = async (btn) => {
    const out = btn.nextElementSibling;
    const vault = btn.dataset.vault, hash = btn.dataset.hash;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "asking the chain\\u2026";
    out.innerHTML = "";
    const rq = verifyRequest(vault, hash);
    try {
      const res = await fetch(rq.url, { headers: rq.headers });
      if (res.status === 404) {
        out.innerHTML = '<span class="chip anchoring">live check not available yet</span> <span class="sub2">the public verify lane (NIGHTGATE 0.24) is not enabled on this server - use the URL below with any token</span>';
      } else if (res.status === 401 || res.status === 403) {
        out.innerHTML = '<span class="chip anchoring">live check paused</span> <span class="sub2">the page\\u2019s read token was refused (expired or revoked) - use the URL below with your own token</span>';
      } else if (res.status === 429) {
        out.innerHTML = '<span class="chip anchoring">rate limited</span> <span class="sub2">try again in a minute</span>';
      } else if (!res.ok) {
        out.innerHTML = '<span class="chip failed">HTTP ' + res.status + '</span>';
      } else {
        const r = await res.json();
        const v = r.value ?? r;
        if (v.verified) {
          out.innerHTML = '<span class="chip anchored">verified against live contract state</span> <span class="sub2">' + escH(utc(Date.now())) + (v.attesterId ? " \\u00b7 attester " + escH(String(v.attesterId).slice(0, 12)) + "\\u2026" : "") + "</span>";
        } else {
          out.innerHTML = '<span class="chip failed">not found on chain</span> <span class="sub2">' + (v.attested === false ? "the vault holds no attestation for this payload" : "verification returned false") + "</span>";
        }
      }
    } catch (err) {
      // a fetch that never got a response: the lane is not served (older NIGHTGATE answers a plain 404 without CORS headers) or the API is offline
      out.innerHTML = '<span class="chip anchoring">live check not reachable</span> <span class="sub2">the public verify lane did not answer (' + escH(err && err.message ? err.message : "network error") + ') - copy the URL below and try it with any NIGHTGATE token</span>';
    }
    btn.textContent = prev;
    btn.disabled = false;
  };
  document.addEventListener("click", (e) => {
    const vbtn = e.target.closest("[data-verify]");
    if (vbtn) { verifyLive(vbtn); return; }
    const act = e.target.closest("[data-copy]");
    if (act) {
      copyText(act.dataset.copy);
      const prev = act.textContent;
      act.textContent = "copied \\u2713"; act.classList.add("done");
      setTimeout(() => { act.textContent = prev; act.classList.remove("done"); }, 1100);
      return;
    }
    if (e.target.closest("a, .hash, .detail")) return;
    const row = e.target.closest("tr.row");
    if (row) toggleDetail(row);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("tr.row")) { e.preventDefault(); toggleDetail(e.target); }
  });

  // ----- pagination: centered arrows + a window of page numbers, count, page size, URL hash, keyboard -----
  const pagers = [];
  const hashParams = () => new URLSearchParams(location.hash.replace(/^#/, ""));
  const setHashParam = (k, v) => {
    const p = hashParams();
    if (v == null || v === "") p.delete(k); else p.set(k, v);
    const s = p.toString();
    history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
  };
  const scrollToPanel = (panel) => {
    const top = panel.getBoundingClientRect().top + window.scrollY - 12;
    if (Math.abs(window.scrollY - top) > 40) window.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const pbtn = (label, cls, title, onClick, disabled) => {
    const b = document.createElement("button");
    b.className = "page-btn " + cls;
    b.innerHTML = label;
    if (title) b.setAttribute("aria-label", title);
    b.disabled = !!disabled;
    if (onClick) b.addEventListener("click", onClick);
    return b;
  };
  /** Draw a pager into mount for {count, page, size, sizes, allAt, onPage(p), onSize(n)}. */
  const renderPager = (mount, s) => {
    mount.innerHTML = "";
    const pages = Math.max(1, Math.ceil(s.count / s.size));
    const page = Math.min(s.page, pages - 1);
    const from = s.count ? page * s.size + 1 : 0, to = Math.min(s.count, (page + 1) * s.size);
    const count = document.createElement("span");
    count.className = "pager-count";
    count.textContent = from + "\\u2013" + to + " of " + s.count;
    mount.appendChild(count);
    const nav = document.createElement("div");
    nav.className = "pager-nav";
    nav.appendChild(pbtn("&laquo;", "arrow", "first page", () => s.onPage(0), page === 0));
    nav.appendChild(pbtn("&lsaquo;", "arrow", "previous page", () => s.onPage(page - 1), page === 0));
    // window: first, last, current +-2, gaps as an ellipsis
    const win = new Set([0, pages - 1]);
    for (let p = page - 2; p <= page + 2; p++) if (p >= 0 && p < pages) win.add(p);
    if (page <= 3) for (let p = 0; p < Math.min(pages, 5); p++) win.add(p);
    if (page >= pages - 4) for (let p = Math.max(0, pages - 5); p < pages; p++) win.add(p);
    let last = -1;
    [...win].sort((x, y) => x - y).forEach((p) => {
      if (last >= 0 && p - last > 1) { const gap = document.createElement("span"); gap.className = "page-gap"; gap.textContent = "\\u2026"; nav.appendChild(gap); }
      const b = pbtn(String(p + 1), "num" + (p === page ? " active" : ""), "page " + (p + 1), () => s.onPage(p), p === page);
      if (p === page) b.setAttribute("aria-current", "page");
      nav.appendChild(b);
      last = p;
    });
    const mob = document.createElement("span");
    mob.className = "page-mobile";
    mob.textContent = (page + 1) + " / " + pages;
    nav.appendChild(mob);
    nav.appendChild(pbtn("&rsaquo;", "arrow", "next page", () => s.onPage(page + 1), page >= pages - 1));
    nav.appendChild(pbtn("&raquo;", "arrow", "last page", () => s.onPage(pages - 1), page >= pages - 1));
    mount.appendChild(nav);
    const sz = document.createElement("span");
    sz.className = "pager-size";
    sz.append("per page ");
    s.sizes.forEach((n) => {
      const b = document.createElement("button");
      b.textContent = n >= s.allAt ? "all" : String(n);
      b.className = n === s.size ? "active" : "";
      b.addEventListener("click", () => s.onSize(n));
      sz.appendChild(b);
    });
    mount.appendChild(sz);
  };
  const newPager = (panel) => {
    const el = document.createElement("div");
    el.className = "pager";
    el.setAttribute("role", "navigation");
    el.setAttribute("aria-label", (panel.querySelector("h2")?.textContent || "table") + " pages");
    panel.appendChild(el);
    return el;
  };

  // static tables (the scoreboard): page the DOM rows
  document.querySelectorAll("table[data-page-size]").forEach((tbl) => {
    const panel = tbl.closest(".panel");
    const id = panel.id || "table";
    const rows = Array.from(tbl.tBodies[0].rows).filter((r) => !r.classList.contains("detail"));
    let size = +tbl.dataset.pageSize;
    if (rows.length <= size) return;
    const sizes = [size, size * 2.5, rows.length].map(Math.round).filter((v, i, arr) => arr.indexOf(v) === i && v <= rows.length);
    const pager = newPager(panel);
    let page = 0;
    const pageCount = () => Math.ceil(rows.length / size);
    const render = () => {
      rows.forEach((r) => { if (r.classList.contains("open")) closeDetail(r); });
      const from = page * size, to = Math.min(rows.length, (page + 1) * size);
      rows.forEach((r, i) => { r.hidden = i < from || i >= to; });
      renderPager(pager, { count: rows.length, page, size, sizes, allAt: rows.length, onPage: (p) => go(p), onSize: (n) => { const first = page * size; size = n; go(Math.floor(first / size), { scroll: false }); } });
    };
    const go = (p, { scroll = true } = {}) => {
      page = Math.max(0, Math.min(pageCount() - 1, p));
      render();
      setHashParam(id, page ? page + 1 : null);
      if (scroll) scrollToPanel(panel);
    };
    const wanted = parseInt(hashParams().get(id) || "1", 10);
    page = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted - 1, pageCount() - 1) : 0;
    render();
    pagers.push({ panel, go, get page() { return page; } });
  });

  // ----- the timeline: filter / search / sort / page over the embedded data -----
  (() => {
    const panel = document.getElementById("timeline");
    const dataEl = document.getElementById("anchors-data");
    if (!panel || !dataEl) return;
    let data; try { data = JSON.parse(dataEl.textContent); } catch { return; }
    const tbody = panel.querySelector("table.tl tbody");
    const emptyEl = panel.querySelector(".no-match");
    const search = panel.querySelector(".search");
    const sortEl = panel.querySelector(".sort");
    const pager = newPager(panel);
    const short = (h) => (h && h.length > 20 ? h.slice(0, 12) + "\\u2026" + h.slice(-6) : h || "");
    const exp = "https://" + NETWORK + ".midnightexplorer.com/";
    const hp = hashParams();
    const st = { filter: hp.get("f") || "all", q: hp.get("q") || "", sort: hp.get("s") || "newest", page: Math.max(0, (parseInt(hp.get("timeline") || "1", 10) || 1) - 1), size: 20 };
    const sizes = [20, 50, 100, data.length].filter((v, i, arr) => arr.indexOf(v) === i && v <= data.length);
    search.value = st.q;
    if ([...sortEl.options].some((o) => o.value === st.sort)) sortEl.value = st.sort; else st.sort = "newest";
    const statusRank = (a) => (!a.ok && !a.madeGood ? 0 : !a.ok ? 1 : a.verified ? 3 : 2);
    const matches = (a, q) => !q || [a.payloadHash, a.commitment, a.metadataHash, a.txHash, a.txExplorerHash, a.label, a.kind, a.call, a.date, a.error, a.doc ? JSON.stringify(a.doc) : ""].some((v) => v && String(v).toLowerCase().includes(q));
    let view = [];
    const compute = () => {
      const q = st.q.trim().toLowerCase();
      view = data.filter((a) => (st.filter === "all" || (st.filter === "failed" ? !a.ok : a.group === st.filter)) && matches(a, q));
      if (st.sort === "oldest") view = view.slice().reverse();
      else if (st.sort === "kind") view = view.slice().sort((x, y) => x.label.localeCompare(y.label) || y.at - x.at);
      else if (st.sort === "status") view = view.slice().sort((x, y) => statusRank(x) - statusRank(y) || y.at - x.at);
    };
    const statusCell = (a) => {
      const flags = a.flags.filter((f) => f !== "re-anchored later");
      const sub = flags.length ? ' <span class="sub2">' + escH(flags.join(" \\u00b7 ")) + "</span>" : "";
      if (a.ok) return '<span class="chip anchored">' + (a.verified ? "verified" : "anchored") + "</span>" + sub;
      if (a.madeGood) return '<span class="chip reanchored" title="' + escH(a.why + (a.error ? ": " + a.error : "")) + '">re-anchored later</span> <span class="sub2">' + escH(a.why) + "</span>";
      return '<span class="chip failed" title="' + escH(a.error) + '">' + escH(a.why) + "</span>" + (a.queued ? ' <span class="sub2" title="a fresh anchor of the same payload is in the queue">re-anchor queued</span>' : "") + sub;
    };
    const rowHtml = (a) => {
      const hash = a.payloadHash || a.commitment || "";
      return '<td class="caret" aria-hidden="true"></td>' +
        '<td class="mono sub2" data-ts="' + a.at + '" title="' + escH(utc(a.at)) + '">' + escH(rel(a.at)) + "</td>" +
        '<td><span class="kind">' + escH(a.label) + "</span>" + (a.earlierVault ? ' <span class="sub2" title="anchored on an earlier vault ' + escH(a.vault) + '">vault ' + escH(a.vault.slice(0, 8)) + "</span>" : "") + "</td>" +
        (hash ? '<td class="mono hash" data-full="' + escH(hash) + '" title="click to copy the full hash">' + escH(short(hash)) + "</td>" : '<td class="mono sub2">\\u2014</td>') +
        "<td>" + statusCell(a) + "</td>" +
        '<td class="mono sub2">' + (a.txExplorerHash
          ? '<a href="' + exp + "transactions/0x" + escH(a.txExplorerHash) + '" target="_blank" rel="noopener" title="' + escH(a.txExplorerHash) + '">' + escH(short(a.txExplorerHash)) + "</a>"
          : a.txHash ? escH(short(a.txHash)) : "\\u2014") + "</td>";
    };
    const render = () => {
      const pages = Math.max(1, Math.ceil(view.length / st.size));
      st.page = Math.min(st.page, pages - 1);
      const from = st.page * st.size, to = Math.min(view.length, from + st.size);
      const frag = document.createDocumentFragment();
      for (const a of view.slice(from, to)) {
        const tr = document.createElement("tr");
        tr.className = "row";
        tr.tabIndex = 0;
        tr.setAttribute("aria-expanded", "false");
        tr.dataset.detail = JSON.stringify(a);
        tr.innerHTML = rowHtml(a);
        frag.appendChild(tr);
      }
      tbody.replaceChildren(frag);
      emptyEl.hidden = view.length > 0;
      pager.hidden = view.length <= sizes[0];
      renderPager(pager, { count: view.length, page: st.page, size: st.size, sizes, allAt: data.length, onPage: (p) => go(p), onSize: (n) => { const first = st.page * st.size; st.size = n; go(Math.floor(first / n), { scroll: false }); } });
      panel.querySelectorAll(".chip-btn").forEach((c) => { const on = c.dataset.filter === st.filter; c.classList.toggle("active", on); c.setAttribute("aria-selected", on); });
      setHashParam("timeline", st.page ? st.page + 1 : null);
      setHashParam("f", st.filter === "all" ? null : st.filter);
      setHashParam("q", st.q.trim() || null);
      setHashParam("s", st.sort === "newest" ? null : st.sort);
    };
    const go = (p, { scroll = true } = {}) => {
      st.page = Math.max(0, Math.min(Math.ceil(view.length / st.size) - 1, p));
      render();
      if (scroll) scrollToPanel(panel);
    };
    const refresh = () => { compute(); st.page = 0; render(); };
    panel.querySelector(".chips").addEventListener("click", (e) => {
      const c = e.target.closest(".chip-btn");
      if (!c) return;
      st.filter = c.dataset.filter;
      refresh();
    });
    let t = 0;
    search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { st.q = search.value; refresh(); }, 120); });
    search.addEventListener("keydown", (e) => { if (e.key === "Escape") { search.value = ""; st.q = ""; refresh(); } });
    sortEl.addEventListener("change", () => { st.sort = sortEl.value; refresh(); });
    compute();
    render();
    pagers.push({ panel, go, get page() { return st.page; } });
    // back/forward or a pasted link with a different hash: re-read the state
    window.addEventListener("hashchange", () => {
      const p = hashParams();
      st.filter = p.get("f") || "all"; st.q = p.get("q") || ""; st.sort = p.get("s") || "newest";
      if (![...sortEl.options].some((o) => o.value === st.sort)) st.sort = "newest";
      search.value = st.q; sortEl.value = st.sort;
      compute();
      st.page = Math.max(0, (parseInt(p.get("timeline") || "1", 10) || 1) - 1);
      render();
    });
    // #anchor=<hash>: clear the filters, jump to its page, open it
    const wantedAnchor = (hashParams().get("anchor") || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
    if (wantedAnchor) {
      const idx = data.findIndex((a) => (a.payloadHash || "").startsWith(wantedAnchor) || (a.commitment || "").startsWith(wantedAnchor));
      if (idx >= 0) {
        st.filter = "all"; st.q = ""; search.value = ""; st.sort = "newest"; sortEl.value = "newest";
        compute();
        st.page = Math.floor(idx / st.size);
        render();
        setHashParam("anchor", wantedAnchor);
        const row = tbody.querySelector('tr.row[data-detail*="' + wantedAnchor + '"]');
        if (row) { toggleDetail(row); setTimeout(() => row.scrollIntoView({ block: "center" }), 50); }
      }
    }
  })();

  // ----- shared hover tooltip for [data-tip] (heatmap cells, bars, chart groups) -----
  const tip = document.createElement("div");
  tip.className = "tip";
  document.body.appendChild(tip);
  let tipFor = null;
  const showTip = (el, x, y) => {
    tip.textContent = el.dataset.tip;
    const r = el.getBoundingClientRect();
    const px = x != null ? x : r.left + r.width / 2;
    const py = y != null ? y : r.top;
    tip.style.left = Math.max(160, Math.min(window.innerWidth - 160, px)) + "px";
    tip.style.top = Math.max(44, py) + "px";
    tip.classList.add("show");
    tipFor = el;
  };
  const hideTip = () => { tip.classList.remove("show"); tipFor = null; };
  document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(el, e.clientX, e.clientY); else if (tipFor) hideTip(); });
  document.addEventListener("mousemove", (e) => { if (tipFor && !tipFor.classList.contains("bar-row")) { tip.style.left = Math.max(160, Math.min(window.innerWidth - 160, e.clientX)) + "px"; tip.style.top = Math.max(44, e.clientY) + "px"; } });
  document.addEventListener("mouseout", (e) => { if (tipFor && !e.relatedTarget?.closest?.("[data-tip]")) hideTip(); });
  document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(el); });
  document.addEventListener("focusout", () => hideTip());
  window.addEventListener("scroll", () => { if (tipFor) hideTip(); }, { passive: true });

  // ----- freshness: "updated 8m ago" ticks every minute; a newer build on the server reloads the page -----
  const updatedEl = document.querySelector(".updated");
  const generatedAt = updatedEl ? Date.parse(updatedEl.dataset.generated) : 0;
  const tickUpdated = () => {
    if (!updatedEl) return;
    updatedEl.textContent = "updated " + rel(generatedAt);
    updatedEl.classList.toggle("stale", Date.now() - generatedAt > 3 * 3600_000);
  };
  tickUpdated();
  setInterval(tickUpdated, 60_000);
  const checkNewer = async () => {
    if (document.visibilityState !== "visible" || location.protocol === "file:") return;
    try {
      const res = await fetch(location.pathname + location.search, { cache: "no-store", headers: { "Range": "bytes=0-16383" } });
      const txt = await res.text();
      const m = /name="nightgate-generated" content="([^"]+)"/.exec(txt) || /data-generated="([^"]+)"/.exec(txt);
      if (m && Date.parse(m[1]) > generatedAt) location.reload();
    } catch {}
  };
  setInterval(checkNewer, 5 * 60_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - generatedAt > 10 * 60_000) checkNewer(); });
  // arrow keys page the table that is on screen (not while typing or with modifiers)
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.target.matches("input, textarea, select")) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const vh = window.innerHeight;
    const pg = pagers.find((p) => { const r = p.panel.getBoundingClientRect(); return r.top < vh * 0.7 && r.bottom > vh * 0.3; });
    if (!pg) return;
    e.preventDefault();
    pg.go(pg.page + (e.key === "ArrowRight" ? 1 : -1));
  });
  // #anchor=<hash> deep link: open that record on its page
  const wantedAnchor = hashParams().get("anchor");
  if (wantedAnchor) {
    const pg = pagers.find((p) => p.panel.id === "timeline");
    const row = document.querySelector('tr.row[data-detail*="' + wantedAnchor.replace(/[^0-9a-f]/gi, "") + '"]');
    if (row && pg) {
      pg.go(Math.floor(pg.rows.indexOf(row) / pg.size()), { scroll: false });
      toggleDetail(row);
      setHashParam("anchor", wantedAnchor);
      setTimeout(() => row.scrollIntoView({ block: "center" }), 50);
    }
  }

  // relative times, recomputed at view time (full timestamp stays in the tooltip)
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
