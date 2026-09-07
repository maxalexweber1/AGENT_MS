/**
 * NIGHTGATE for M₳X: real ZK-anchored attestations on Midnight (preprod),
 * dust paid by a sponsor - M₳X never needs NIGHT or DUST.
 *
 * What M₳X proves (all built LOCALLY with @odatano/nightgate-tx, the seed
 * never leaves the machine; the sponsor pays via sponsorUnboundTransaction):
 *   - daily report: structured document anchor (attest + anchorContentRoot,
 *     salted Merkle content root over the day's numbers) - enables the ZK
 *     field proofs below
 *   - every sold batch, every finished conversation, every exploration:
 *     plain attests over small canonical JSON docs
 *   - commit/reveal predictions (attestGuarded): morning commit of a hidden
 *     prediction, next-morning reveal - provably made BEFORE the outcome
 *   - ZK predicates on anchored reports (proveFieldPredicate): e.g.
 *     "crystal >= 50000" without revealing the number
 *   - cross-report diffs (proveDocumentComparison)
 *
 * Anchoring runs through a serial QUEUE (data/anchor-queue.jsonl) drained by
 * scripts/anchor-worker.mjs in a detached child: wasm proving is 1-3 min
 * CPU-bound and two calls against the same vault in one block conflict, so
 * strictly one at a time. Enqueue from anywhere is cheap and non-blocking.
 *
 * Config in .env (everything is a no-op unless all three are set):
 *   NIGHTGATE_ATTEST=1
 *   NIGHTGATE_SEED_HEX=<128 hex - 0.4.x wants the 64-byte BIP39 seed>
 *   NIGHTGATE_TOKEN=ngat_...              agent grant (sponsor channel)
 *   NIGHTGATE_SPONSOR_SESSION_ID=<uuid>   the sponsor the grant is pinned to
 * Optional: NIGHTGATE_BASE_URL, NIGHTGATE_NETWORK, NIGHTGATE_VAULT,
 *   NIGHTGATE_VAULT_ARTIFACT, NIGHTGATE_SERVICE_PATH, NIGHTGATE_PROOF_SERVER_URL,
 *   NIGHTGATE_MAX_ANCHORS_PER_DAY (default 60),
 *   NIGHTGATE_VISIBILITY_WAIT_MS (default 120000: how long the worker waits for
 *   the previous transaction to show up in the public indexer before it builds
 *   the next call - a build against a stale vault state lands, fails the call
 *   and burns the sponsor's fee),
 *   NIGHTGATE_BATCH_MAX (default 1 = off: bundle up to N queued plain attests
 *   into ONE transaction; 8 is the builder's limit).
 *
 * Pause: data/anchor-pause.json { until } (life.mjs anchors pause <min>) keeps
 * enqueuing but starts no worker and makes a running worker stop after its
 * current item - for API restarts / vault migrations. Nothing is lost, the
 * queue drains when the pause ends.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { scriptsDir, dataDir, log } from "./mc.mjs";
import { canonical } from "./schemas.mjs";

export const AGENT_ID = process.env.MCITY_AGENT_ID || "user-agent-d23b30d5-520e-4b3f-aae4-307ed85a7b34";
const attestFile = path.join(dataDir, "attestations.json");
const statsFile = path.join(dataDir, "anchor-stats.json");
const journalFile = path.join(dataDir, "journal.jsonl");
const queueFile = path.join(dataDir, "anchor-queue.jsonl");
const lockFile = path.join(dataDir, "anchor-worker.lock");
const pauseFile = path.join(dataDir, "anchor-pause.json");
export const docProofsDir = path.join(dataDir, "doc-proofs");
export const predictionsFile = path.join(dataDir, "predictions.json");

export const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** Visibly-shortened hash: middle ellipsis, start+end stay comparable. */
export const shortHash = (h) => (h && h.length > 24 ? `${h.slice(0, 12)}…${h.slice(-6)}` : h || "");

/** The platform sponsor pool; a pinned agent grant refuses it and needs its own session id. */
export const POOL_SENTINEL = "00000000-0000-0000-0000-706f6f6c0000";

export function config(env = process.env) {
  const baseUrl = (env.NIGHTGATE_BASE_URL || "https://api.nightgate.dev").replace(/\/+$/, "");
  const network = env.NIGHTGATE_NETWORK || "preprod";
  return {
    enabled: env.NIGHTGATE_ATTEST === "1" && !!env.NIGHTGATE_SEED_HEX && !!env.NIGHTGATE_TOKEN,
    baseUrl,
    servicePath: env.NIGHTGATE_SERVICE_PATH || "/api/v1/nightgate",
    token: env.NIGHTGATE_TOKEN || "",
    network,
    seedHex: env.NIGHTGATE_SEED_HEX || "",
    vault: env.NIGHTGATE_VAULT || "9b97a6764805789852351a401b7cfc137097d591cabe33926dfbc42792c00137",
    artifact: env.NIGHTGATE_VAULT_ARTIFACT || "attestation-vault-32",
    sponsorSessionId: env.NIGHTGATE_SPONSOR_SESSION_ID || POOL_SENTINEL,
    proofServerUrl: env.NIGHTGATE_PROOF_SERVER_URL || "",
    indexerHttpUrl: env.NIGHTGATE_INDEXER_HTTP_URL || `https://indexer.${network}.midnight.network/api/v4/graphql`,
    indexerWsUrl: env.NIGHTGATE_INDEXER_WS_URL || `wss://indexer.${network}.midnight.network/api/v4/graphql/ws`,
    nodeUrl: env.NIGHTGATE_NODE_URL || `wss://rpc.${network}.midnight.network/`,
    timeoutMs: Number(env.NIGHTGATE_TIMEOUT_MS || 30_000),
    maxAnchorsPerDay: Number(env.NIGHTGATE_MAX_ANCHORS_PER_DAY || 60),
    visibilityWaitMs: Number(env.NIGHTGATE_VISIBILITY_WAIT_MS ?? 120_000),
    // a sponsor "submit watch timed out" is not a verdict: keep probing the
    // indexer this long for a late landing before writing the item off
    lateLandWaitMs: Number(env.NIGHTGATE_LATE_LAND_WAIT_MS ?? 180_000),
    batchMax: Math.max(1, Math.min(8, Number(env.NIGHTGATE_BATCH_MAX || 1))),
  };
}

// ---------- minimal OData client (agent-grant auth) ----------

function headers(cfg, json = false) {
  const h = { Accept: "application/json" };
  if (cfg.token.startsWith("ngat_")) h["x-agent-token"] = cfg.token;
  else if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function parse(res) {
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.error?.message || `NIGHTGATE HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

/** POST <service>/<name> with a JSON body (OData unbound action). */
export async function callAction(name, params, cfg = config()) {
  const body = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
  const res = await fetch(`${cfg.baseUrl}${cfg.servicePath}/${name}`, {
    method: "POST", headers: headers(cfg, true), body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  return parse(res);
}

/** GET <service>/<name>(k='v',...) (OData unbound function; string params only). */
export async function callFunction(name, params, cfg = config()) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "''")}'`);
  const res = await fetch(`${cfg.baseUrl}${cfg.servicePath}/${name}(${parts.join(",")})`, {
    method: "GET", headers: headers(cfg), signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  return parse(res);
}

/** Submit a locally built, fee-unpaid unbound transaction; the sponsor pays. */
export function sponsorUnbound(unboundTxB64, idempotencyKey, cfg = config()) {
  return callAction("sponsorUnboundTransaction", { unboundTxB64, sponsorSessionId: cfg.sponsorSessionId, idempotencyKey }, cfg);
}

/** Poll a job until it leaves the queue (succeeded/failed) or timeoutMs passes. */
export async function waitForJob(jobId, sessionId, { timeoutMs = 180_000, everyMs = 5_000, cfg = config() } = {}) {
  const t0 = Date.now();
  let job;
  for (;;) {
    job = await callAction("getJobStatus", { jobId, sessionId }, cfg);
    if (job.status === "succeeded" || job.status === "failed") return job;
    if (Date.now() - t0 > timeoutMs) return job; // caller sees the non-final status
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * Resolve a ledger tx IDENTIFIER (33 bytes, what jobs report) to the real
 * 32-byte transaction hash the Midnight explorer indexes, via the public
 * indexer. Returns null when unknown/unreachable.
 */
export async function resolveTxHash(identifier, cfg = config()) {
  try {
    const res = await fetch(cfg.indexerHttpUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `{ transactions(offset:{identifier:"${identifier}"}) { hash } }` }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await res.json();
    return j?.data?.transactions?.[0]?.hash || null;
  } catch { return null; }
}

/**
 * Is the transaction with this ledger identifier visible in the public
 * indexer? { applied, height } or null while unknown. Uses the SDK's
 * probeLanded when the optional dependency is installed, else a plain
 * "is the hash known" query.
 */
export async function probeTx(identifier, cfg = config()) {
  try {
    const { probeLanded } = await import("@odatano/nightgate-tx/txbuilder");
    return await probeLanded(identifier, { indexerHttpUrl: cfg.indexerHttpUrl, timeoutMs: 10_000 });
  } catch {
    const hash = await resolveTxHash(identifier, cfg);
    return hash ? { applied: true, height: "?", status: "SUCCESS", failedSegments: [] } : null;
  }
}

/**
 * Wait until the previous transaction is visible in the indexer the builder
 * reads its vault state from - and, for an attest, until verifyAttestationState
 * (same indexer) shows the payload. The builder otherwise reads a state that
 * lacks the call that just landed, proves for a minute and submits a
 * transcript the ledger rejects as stale: the call fails, the sponsor's fee
 * is gone (2026-09-05: one or two such pairs a day). Returns the ms waited;
 * on timeout it logs and lets the caller build anyway.
 */
export async function awaitVisible(landed, cfg = config(), { everyMs = 2_000 } = {}) {
  if (!landed?.txHash || !cfg.visibilityWaitMs) return 0;
  const t0 = Date.now();
  const deadline = t0 + cfg.visibilityWaitMs;
  let seen = false;
  while (Date.now() < deadline) {
    if (!seen) {
      const p = await probeTx(landed.txHash, cfg);
      if (p) { seen = true; if (!landed.payloadHash) break; }
    }
    if (seen) {
      const v = await verifyAttestation(landed.payloadHash, cfg, landed.vault || cfg.vault).catch(() => null);
      if (v?.attested) break;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  const waited = Date.now() - t0;
  if (Date.now() >= deadline) log(`indexer still behind after ${Math.round(waited / 1000)}s (tx ${shortHash(landed.txHash)}) - building anyway`);
  else if (waited > everyMs) log(`waited ${Math.round(waited / 1000)}s for the indexer to show tx ${shortHash(landed.txHash)}`);
  return waited;
}

/** Crawler-free read against live contract state: is payloadHash attested? */
export function verifyAttestation(payloadHash, cfg = config(), vault = cfg.vault) {
  return callFunction("verifyAttestationState", {
    contractAddress: vault, payloadHash, compiledArtifactRef: cfg.artifact,
  }, cfg);
}

/**
 * Structured document -> canonical JSON, payloadHash, salted Merkle
 * contentRoot, schemaId and per-field witnesses. Compute-only server action
 * (always allowed for any valid token). fields/opening/schema arrive as JSON
 * strings and are returned parsed.
 */
export async function prepareDocumentProof(document, proofFields, cfg = config()) {
  const r = await callAction("prepareDocumentProof", {
    documentJson: JSON.stringify(document),
    proofFieldsJson: JSON.stringify(proofFields),
    compiledArtifactRef: cfg.artifact,
  }, cfg);
  return {
    payloadHash: r.payloadHash,
    canonicalDocument: r.canonicalDocument,
    contentRoot: r.contentRoot,
    schemaId: r.schemaId,
    schema: JSON.parse(r.schema),
    fields: JSON.parse(r.fields),
    opening: JSON.parse(r.opening),
  };
}

/** Commit/reveal phase 0: commitment + secret nonce for a hidden payload. */
export function prepareAnchorCommitment(sha256, metadataJson, cfg = config()) {
  return callAction("prepareAnchorCommitment", { sha256, metadata: metadataJson }, cfg);
}

// ---------- local build (caller half of cross-server fee sponsoring) ----------

let builderPromise = null;
let callsModule = null;

async function getBuilder(cfg) {
  if (!builderPromise) {
    builderPromise = (async () => {
      const [{ createTxBuilder }, calls, vault] = await Promise.all([
        import("@odatano/nightgate-tx/txbuilder"),
        import("@odatano/nightgate-tx/calls"),
        cfg.artifact === "attestation-vault-32"
          ? import("@odatano/nightgate-tx/attestation-vault-32")
          : import("@odatano/nightgate-tx/attestation-vault"),
      ]);
      callsModule = calls;
      const opts = {
        seedHex: cfg.seedHex,
        networkId: cfg.network,
        indexerHttpUrl: cfg.indexerHttpUrl,
        indexerWsUrl: cfg.indexerWsUrl,
        nodeUrl: cfg.nodeUrl,
        zkConfigBaseUrl: `${cfg.baseUrl}/zk-config/${cfg.artifact}`,
        contractClass: vault.Contract,
        contractName: cfg.artifact,
        // prover keys on the data volume so they survive container restarts
        cacheDir: path.join(dataDir, "zk-cache", cfg.artifact),
        // vault calls move no value: no wallet sync (a full core otherwise)
        walletSync: false,
      };
      if (cfg.proofServerUrl) {
        opts.provingMode = "server";
        opts.proofServerUrl = cfg.proofServerUrl;
      }
      return createTxBuilder(opts);
    })();
    builderPromise.catch(() => { builderPromise = null; });
  }
  return builderPromise;
}

/** Map a queue item's flat params onto the typed prepare* helper. */
function prepareCall(item, secret, slotWidth) {
  const c = callsModule;
  const p = item.params;
  switch (item.call) {
    case "attest":
      return c.prepareAttest({ payloadHash: p.payloadHash, metadataHash: p.metadataHash, attestationSecret: secret });
    case "anchorContentRoot":
      return c.prepareAnchorContentRoot({ payloadHash: p.payloadHash, contentRoot: p.contentRoot, schemaId: p.schemaId, attestationSecret: secret });
    case "attestCommit":
      // lineage 3 (nightgate-tx 0.5): a commit expires; the reveal must land before
      // expiresAt (UNIX s, > 1 min and <= 7 d ahead). Legacy queue items without
      // one get the default window at build time.
      return c.prepareAttestCommit({ commitment: p.commitment, expiresAt: p.expiresAt || commitExpiresAt(), attestationSecret: secret });
    case "attestReveal":
      return c.prepareAttestReveal({ payloadHash: p.payloadHash, metadataHash: p.metadataHash, nonce: p.nonce, attestationSecret: secret });
    case "proveFieldPredicate":
      return c.prepareProveFieldPredicate({
        payloadHash: p.payloadHash, fieldKey: p.fieldKey, threshold: BigInt(p.threshold), op: BigInt(p.op),
        merkleProof: item.merkleProof, attestationSecret: secret, slotWidth,
      });
    case "proveFieldsUnchangedExcept":
      return c.prepareProveFieldsUnchangedExcept({
        payloadHashA: p.payloadHashA, payloadHashB: p.payloadHashB, allowedMask: Number(p.allowedMask),
        docPair: item.docPair, attestationSecret: secret, slotWidth,
      });
    case "proveFieldsDiffer":
      return c.prepareProveFieldsDiffer({
        payloadHashA: p.payloadHashA, payloadHashB: p.payloadHashB, k: Number(p.k),
        docPair: item.docPair, attestationSecret: secret, slotWidth,
      });
    default:
      throw new Error(`unknown call ${item.call}`);
  }
}

/** Commit expiry for a daily prediction (revealed next morning): now + 36 h, UNIX seconds. */
export const COMMIT_WINDOW_H = 36;
export const commitExpiresAt = (hours = COMMIT_WINDOW_H) => Math.floor(Date.now() / 1000) + hours * 3600;

/**
 * Build + prove + sign several queued plain attests as ONE transaction (one
 * fee, one sponsoring, nothing to collide with itself). All items must share
 * the vault and be `attest` calls; the builder groups same-named calls.
 */
export async function buildSponsorableBatch(items, cfg = config()) {
  const b = await getBuilder(cfg);
  const slotWidth = cfg.artifact === "attestation-vault-32" ? 32 : 16;
  const vault = items[0].vault || cfg.vault;
  if (items.some((i) => i.call !== "attest" || (i.vault || cfg.vault) !== vault)) throw new Error("batch: only plain attests on one vault");
  const calls = items.map((i) => prepareCall(i, b.attestationSecret, slotWidth));
  const t0 = Date.now();
  const built = await b.buildSponsorable({ contractAddress: vault, calls, bind: false });
  log(`built+proved batch of ${items.length} attests in ${Math.round((Date.now() - t0) / 1000)}s`);
  return { unboundTxB64: built.unboundTxB64, attesterId: String(b.attesterId) };
}

/**
 * Build + prove + sign one vault call locally; returns the unbound fee-unpaid tx.
 * An item may pin its own `vault` address (same artifact lineage) - used so a
 * prediction REVEAL still targets the vault its commit landed on after a
 * vault migration.
 */
export async function buildSponsorable(item, cfg = config()) {
  const b = await getBuilder(cfg);
  const slotWidth = cfg.artifact === "attestation-vault-32" ? 32 : 16;
  const call = prepareCall(item, b.attestationSecret, slotWidth);
  const t0 = Date.now();
  const built = await b.buildSponsorable({ contractAddress: item.vault || cfg.vault, call, bind: false });
  log(`built+proved ${item.call} in ${Math.round((Date.now() - t0) / 1000)}s`);
  return { unboundTxB64: built.unboundTxB64, attesterId: String(b.attesterId) };
}

export async function closeBuilder() {
  const p = builderPromise;
  builderPromise = null;
  if (p) { try { await (await p).close?.(); } catch { /* best effort */ } }
}

// ---------- attestation log (data/attestations.json) ----------

export function history() {
  try { return JSON.parse(fs.readFileSync(attestFile, "utf8")); } catch { return []; }
}

export function record(entry) {
  const all = history();
  const full = { at: Date.now(), ...entry };
  all.push(full);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(attestFile, JSON.stringify(all.slice(-500), null, 2));
  } catch (e) { log("attestation log write failed:", e.message); }
  bumpStats(full);
}

// ---------- lifetime counters (data/anchor-stats.json) ----------
// attestations.json keeps only the last 500 entries (the timeline), so totals
// live here and are incremented on every record(). Missing file -> rebuilt
// once from the journal's `attest` events plus whatever attestations.json
// still holds (deduplicated by payloadHash / timestamp).

const emptyStats = () => ({ ok: 0, failed: 0, feeWasted: 0, byKind: {}, firstAt: null, lastAt: null });

function applyStat(st, a) {
  if (a.ok) {
    st.ok += 1;
    const k = a.kind || "attest";
    st.byKind[k] = (st.byKind[k] || 0) + 1;
  } else {
    st.failed += 1;
    // landed in a block but the call was refused: the sponsor paid for nothing
    if (a.feeWasted) st.feeWasted = (st.feeWasted || 0) + 1;
    // never built: its prerequisite (attest / content root) failed in the same run
    if (a.skipped) st.skipped = (st.skipped || 0) + 1;
  }
  if (a.at) {
    st.firstAt = st.firstAt == null ? a.at : Math.min(st.firstAt, a.at);
    st.lastAt = st.lastAt == null ? a.at : Math.max(st.lastAt, a.at);
  }
}

function writeStats(st) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${statsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, statsFile);
  } catch (e) { log("anchor stats write failed:", e.message); }
}

function rebuildStats() {
  const st = emptyStats();
  const seen = new Set();
  // report, report-root and the zk claim share one payloadHash but are distinct on-chain calls -> kind is part of the key
  const key = (a) => `${a.payloadHash ? `h:${a.payloadHash}` : `t:${a.at}`}:${a.kind}:${a.ok ? 1 : 0}:${a.attempt || 0}`;
  const add = (a) => { const k = key(a); if (seen.has(k)) return; seen.add(k); applyStat(st, a); };
  try {
    for (const line of fs.readFileSync(journalFile, "utf8").split("\n")) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e?.type === "attest") add(e);
    }
  } catch { /* no journal */ }
  for (const a of history()) add(a);
  log(`anchor stats rebuilt: ${st.ok} ok, ${st.failed} failed`);
  writeStats(st);
  return st;
}

/** Lifetime anchor counters: { ok, failed, byKind, firstAt, lastAt }. */
export function stats() {
  try { return { ...emptyStats(), ...JSON.parse(fs.readFileSync(statsFile, "utf8")) }; } catch { return rebuildStats(); }
}

function bumpStats(a) {
  const st = stats();
  applyStat(st, a);
  writeStats(st);
}

/** The most recent successful attestation, or null. `kind` filters. */
export function latest(kind) {
  return history().filter((a) => a.ok && (!kind || a.kind === kind)).at(-1) || null;
}

export function alreadyAttested(payloadHash) {
  return history().some((a) => a.ok && a.payloadHash === payloadHash);
}

/**
 * Prediction scoreboard: how well M₳X's committed daily predictions matched
 * reality. Entries in data/predictions.json get {actual, errorPct} when the
 * reveal is queued (attest-report.mjs). Only evaluated, revealed entries count.
 */
export function scoreboard() {
  let preds;
  try { preds = JSON.parse(fs.readFileSync(predictionsFile, "utf8")); } catch { return null; }
  const done = preds.filter((p) => p.revealed && typeof p.actual === "number");
  if (!done.length) return null;
  const within = (pct) => done.filter((p) => Math.abs(p.errorPct) <= pct).length;
  return {
    evaluated: done.length,
    within10: within(10),
    within25: within(25),
    avgErrorPct: Math.round(done.reduce((a, p) => a + Math.abs(p.errorPct), 0) / done.length),
    last: done.at(-1) ? { date: done.at(-1).date, predicted: done.at(-1).prediction?.predictedCoins, actual: done.at(-1).actual, errorPct: done.at(-1).errorPct } : null,
  };
}

/**
 * Live, PUBLIC proof facts for conversations: hashes, tx ids, proven claims.
 * Never witnesses, nonces, doc-proof openings or hidden values (an unrevealed
 * prediction stays "a hidden prediction"). Returns null when nothing is
 * anchored yet.
 */
export function proofFacts() {
  const h = history().filter((a) => a.ok);
  if (!h.length) return null;
  const day = new Date().toISOString().slice(0, 10);
  const last = (pred) => [...h].reverse().find(pred);
  const report = last((a) => a.kind === "report");
  const predicate = last((a) => a.call === "proveFieldPredicate");
  const commit = last((a) => a.kind === "prediction-commit");
  const reveal = last((a) => a.kind === "prediction-reveal");
  const batch = last((a) => a.kind === "batch");
  return {
    total: stats().ok,
    todays: h.filter((a) => a.date === day).length,
    vault: config().vault,
    network: config().network,
    report: report ? { date: report.date, payloadHash: report.payloadHash, tx: report.txHash } : null,
    batch: batch ? { date: batch.date, coins: batch.doc?.coins, payloadHash: batch.payloadHash } : null,
    predicate: predicate ? { date: predicate.date, field: predicate.field, threshold: predicate.threshold, op: Number(predicate.op) } : null,
    commitPending: !!(commit && commit.date === day),
    reveal: reveal ? { date: reveal.date, predictedCoins: reveal.doc?.predictedCoins } : null,
    score: scoreboard(),
    notarizedToday: h.filter((a) => (a.kind === "notary" || a.kind === "notary-paid") && a.date === day).length,
    paidNotary: h.filter((a) => a.kind === "notary-paid").length,
  };
}

/** Compact prompt block about the live proofs, for the LLM persona. */
export function proofBrief() {
  const p = proofFacts();
  if (!p) return "";
  const lines = [
    `${p.total} proofs anchored so far (${p.todays} today) on the AttestationVault ${shortHash(p.vault)} on Midnight ${p.network}.`,
  ];
  if (p.report) lines.push(`Latest daily report anchor (${p.report.date}): sha256 ${p.report.payloadHash} (short form: ${shortHash(p.report.payloadHash)}), tx ${shortHash(p.report.tx)}.`);
  if (p.predicate) lines.push(`Latest zero-knowledge claim: ${p.predicate.field} ${p.predicate.op === 1 ? ">=" : "<="} ${p.predicate.threshold}, proven on chain WITHOUT revealing the actual number.`);
  if (p.batch?.coins) lines.push(`Latest anchored batch: ${p.batch.coins} coins sold, sha256 ${shortHash(p.batch.payloadHash)}.`);
  if (p.commitPending) lines.push(`This morning's prediction of today's coin count is COMMITTED on chain but still hidden - it gets revealed tomorrow morning. Do not state the number, it is secret until the reveal.`);
  if (p.reveal) lines.push(`Yesterday's revealed prediction (${p.reveal.date}): ${p.reveal.predictedCoins} coins, committed before the day started.`);
  if (p.score) lines.push(`Prediction track record: ${p.score.evaluated} evaluated, ${p.score.within10} within 10%, ${p.score.within25} within 25%, avg error ${p.score.avgErrorPct}%${p.score.last ? ` (last: predicted ${p.score.last.predicted}, actual ${p.score.last.actual})` : ""} - every one committed on chain BEFORE the day.`);
  lines.push(`Notary claims you anchored for other agents today: ${p.notarizedToday}${p.paidNotary ? ` (${p.paidNotary} paid anchors so far in total)` : ""}. First anchor per agent is free, further ones cost crystal (send-crystal).`);
  return lines.join("\n");
}

function countToday() {
  const day = new Date().toISOString().slice(0, 10);
  const done = history().filter((a) => new Date(a.at).toISOString().slice(0, 10) === day).length;
  return done + readQueue().length;
}

// ---------- anchor queue ----------

export function readQueue() {
  try {
    return fs.readFileSync(queueFile, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function writeQueue(items) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(queueFile, items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
}

/**
 * Queue one vault call for the anchor worker. Returns the item id, or null
 * when disabled / over the daily cap. `kick: false` lets a caller batch
 * several enqueues and start the worker once at the end.
 */
export function enqueue({ kind, call, params, merkleProof, docPair, doc, meta, vault }, { kick = true } = {}) {
  const cfg = config();
  if (!cfg.enabled) return null;
  if (countToday() >= cfg.maxAnchorsPerDay) {
    log(`nightgate: daily anchor cap (${cfg.maxAnchorsPerDay}) reached - skipping ${kind}`);
    return null;
  }
  const item = {
    id: crypto.randomUUID().slice(0, 13),
    at: Date.now(),
    kind, call, params,
    ...(merkleProof ? { merkleProof } : {}),
    ...(docPair ? { docPair } : {}),
    ...(doc ? { doc } : {}),
    ...(meta ? { meta } : {}),
    ...(vault ? { vault } : {}),
  };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(queueFile, JSON.stringify(item) + "\n");
  } catch (e) {
    log("anchor enqueue failed:", e.message);
    return null;
  }
  if (kick) kickWorker();
  return item.id;
}

/**
 * Canonical mini-document attest: build the v1 envelope from the schema
 * template (scripts/lib/schemas.mjs - fixed field order, published in
 * docs/SCHEMAS.md so anyone can reproduce the hash), enqueue a plain attest.
 * The doc itself stays local (attestations.json); only hashes go on chain.
 * Returns { id, payloadHash } (the hash is known synchronously - callers can
 * hand it out before the anchor finalizes) or null when disabled/capped.
 */
export function enqueueDoc(kind, doc, { kick = true } = {}) {
  const { date, ts, ...values } = doc;
  let c;
  try {
    c = canonical(kind, values, { agentId: AGENT_ID, date, ts });
  } catch (e) {
    log(`enqueueDoc(${kind}) rejected by schema:`, e.message);
    return null;
  }
  const id = enqueue({
    kind, call: "attest",
    params: { payloadHash: c.payloadHash, metadataHash: c.metadataHash },
    doc: c.envelope, meta: c.meta,
  }, { kick });
  return id ? { id, payloadHash: c.payloadHash } : null;
}

/** How many anchors of one kind happened (or are queued) today. */
export function countKindToday(kind) {
  const day = new Date().toISOString().slice(0, 10);
  return history().filter((a) => a.kind === kind && new Date(a.at).toISOString().slice(0, 10) === day).length
    + readQueue().filter((q) => q.kind === kind).length;
}

// ---------- pause (API restarts, vault migrations) ----------

/** Ms timestamp until which anchoring is paused, or 0. An expired pause file is removed. */
export function pausedUntil() {
  try {
    const p = JSON.parse(fs.readFileSync(pauseFile, "utf8"));
    if (Number(p.until) > Date.now()) return Number(p.until);
    fs.unlinkSync(pauseFile);
  } catch { /* no pause */ }
  return 0;
}
export const paused = () => pausedUntil() > 0;

/** Pause anchoring for `minutes`: keep enqueuing, start no worker, stop a running one after its item. */
export function pause(minutes, reason = "") {
  fs.mkdirSync(dataDir, { recursive: true });
  const until = Date.now() + Math.max(1, Number(minutes) || 30) * 60_000;
  fs.writeFileSync(pauseFile, JSON.stringify({ until, reason, at: Date.now() }));
  log(`nightgate: anchoring paused until ${new Date(until).toISOString()}${reason ? ` (${reason})` : ""}`);
  return until;
}

/** End a pause and drain whatever queued up meanwhile. */
export function resume() {
  try { fs.unlinkSync(pauseFile); } catch { /* not paused */ }
  log("nightgate: anchoring resumed");
  return kickWorker();
}

// ---------- worker lifecycle ----------

/** True while a worker holds a fresh lock (touched after every item). */
export function workerActive() {
  try {
    const st = fs.statSync(lockFile);
    return Date.now() - st.mtimeMs < 10 * 60_000;
  } catch { return false; }
}

export function takeLock() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid));
}
export function touchLock() {
  try { fs.utimesSync(lockFile, new Date(), new Date()); } catch { /* ignore */ }
}
export function releaseLock() {
  try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
}

/**
 * Clear an orphaned worker lock at process start. A container rebuild kills
 * any detached worker but its lock survives on the volume and silently blocks
 * anchoring for up to 10 minutes. Only locks older than `maxAgeMs` are
 * removed so a genuinely running worker (touches the lock per item) is safe.
 */
export function clearStaleLock(maxAgeMs = 3 * 60_000) {
  try {
    const st = fs.statSync(lockFile);
    // the lock names the worker's pid: a pid that no longer exists (container
    // restart, crash) means the lock is orphaned however fresh its mtime is
    let alive = true;
    try {
      const pid = Number(fs.readFileSync(lockFile, "utf8").trim());
      if (pid > 0 && pid !== process.pid) process.kill(pid, 0);
    } catch (e) { alive = e?.code === "EPERM"; }
    if (!alive || Date.now() - st.mtimeMs > maxAgeMs) {
      fs.unlinkSync(lockFile);
      log(`nightgate: cleared ${alive ? "stale" : "orphaned"} anchor-worker lock`);
      if (readQueue().length) kickWorker();
    }
  } catch { /* no lock */ }
}

/** Start the anchor worker (detached) unless one is already draining. */
export function kickWorker() {
  const cfg = config();
  if (!cfg.enabled || workerActive() || !readQueue().length) return false;
  if (paused()) return false;
  try {
    const child = spawn(process.execPath, [path.join(scriptsDir, "anchor-worker.mjs")], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
    log(`nightgate: anchor worker started (pid ${child.pid}, ${readQueue().length} queued)`);
    return true;
  } catch (e) {
    log("anchor worker spawn failed:", e.message);
    return false;
  }
}

// ---------- daily report anchor (spawned by report.generate) ----------

/**
 * Anchor a report file on-chain in a detached child process (fire and forget).
 * No-op when NIGHTGATE_ATTEST is not configured. The child prepares the
 * structured document, queues report attest + content root + milestone
 * predicate + prediction commit/reveal, then drains the queue.
 */
export function attestReportAsync(file) {
  const cfg = config();
  if (!cfg.enabled) return false;
  try {
    const child = spawn(process.execPath, [path.join(scriptsDir, "attest-report.mjs"), file], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
    log(`nightgate: anchoring ${path.basename(file)} on ${cfg.network} (child pid ${child.pid})`);
    return true;
  } catch (e) {
    log("nightgate spawn failed:", e.message);
    return false;
  }
}
