#!/usr/bin/env node
/**
 * M₳X's daily proof run + on-demand ZK claims. Spawned detached by
 * report.generate() at report time; also the CLI behind `life.mjs attest`.
 *
 *   node scripts/attest-report.mjs [reportFile]        # daily flow (default data/last-report.md)
 *   node scripts/attest-report.mjs prove <field> min|max <threshold> [date]
 *   node scripts/attest-report.mjs diff <k> [dateA dateB]   # >=k fields differ between two anchored reports
 *
 * Daily flow:
 *   1. structured document from the last 24h numbers (prepareDocumentProof,
 *      salted Merkle root; witnesses stored in data/doc-proofs/<date>.json -
 *      SENSITIVE, they open the anchored root)
 *   2. queue: attest + anchorContentRoot for the report document
 *   3. queue: milestone predicate "crystal >= <largest round milestone>"
 *      (ZK - the actual number stays hidden)
 *   4. reveal yesterday's prediction commit, then commit a fresh prediction
 *      for today (attestGuarded commit/reveal - provably made BEFORE the outcome)
 *   5. drain the anchor queue (strictly serial, see anchor-worker.mjs)
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadDotEnv, dataDir, scriptsDir, log } from "./lib/mc.mjs";
import * as journal from "./lib/journal.mjs";
import * as report from "./lib/report.mjs";
import * as ng from "./lib/nightgate.mjs";
import { canonical } from "./lib/schemas.mjs";
import { drain } from "./anchor-worker.mjs";

loadDotEnv();
const cfg = ng.config();
const today = () => new Date().toISOString().slice(0, 10);

/** ORDERED and STABLE: the leaf index is part of the tree identity. Never reorder. */
const REPORT_FIELDS = ["crystal", "coinsSold", "crystalFromCoins", "batches", "meals", "replies", "openers", "conversations", "explores"];
// predictions committed before the vault migration live on the public vault
const LEGACY_VAULT = "9b97a6764805789852351a401b7cfc137097d591cabe33926dfbc42792c00137";
const MILESTONES = [1_000_000, 500_000, 250_000, 100_000, 50_000, 25_000, 10_000, 5_000, 1_000];
// further daily ZK claims over the same report: field >= floor(value / step) * step
// (the real value stays hidden; a claim is skipped when the rounded threshold is 0)
const EXTRA_PREDICATES = [
  { field: "coinsSold", step: 100 },
  { field: "replies", step: 50 },
  { field: "conversations", step: 50 },
  { field: "batches", step: 5 },
];
// daily cross-report diff: at least this many of the 9 fields differ from yesterday (0 = off)
const DIFF_MIN_FIELDS = Number(process.env.NIGHTGATE_DIFF_MIN_FIELDS ?? 3);

/** Rounded-down thresholds for the extra claims: [{ field, threshold }], zeros dropped. */
export function planPredicates(document, plan = EXTRA_PREDICATES) {
  return plan
    .map(({ field, step }) => ({ field, threshold: Math.floor((Number(document[field]) || 0) / step) * step }))
    .filter((p) => p.threshold > 0);
}

function readDocProof(date) {
  try { return JSON.parse(fs.readFileSync(path.join(ng.docProofsDir, `${date}.json`), "utf8")); } catch { return null; }
}
function listDocProofs() {
  try { return fs.readdirSync(ng.docProofsDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(); } catch { return []; }
}
function readPredictions() {
  try { return JSON.parse(fs.readFileSync(ng.predictionsFile, "utf8")); } catch { return []; }
}
function writePredictions(list) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(ng.predictionsFile, JSON.stringify(list.slice(-60), null, 2));
}

/** Queue proveFieldPredicate against an anchored report document. */
function enqueuePredicate(dp, fieldName, op, threshold, { kick = true } = {}) {
  const f = dp.fields.find((x) => x.field === fieldName);
  if (!f) throw new Error(`field ${fieldName} not in doc proof (have: ${dp.fields.map((x) => x.field).join(",")})`);
  return ng.enqueue({
    kind: `predicate:${fieldName}`,
    call: "proveFieldPredicate",
    params: { payloadHash: dp.payloadHash, fieldKey: f.fieldKey, threshold: String(threshold), op },
    merkleProof: { fieldValue: f.value, fieldSalt: f.salt, siblings: f.siblings, dirs: f.dirs },
    meta: { field: fieldName, date: dp.date },
  }, { kick });
}

// ---------- daily flow ----------

async function daily() {
  if (!cfg.enabled) { log("nightgate attestation not configured (NIGHTGATE_ATTEST/SEED_HEX/TOKEN) - nothing to do"); return; }
  const file = process.argv[2] && !["prove", "diff"].includes(process.argv[2])
    ? process.argv[2] : path.join(dataDir, "last-report.md");
  if (!fs.existsSync(file)) throw new Error(`report file not found: ${file}`);
  const date = today();

  // 1. structured document over the day's numbers + the rendered report's hash.
  // The window ends when the report file was written, so a re-run (or a late
  // child) reproduces the report's numbers instead of a shifted window.
  const endMs = Math.min(fs.statSync(file).mtimeMs, Date.now());
  const d = report.collect(24 * 3600_000, endMs);
  if (!d.events) throw new Error(`journal has no events in the report window (ending ${new Date(endMs).toISOString()}) - refusing to anchor an all-zero document`);
  const document = {
    date, agentId: ng.AGENT_ID,
    crystal: d.crystalEnd ?? 0,
    coinsSold: d.coinsSold, crystalFromCoins: d.crystalFromCoins, batches: d.batches,
    meals: d.meals, replies: d.replies, openers: d.openers,
    conversations: d.conversations, explores: d.explores.length,
    reportSha256: ng.sha256hex(fs.readFileSync(file)),
  };
  let dp = readDocProof(date);
  if (!dp) {
    const prepared = await ng.prepareDocumentProof(document, REPORT_FIELDS.map((f) => ({ field: f, kind: "uint", scale: 1 })), cfg);
    dp = { date, document, ...prepared };
    fs.mkdirSync(ng.docProofsDir, { recursive: true });
    fs.writeFileSync(path.join(ng.docProofsDir, `${date}.json`), JSON.stringify(dp, null, 1));
    log(`report document prepared: payloadHash ${dp.payloadHash}`);
  } else {
    log(`report document for ${date} already prepared - reusing`);
  }

  // 2. anchor the document + its content root
  const meta = { v: 1, agentId: ng.AGENT_ID, kind: "daily-report", date };
  if (!ng.alreadyAttested(dp.payloadHash)) {
    ng.enqueue({
      kind: "report", call: "attest",
      params: { payloadHash: dp.payloadHash, metadataHash: ng.sha256hex(JSON.stringify(meta)) },
      meta,
    }, { kick: false });
    ng.enqueue({
      kind: "report-root", call: "anchorContentRoot",
      params: { payloadHash: dp.payloadHash, contentRoot: dp.contentRoot, schemaId: dp.schemaId },
      meta,
    }, { kick: false });
  }

  // 3. daily milestone predicate: crystal >= largest round milestone below the real value
  const milestone = MILESTONES.find((m) => (document.crystal ?? 0) >= m);
  if (milestone && !ng.history().some((a) => a.ok && a.kind === "predicate:crystal" && a.date === date)) {
    enqueuePredicate(dp, "crystal", 1, milestone, { kick: false });
    log(`queued ZK claim: crystal >= ${milestone} (real value stays hidden)`);
  }
  // 3b. more claims over the same anchored document (one tx each)
  for (const { field, threshold } of planPredicates(document)) {
    if (ng.history().some((a) => a.ok && a.kind === `predicate:${field}` && a.date === date)) continue;
    enqueuePredicate(dp, field, 1, threshold, { kick: false });
    log(`queued ZK claim: ${field} >= ${threshold} (real value stays hidden)`);
  }
  // 3c. yesterday vs today: at least DIFF_MIN_FIELDS fields changed (which ones stays hidden)
  const prevDate = listDocProofs().filter((d) => d < date).at(-1);
  const prev = prevDate ? readDocProof(prevDate) : null;
  if (prev && DIFF_MIN_FIELDS > 0 && !ng.history().some((a) => a.ok && a.kind === "report-diff" && a.date === date)) {
    ng.enqueue({
      kind: "report-diff", call: "proveFieldsDiffer",
      params: { payloadHashA: prev.payloadHash, payloadHashB: dp.payloadHash, k: DIFF_MIN_FIELDS },
      docPair: { schema: prev.schema, openingA: prev.opening, openingB: dp.opening },
      meta: { dateA: prevDate, dateB: date },
    }, { kick: false });
    log(`queued ZK claim: >= ${DIFF_MIN_FIELDS} report fields differ between ${prevDate} and ${date}`);
  }

  // 4. predictions: reveal yesterday's commit, then commit today's
  const preds = readPredictions();
  for (const p of preds) {
    if (!p.revealed && p.date < date && ng.history().some((a) => a.ok && a.commitment === p.commitment)) {
      ng.enqueue({
        kind: "prediction-reveal", call: "attestReveal",
        params: { payloadHash: p.payloadHash, metadataHash: p.metadataHash, nonce: p.nonce },
        doc: p.prediction, meta: { kind: "prediction", date: p.date },
        vault: p.vault || LEGACY_VAULT, // reveal must hit the vault the commit landed on
      }, { kick: false });
      p.revealed = true;
      // score it: this morning's document covers the predicted day
      const predicted = p.prediction?.predictedCoins;
      if (typeof predicted === "number") {
        p.actual = document.coinsSold;
        p.errorPct = predicted ? Math.round(((p.actual - predicted) / predicted) * 100) : null;
      }
      log(`queued reveal of the ${p.date} prediction: ${JSON.stringify(p.prediction)} (actual: ${p.actual ?? "?"}, error ${p.errorPct ?? "?"}%)`);
    }
  }
  if (!preds.some((p) => p.date === date)) {
    // predicted coins = rounded average of the last 3 days of batches, clamped
    const batches = journal.since(Date.now() - 72 * 3600_000).filter((e) => e.type === "batch");
    const perDay = batches.reduce((a, e) => a + (e.sold || 0), 0) / 3;
    const predictedCoins = Math.min(2000, Math.max(50, Math.round(perDay / 10) * 10)) || 300;
    // canonical prediction/v1 envelope (docs/SCHEMAS.md); the commitment binds
    // the payloadHash + the SERVER-computed metadataHash over metaJson
    const can = canonical("prediction", { predictedCoins }, { agentId: ng.AGENT_ID, date });
    const prediction = can.envelope;
    const payloadHash = can.payloadHash;
    const c = await ng.prepareAnchorCommitment(payloadHash, can.metaJson, cfg);
    preds.push({ date, prediction, payloadHash, metadataHash: c.metadataHash, nonce: c.nonce, commitment: c.commitment, vault: cfg.vault, revealed: false });
    ng.enqueue({ kind: "prediction-commit", call: "attestCommit", params: { commitment: c.commitment }, meta: { date } }, { kick: false });
    log(`committing today's prediction (hidden until tomorrow): ${predictedCoins} coins`);
  }
  writePredictions(preds);

  // 5. drain the queue serially in this process
  await drain();

  // 6. refresh the public proof ledger (reports/dashboard.html)
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [path.join(scriptsDir, "dashboard.mjs")], { stdio: "ignore" });
    log("dashboard refreshed");
  } catch (e) { log("dashboard refresh failed:", e.message); }
}

// ---------- CLI: on-demand ZK claims ----------

async function prove([fieldName, dir, threshold, date]) {
  if (!fieldName || !["min", "max"].includes(dir) || !threshold) {
    throw new Error("usage: attest-report.mjs prove <field> min|max <threshold> [date]");
  }
  const d = date || listDocProofs().at(-1);
  if (!d) throw new Error("no anchored report documents yet - run the daily flow first");
  const dp = readDocProof(d);
  if (!dp) throw new Error(`no doc proof for ${d}`);
  log(`ZK claim on the ${d} report: ${fieldName} ${dir === "min" ? ">=" : "<="} ${threshold}`);
  enqueuePredicate(dp, fieldName, dir === "min" ? 1 : 0, Number(threshold), { kick: false });
  await drain();
}

async function diff([k, dateA, dateB]) {
  const dates = listDocProofs();
  const a = dateA || dates.at(-2), b = dateB || dates.at(-1);
  if (!a || !b) throw new Error("need two anchored report documents (dates: " + dates.join(",") + ")");
  const dpA = readDocProof(a), dpB = readDocProof(b);
  if (!dpA || !dpB) throw new Error(`missing doc proof for ${a} or ${b}`);
  log(`ZK claim: at least ${k || 1} field(s) differ between the ${a} and ${b} reports (which ones stays hidden)`);
  ng.enqueue({
    kind: "report-diff", call: "proveFieldsDiffer",
    params: { payloadHashA: dpA.payloadHash, payloadHashB: dpB.payloadHash, k: Number(k || 1) },
    docPair: { schema: dpA.schema, openingA: dpA.opening, openingB: dpB.opening },
    meta: { dateA: a, dateB: b },
  }, { kick: false });
  await drain();
}

// Only run when executed directly (life.mjs spawns this file as a child).
// Importing the module - e.g. for planPredicates() in a test - must never
// kick off a real on-chain daily run.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const [sub, ...rest] = process.argv.slice(2);
  (sub === "prove" ? prove(rest) : sub === "diff" ? diff(rest) : daily()).catch((e) => {
    log("attest failed:", e.message);
    try { journal.note("attest", { ok: false, error: e.message.slice(0, 200) }); } catch { /* ignore */ }
    process.exit(1);
  });
}
