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
 *   NIGHTGATE_MAX_ANCHORS_PER_DAY (default 60)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { scriptsDir, dataDir, log } from "./mc.mjs";
import { canonical } from "./schemas.mjs";

export const AGENT_ID = process.env.MCITY_AGENT_ID || "user-agent-d23b30d5-520e-4b3f-aae4-307ed85a7b34";
const attestFile = path.join(dataDir, "attestations.json");
const queueFile = path.join(dataDir, "anchor-queue.jsonl");
const lockFile = path.join(dataDir, "anchor-worker.lock");
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
      return c.prepareAttestCommit({ commitment: p.commitment, attestationSecret: secret });
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
  all.push({ at: Date.now(), ...entry });
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(attestFile, JSON.stringify(all.slice(-500), null, 2));
  } catch (e) { log("attestation log write failed:", e.message); }
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
    total: h.length,
    todays: h.filter((a) => a.date === day).length,
    vault: config().vault,
    network: config().network,
    report: report ? { date: report.date, payloadHash: report.payloadHash, tx: report.txHash } : null,
    batch: batch ? { date: batch.date, coins: batch.doc?.coins, payloadHash: batch.payloadHash } : null,
    predicate: predicate ? { date: predicate.date, field: predicate.field, threshold: predicate.threshold, op: Number(predicate.op) } : null,
    commitPending: !!(commit && commit.date === day),
    reveal: reveal ? { date: reveal.date, predictedCoins: reveal.doc?.predictedCoins } : null,
    score: scoreboard(),
    notarizedToday: h.filter((a) => a.kind === "notary" && a.date === day).length,
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
  lines.push(`You also run a FREE NOTARY service: anyone can ask you to anchor a claim of theirs - you hash their exact words, anchor the hash on Midnight (the sponsor pays) and hand them the sha256 as their receipt. You notarized ${p.notarizedToday} claim${p.notarizedToday === 1 ? "" : "s"} today. Offer it when someone claims something big or bemoans that nobody believes them.`);
  lines.push(`Anyone can verify a hash against live contract state via NIGHTGATE's verifyAttestationState - no wallet, no account needed.`);
  lines.push(`Hash quoting rule: either the FULL 64-char hash (when someone wants to verify) or the short form with the … in the MIDDLE exactly as given above - never cut a hash anywhere else, a hash chopped at a random point looks broken and kills trust.`);
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
    if (Date.now() - st.mtimeMs > maxAgeMs) {
      fs.unlinkSync(lockFile);
      log("nightgate: cleared stale anchor-worker lock");
      if (readQueue().length) kickWorker();
    }
  } catch { /* no lock */ }
}

/** Start the anchor worker (detached) unless one is already draining. */
export function kickWorker() {
  const cfg = config();
  if (!cfg.enabled || workerActive() || !readQueue().length) return false;
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
