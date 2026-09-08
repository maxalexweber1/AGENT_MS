#!/usr/bin/env node
/**
 * Anchor worker: drains data/anchor-queue.jsonl STRICTLY one transaction at a time.
 *
 * Per item: wait until the PREVIOUS transaction is visible in the public
 * indexer (the builder reads the vault state from there - building against a
 * state that lacks the call that just landed produces a transcript the ledger
 * rejects: the call fails, the sponsor's fee is burned) -> build+prove+sign
 * locally -> sponsorUnboundTransaction -> poll -> on CHAIN_EXECUTION_FAILED
 * record the burned attempt, wait for the collision tx to be indexed, rebuild
 * once -> verify -> data/attestations.json + journal event `attest`. Failures
 * are recorded and dropped (no infinite retries); the queue survives crashes
 * (an item is only removed after processing).
 *
 * A sponsor "submit watch timed out without a Finalized status" is NOT a
 * verdict (2026-09-07: the daily report's tx was broadcast, the watch gave up
 * after 60 s, the tx never made it): the worker keeps probing the indexer for
 * NIGHTGATE_LATE_LAND_WAIT_MS before writing the item off. Items that depend
 * on a payload whose attest (or content root) failed IN THIS RUN - the content
 * root, every ZK claim, the diff - are skipped without building (they would
 * only trip the builder's pre-check with "no content root"); `life.mjs attest`
 * re-queues the whole set once the chain is healthy again.
 *
 * NIGHTGATE itself being down (5xx, "aborted due to timeout", connection
 * errors, a job stuck in queued/running) is not the item's fault: the item
 * stays at the head of the queue and is retried with backoff (1 min .. 30 min,
 * NIGHTGATE_OUTAGE_RETRIES times, ~2 h). Only then is it written off - with its
 * doc and metadataHash, so `life.mjs anchors retry` can re-anchor it later
 * (2026-09-08: an outage cost eight anchors and the daily report set).
 *
 * NIGHTGATE_BATCH_MAX > 1 bundles consecutive plain attests on one vault into
 * ONE transaction (one fee; a batch cannot collide with itself). A batch the
 * builder refuses up front (causality pre-check, nothing spent) falls back to
 * single-call transactions.
 *
 * A pause (data/anchor-pause.json, `life.mjs anchors pause <min>`) stops the
 * worker after its current transaction; the queue waits.
 *
 * Spawned detached by nightgate.kickWorker(); exits when the queue is empty.
 */

import os from "node:os";
import { loadDotEnv, log } from "./lib/mc.mjs";
import * as journal from "./lib/journal.mjs";
import * as ng from "./lib/nightgate.mjs";

loadDotEnv();
const cfg = ng.config();
const today = () => new Date().toISOString().slice(0, 10);

async function sponsorWithRetry(unboundTxB64, key) {
  for (let t = 1; ; t++) {
    try {
      return await ng.sponsorUnbound(unboundTxB64, key, cfg);
    } catch (e) {
      const transient = (e.status >= 500 || /fetch failed|ETIMEDOUT|ECONNRESET|timeout/i.test(e.message)) && t < 3;
      log(`sponsor submit failed (try ${t}): HTTP ${e.status || "?"} ${e.code || ""} ${e.message}`);
      if (!transient) throw e;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

const ATTEST_CALLS = new Set(["attest", "anchorContentRoot", "attestReveal"]);
const FINAL = new Set(["succeeded", "failed"]);
// wait before retry n (1-based) when NIGHTGATE is unreachable; the last value repeats
const OUTAGE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];

/** Sleep while keeping the lock fresh; returns early when a pause is requested. */
async function idle(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ng.pausedUntil()) return;
    await new Promise((r) => setTimeout(r, Math.min(30_000, until - Date.now())));
    ng.touchLock();
  }
}
// calls that leave a payload attestation the indexer can be asked about
const PAYLOAD_CALLS = new Set(["attest", "attestReveal"]);
// calls that only make sense once the payload (and its content root) is on chain
const DEPENDENT_CALLS = new Set(["anchorContentRoot", "proveFieldPredicate", "proveFieldEquality", "proveFieldMembership", "proveFieldsDiffer", "proveDocumentComparison"]);

/** The sponsor gave up watching the broadcast - the tx may still land. */
const isSubmitTimeout = (job) =>
  job?.status === "failed" && !!job.txHash && job.errorCode !== "CHAIN_EXECUTION_FAILED" &&
  /timed out|without a Finalized/i.test(job.errorMessage || "");

/**
 * Keep asking the indexer whether a broadcast tx made it after the sponsor's
 * watch gave up. Returns the job as "succeeded" (lateLanded) when it did and
 * the payload shows up, a synthetic CHAIN_EXECUTION_FAILED when it landed but
 * the call was refused, or the original failed job when it never appeared.
 */
async function awaitLateLanding(item, job, { everyMs = 5_000 } = {}) {
  if (!cfg.lateLandWaitMs) return job;
  const t0 = Date.now();
  const vault = item.vault || cfg.vault;
  log(`${item.id} ${item.kind}: sponsor watch timed out for tx ${ng.shortHash(job.txHash)} - probing the indexer for up to ${Math.round(cfg.lateLandWaitMs / 1000)}s`);
  while (Date.now() - t0 < cfg.lateLandWaitMs) {
    const p = await ng.probeTx(job.txHash, cfg).catch(() => null);
    if (p) {
      if (p.applied === false) {
        log(`${item.id} ${item.kind}: tx ${ng.shortHash(job.txHash)} landed late but the call was refused`);
        return { ...job, errorCode: "CHAIN_EXECUTION_FAILED", errorMessage: `landed late, call refused (${p.status || "?"}); ${job.errorMessage || ""}`.slice(0, 300) };
      }
      let attested = true;
      if (PAYLOAD_CALLS.has(item.call) && item.params.payloadHash) {
        const v = await ng.verifyAttestation(item.params.payloadHash, cfg, vault).catch(() => null);
        attested = !!v?.attested;
      }
      if (attested) {
        log(`${item.id} ${item.kind}: tx ${ng.shortHash(job.txHash)} landed after ${Math.round((Date.now() - t0) / 1000)}s - counting it`);
        return { ...job, status: "succeeded", errorCode: undefined, errorMessage: undefined, lateLanded: true };
      }
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  log(`${item.id} ${item.kind}: tx ${ng.shortHash(job.txHash)} still unknown after ${Math.round(cfg.lateLandWaitMs / 1000)}s - giving up`);
  return job;
}

// ---------- "is the previous transaction indexed yet?" ----------

/** The last transaction this worker (or a worker that just exited) put on chain. */
let lastLanded = null;

function noteLanded(job, item, applied) {
  if (!job?.txHash) return;
  lastLanded = {
    txHash: job.txHash,
    // only an APPLIED attest/reveal leaves a payload we can wait for
    payloadHash: applied && PAYLOAD_CALLS.has(item.call) ? item.params.payloadHash : null,
    vault: item.vault || cfg.vault,
    at: Date.now(),
  };
}

/** A fresh worker inherits the previous worker's last landed tx from the log. */
function seedLastLanded() {
  const a = [...ng.history()].reverse().find((x) => x.txHash);
  if (!a || Date.now() - a.at > 5 * 60_000) return;
  lastLanded = { txHash: a.txHash, payloadHash: a.ok && PAYLOAD_CALLS.has(a.call) ? a.payloadHash : null, vault: a.vault, at: a.at };
}

// ---------- recording ----------

function baseEntry(item) {
  return {
    kind: item.kind,
    call: item.call,
    date: today(),
    ...(item.params.payloadHash ? { payloadHash: item.params.payloadHash } : {}),
    // kept on failed entries too: together with the doc it is all a re-anchor needs
    ...(item.params.metadataHash ? { metadataHash: item.params.metadataHash } : {}),
    ...(item.params.commitment ? { commitment: item.params.commitment } : {}),
    // this item replaces an earlier failed entry (life.mjs anchors retry)
    ...(item.meta?.reanchorOf ? { reanchorOf: item.meta.reanchorOf } : {}),
    ...(item.call === "proveFieldPredicate" ? { field: item.meta?.field, threshold: item.params.threshold, op: item.params.op } : {}),
    ...(item.doc ? { doc: item.doc } : {}),
    network: cfg.network,
    vault: item.vault || cfg.vault,
  };
}

/**
 * The first CHAIN_EXECUTION_FAILED: the transaction IS in a block, the vault
 * call was refused (stale state), the sponsor paid the fee. Recorded as its
 * own entry so the pattern stays visible (2026-09-05: invisible until then).
 */
function recordWasted(item, job, attesterId, extra = {}) {
  const entry = {
    ok: false, ...baseEntry(item), ...extra,
    attempt: 1, feeWasted: true, status: "failed",
    error: (job.errorMessage || job.errorCode || "?").slice(0, 300),
    attesterId, txHash: job.txHash || null, jobId: job.jobId,
  };
  ng.record(entry);
  journal.note("attest", { kind: item.kind, call: item.call, ok: false, attempt: 1, feeWasted: true, payloadHash: entry.payloadHash, txHash: entry.txHash, network: cfg.network, error: entry.error });
  log(`${item.id} ${item.kind}: attempt 1 landed in a block but the call was refused (fee burned) - ${entry.error}`);
}

async function recordOutcome(item, job, attesterId, attempt, extra = {}) {
  let verified = false;
  if (job.status === "succeeded" && ATTEST_CALLS.has(item.call) && item.params.payloadHash) {
    try {
      const v = await ng.verifyAttestation(item.params.payloadHash, cfg, item.vault || cfg.vault);
      verified = !!v.attested;
    } catch (e) { log("verify failed (attestation may still be fine):", e.message); }
  }
  const entry = {
    ok: job.status === "succeeded",
    ...baseEntry(item), ...extra,
    attesterId,
    txHash: job.txHash || null,
    // the explorer indexes the real 32-byte hash, not the ledger identifier
    txExplorerHash: extra.txExplorerHash !== undefined ? extra.txExplorerHash : (job.txHash ? await ng.resolveTxHash(job.txHash, cfg) : null),
    jobId: job.jobId,
    ...(attempt > 1 ? { attempt, rebuilt: true } : {}),
    ...(job.lateLanded ? { lateLanded: true } : {}),
    // predicates/diffs leave no payload attestation - verified only applies to attest-family calls
    ...(ATTEST_CALLS.has(item.call) ? { verified } : {}),
    ...(job.status !== "succeeded" ? { status: job.status, error: (job.errorMessage || job.errorCode || "?").slice(0, 300) } : {}),
  };
  ng.record(entry);
  journal.note("attest", {
    kind: item.kind, call: item.call, ok: entry.ok,
    payloadHash: entry.payloadHash, txHash: entry.txHash, network: cfg.network,
    ...(attempt > 1 ? { attempt } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  });
  if (entry.ok) log(`${item.id} ${item.kind}/${item.call}: anchored, tx ${entry.txHash}${ATTEST_CALLS.has(item.call) ? `, verified=${verified}` : ""}${attempt > 1 ? " (after rebuild)" : ""}${job.lateLanded ? " (landed after the sponsor watch gave up)" : ""}`);
  else log(`${item.id} ${item.kind}/${item.call}: FAILED ${entry.error || job.status}`);
  return entry;
}

/** Payload hashes an item needs on chain before its call can succeed. */
function dependsOn(item) {
  if (!DEPENDENT_CALLS.has(item.call)) return [];
  const p = item.params || {};
  return [p.payloadHash, p.payloadHashA, p.payloadHashB].filter(Boolean);
}

/** Record an item we did not even build because its prerequisite failed earlier in this run. */
function recordSkipped(item, reason) {
  const error = `skipped: ${reason} earlier in this run - rerun 'life.mjs attest' once the chain is healthy`;
  ng.record({ ok: false, ...baseEntry(item), status: "skipped", skipped: true, error });
  journal.note("attest", { kind: item.kind, call: item.call, ok: false, skipped: true, payloadHash: item.params?.payloadHash, network: cfg.network, error });
  log(`${item.id} ${item.kind}/${item.call}: SKIPPED - ${reason}`);
}

// ---------- one transaction ----------

/**
 * Submit one built transaction and follow it. Returns { job, attempt }; on the
 * first CHAIN_EXECUTION_FAILED it records the burned attempt and lets the
 * caller rebuild once against a state that includes the collision tx.
 */
async function submitWithRebuild(items, build, idKey) {
  let outcome = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // never build against a state that lacks the previous transaction
    await ng.awaitVisible(lastLanded, cfg);
    const { unboundTxB64, attesterId } = await build();
    const sub = await sponsorWithRetry(unboundTxB64, `${idKey}-${attempt}`);
    let job = await ng.waitForJob(sub.jobId, sub.sessionId, { cfg });
    if (!FINAL.has(job.status)) {
      // a job stuck in queued/running is the API being slow or down, not a
      // verdict (2026-09-08 06:05: the daily report was written off as
      // "running" and its whole claim set skipped): give it the late-landing
      // window, then treat it as an outage the caller retries
      log(`${items[0].id} ${items[0].kind}: job ${sub.jobId} still ${job.status} after 180s - waiting up to ${Math.round(cfg.lateLandWaitMs / 1000)}s more`);
      job = await ng.waitForJob(sub.jobId, sub.sessionId, { cfg, timeoutMs: cfg.lateLandWaitMs });
      if (!FINAL.has(job.status)) throw new Error(`NIGHTGATE job ${sub.jobId} still ${job.status} after ${Math.round((180_000 + cfg.lateLandWaitMs) / 1000)}s (API slow or down)`);
    }
    if (isSubmitTimeout(job)) job = await awaitLateLanding(items[0], job);
    outcome = { job, attesterId, attempt };
    if (job.status === "succeeded") { noteLanded(job, items.at(-1), true); break; }
    if (job.status === "failed" && job.errorCode === "CHAIN_EXECUTION_FAILED" && attempt === 1) {
      recordWasted(items[0], job, attesterId, items.length > 1 ? { batchOf: items.length } : {});
      // the refused tx sits in a block: wait for it before reading state again
      noteLanded(job, items[0], false);
      log(`${items[0].id} ${items[0].kind}: rebuilding against fresh state`);
      continue;
    }
    break;
  }
  return outcome;
}

async function processItem(item) {
  if (item.call === "attest" && ng.alreadyAttested(item.params.payloadHash)) {
    log(`${item.id} ${item.kind}: payload already anchored - skipping`);
    return true;
  }
  let outcome;
  try {
    outcome = await submitWithRebuild([item], () => ng.buildSponsorable(item, cfg), item.id);
  } catch (e) {
    if (item.params.payloadHash && /already attested/i.test(e.message)) {
      const v = await ng.verifyAttestation(item.params.payloadHash, cfg).catch(() => null);
      if (v?.attested) {
        log(`${item.id} ${item.kind}: already anchored on chain (by an earlier run) - recording as done`);
        const entry = { ok: true, deduped: true, ...baseEntry(item), verified: true };
        ng.record(entry);
        journal.note("attest", { kind: item.kind, call: item.call, ok: true, deduped: true, payloadHash: item.params.payloadHash, network: cfg.network });
        return true;
      }
    }
    throw e;
  }
  return (await recordOutcome(item, outcome.job, outcome.attesterId, outcome.attempt)).ok;
}

/**
 * Several plain attests in ONE transaction. Returns false when the builder
 * refused the batch before anything was sponsored (fall back to singles).
 */
async function processBatch(items) {
  let built = null;
  const build = async () => {
    try { built = await ng.buildSponsorableBatch(items, cfg); return built; } catch (e) {
      if (built) throw e; // a rebuild failing is a real failure
      e.batchRefused = true; throw e;
    }
  };
  let outcome;
  try {
    outcome = await submitWithRebuild(items, build, `batch-${items[0].id}`);
  } catch (e) {
    if (e.batchRefused) { log(`batch of ${items.length} refused before proving (${e.message.slice(0, 120)}) - anchoring one by one`); return false; }
    throw e;
  }
  const { job, attesterId, attempt } = outcome;
  const txExplorerHash = job.txHash ? await ng.resolveTxHash(job.txHash, cfg) : null;
  for (const item of items) {
    const entry = await recordOutcome(item, job, attesterId, attempt, { batchOf: items.length, txExplorerHash });
    if (!entry.ok) noteFailed(item);
  }
  return true;
}

/** The leading run of plain attests on one vault (batching only; 1 item when off). */
function nextGroup(queue) {
  const head = queue[0];
  if (cfg.batchMax <= 1 || head.call !== "attest") return [head];
  const vault = head.vault || cfg.vault;
  const group = [head];
  for (const q of queue.slice(1)) {
    if (group.length >= cfg.batchMax) break;
    if (q.call !== "attest" || (q.vault || cfg.vault) !== vault) break;
    group.push(q);
  }
  return group;
}

/** payloadHash -> why nothing depending on it can succeed in this run */
const blocked = new Map();
function noteFailed(item) {
  const h = item.params?.payloadHash;
  if (!h) return;
  if (item.call === "attest") blocked.set(h, "its attest failed");
  else if (item.call === "anchorContentRoot") blocked.set(h, "its content root failed");
}

export async function drain() {
  if (!cfg.enabled) { log("nightgate not configured - worker exits"); return; }
  if (ng.workerActive()) { log("another anchor worker is active - exiting"); return; }
  ng.takeLock();
  try { os.setPriority(19); } catch { /* not critical */ }
  seedLastLanded();
  // keep the lock fresh WHILE proving too: a single proveFieldsDiffer took
  // >11 min on 2026-09-08 and the lock (touched only between items) looked
  // stale, inviting a second worker onto the same vault
  const heartbeat = setInterval(() => { try { ng.touchLock(); } catch { /* ignore */ } }, 60_000);
  heartbeat.unref();
  try {
    let n = 0;
    for (; ;) {
      const until = ng.pausedUntil();
      if (until) { log(`anchoring paused until ${new Date(until).toISOString()} - worker stops, ${ng.readQueue().length} item(s) stay queued`); break; }
      const queue = ng.readQueue();
      if (!queue.length) break;
      const group = nextGroup(queue);
      let done = [group[0]];
      const missing = dependsOn(group[0]).find((h) => blocked.has(h));
      if (missing) {
        recordSkipped(group[0], `${blocked.get(missing)} (${ng.shortHash(missing)})`);
        ng.writeQueue(ng.readQueue().filter((q) => q.id !== group[0].id));
        ng.touchLock();
        n += 1;
        continue;
      }
      try {
        if (group.length > 1) {
          const skip = group.filter((i) => ng.alreadyAttested(i.params.payloadHash));
          for (const i of skip) log(`${i.id} ${i.kind}: payload already anchored - skipping`);
          const pending = group.filter((i) => !skip.includes(i));
          if (pending.length > 1 && await processBatch(pending)) done = group;
          else {
            // batch refused up front (or nothing left): one transaction, the rest waits its turn
            if (pending.length && !(await processItem(pending[0]))) noteFailed(pending[0]);
            done = [...skip, ...pending.slice(0, 1)];
          }
        } else if (!(await processItem(group[0]))) {
          noteFailed(group[0]);
        }
      } catch (e) {
        const item = group[0];
        const outage = ng.isApiOutage(e.message);
        // a NIGHTGATE/API outage (5xx, timeouts, unreachable) is not the item's
        // fault: keep it at the head of the queue (order matters - a content
        // root must follow its attest) and back off, 1 min .. 30 min, up to
        // cfg.outageRetries times (2026-09-07: two anchors lost to a 502;
        // 2026-09-08: eight lost to "aborted due to timeout" with no retry at all)
        const retries = item.retries || 0;
        if (outage && retries < cfg.outageRetries) {
          const waitMs = OUTAGE_BACKOFF_MS[Math.min(retries, OUTAGE_BACKOFF_MS.length - 1)];
          log(`${item.id} ${item.kind}: NIGHTGATE unreachable (${e.message.slice(0, 80)}) - retry ${retries + 1}/${cfg.outageRetries} in ${Math.round(waitMs / 1000)}s`);
          ng.writeQueue(ng.readQueue().map((q) => (q.id === item.id ? { ...q, retries: retries + 1, retried: true, lastError: e.message.slice(0, 120) } : q)));
          ng.touchLock();
          await idle(waitMs);
          continue;
        }
        noteFailed(item);
        log(`${item.id} ${item.kind}: error${outage ? ` after ${retries} outage retries` : ""} - ${e.message}`);
        // doc + metadataHash stay on the entry: `life.mjs anchors retry` re-anchors it from here
        ng.record({ ok: false, ...baseEntry(item), status: "failed", error: e.message.slice(0, 300), ...(outage ? { apiOutage: true, retries } : {}) });
        try { journal.note("attest", { kind: item.kind, call: item.call, ok: false, payloadHash: item.params?.payloadHash, network: cfg.network, error: e.message.slice(0, 200), ...(outage ? { apiOutage: true } : {}) }); } catch { /* ignore */ }
        done = [item];
      }
      // remove the processed items (whatever arrived meanwhile stays)
      const ids = new Set(done.map((i) => i.id));
      ng.writeQueue(ng.readQueue().filter((q) => !ids.has(q.id)));
      ng.touchLock();
      n += done.length;
      if (n >= 80) { log("worker: 80 items in one run - stopping, will be re-kicked"); break; }
    }
    log(`worker done (${n} item${n === 1 ? "" : "s"})`);
    // keep the public ledger fresh: regenerate after every drained batch
    if (n > 0) {
      try {
        const { execFileSync } = await import("node:child_process");
        const { scriptsDir } = await import("./lib/mc.mjs");
        const path = await import("node:path");
        execFileSync(process.execPath, [path.join(scriptsDir, "dashboard.mjs")], { stdio: "ignore" });
        log("dashboard refreshed");
      } catch (e) { log("dashboard refresh failed:", e.message); }
    }
  } finally {
    clearInterval(heartbeat);
    ng.releaseLock();
    await ng.closeBuilder();
  }
}

// run when invoked directly (also via the Windows path form)
const invoked = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invoked) {
  drain().then(() => process.exit(0)).catch((e) => { log("worker fatal:", e.message); ng.releaseLock(); process.exit(1); });
}
