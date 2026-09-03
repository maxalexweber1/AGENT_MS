#!/usr/bin/env node
/**
 * Anchor worker: drains data/anchor-queue.jsonl STRICTLY one item at a time.
 *
 * Per item: build+prove+sign locally -> sponsorUnboundTransaction -> poll ->
 * on CHAIN_EXECUTION_FAILED rebuild once against fresh state -> verify ->
 * data/attestations.json + journal event `attest`. Failures are recorded and
 * dropped (no infinite retries); the queue survives crashes (an item is only
 * removed after processing).
 *
 * Spawned detached by nightgate.kickWorker(); exits when the queue is empty.
 */

import os from "node:os";
import { loadDotEnv, log } from "./lib/mc.mjs";
import * as journal from "./lib/journal.mjs";
import * as ng from "./lib/nightgate.mjs";

loadDotEnv();
const cfg = ng.config();

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

async function processItem(item) {
  if (item.call === "attest" && ng.alreadyAttested(item.params.payloadHash)) {
    log(`${item.id} ${item.kind}: payload already anchored - skipping`);
    return;
  }
  let outcome = null;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { unboundTxB64, attesterId } = await ng.buildSponsorable(item, cfg);
      const sub = await sponsorWithRetry(unboundTxB64, `${item.id}-${attempt}`);
      const job = await ng.waitForJob(sub.jobId, sub.sessionId, { cfg });
      outcome = { attesterId, job };
      if (job.status === "succeeded") break;
      if (job.status === "failed" && job.errorCode === "CHAIN_EXECUTION_FAILED" && attempt === 1) {
        log(`${item.id} ${item.kind}: same-block conflict - rebuilding against fresh state`);
        continue;
      }
      break;
    }
  } catch (e) {
    if (item.params.payloadHash && /already attested/i.test(e.message)) {
      const v = await ng.verifyAttestation(item.params.payloadHash, cfg).catch(() => null);
      if (v?.attested) {
        log(`${item.id} ${item.kind}: already anchored on chain (by an earlier run) - recording as done`);
        const entry = { ok: true, deduped: true, kind: item.kind, call: item.call, date: new Date().toISOString().slice(0, 10), payloadHash: item.params.payloadHash, ...(item.doc ? { doc: item.doc } : {}), network: cfg.network, vault: cfg.vault, verified: true };
        ng.record(entry);
        journal.note("attest", { kind: item.kind, call: item.call, ok: true, deduped: true, payloadHash: item.params.payloadHash, network: cfg.network });
        return;
      }
    }
    throw e;
  }

  const job = outcome.job;
  let verified = false;
  if (job.status === "succeeded" && ATTEST_CALLS.has(item.call) && item.params.payloadHash) {
    try {
      const v = await ng.verifyAttestation(item.params.payloadHash, cfg, item.vault || cfg.vault);
      verified = !!v.attested;
    } catch (e) { log("verify failed (attestation may still be fine):", e.message); }
  }

  const entry = {
    ok: job.status === "succeeded",
    kind: item.kind,
    call: item.call,
    date: new Date().toISOString().slice(0, 10),
    ...(item.params.payloadHash ? { payloadHash: item.params.payloadHash } : {}),
    ...(item.params.commitment ? { commitment: item.params.commitment } : {}),
    ...(item.call === "proveFieldPredicate" ? { field: item.meta?.field, threshold: item.params.threshold, op: item.params.op } : {}),
    ...(item.doc ? { doc: item.doc } : {}),
    attesterId: outcome.attesterId,
    txHash: job.txHash || null,
    // the explorer indexes the real 32-byte hash, not the ledger identifier
    txExplorerHash: job.txHash ? await ng.resolveTxHash(job.txHash, cfg) : null,
    jobId: job.jobId,
    network: cfg.network,
    vault: item.vault || cfg.vault,
    // predicates/diffs leave no payload attestation - verified only applies to attest-family calls
    ...(ATTEST_CALLS.has(item.call) ? { verified } : {}),
    ...(job.status !== "succeeded" ? { status: job.status, error: (job.errorMessage || job.errorCode || "?").slice(0, 300) } : {}),
  };
  ng.record(entry);
  journal.note("attest", {
    kind: item.kind, call: item.call, ok: entry.ok,
    payloadHash: entry.payloadHash, txHash: entry.txHash, network: cfg.network,
    ...(entry.error ? { error: entry.error } : {}),
  });
  if (entry.ok) log(`${item.id} ${item.kind}/${item.call}: anchored, tx ${entry.txHash}${ATTEST_CALLS.has(item.call) ? `, verified=${verified}` : ""}`);
  else log(`${item.id} ${item.kind}/${item.call}: FAILED ${entry.error || job.status}`);
}

export async function drain() {
  if (!cfg.enabled) { log("nightgate not configured - worker exits"); return; }
  if (ng.workerActive()) { log("another anchor worker is active - exiting"); return; }
  ng.takeLock();
  try { os.setPriority(19); } catch { /* not critical */ }
  try {
    let n = 0;
    for (; ;) {
      const queue = ng.readQueue();
      if (!queue.length) break;
      const item = queue[0];
      try {
        await processItem(item);
      } catch (e) {
        log(`${item.id} ${item.kind}: error - ${e.message}`);
        ng.record({ ok: false, kind: item.kind, call: item.call, error: e.message.slice(0, 300), ...(item.params?.payloadHash ? { payloadHash: item.params.payloadHash } : {}) });
        try { journal.note("attest", { kind: item.kind, call: item.call, ok: false, error: e.message.slice(0, 200) }); } catch { /* ignore */ }
      }
      // remove the processed item (whatever items arrived meanwhile stay)
      ng.writeQueue(ng.readQueue().filter((q) => q.id !== item.id));
      ng.touchLock();
      n++;
      if (n >= 80) { log("worker: 80 items in one run - stopping, will be re-kicked"); break; }
    }
    log(`worker done (${n} item${n === 1 ? "" : "s"})`);
  } finally {
    ng.releaseLock();
    await ng.closeBuilder();
  }
}

// run when invoked directly (also via the Windows path form)
const invoked = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invoked) {
  drain().then(() => process.exit(0)).catch((e) => { log("worker fatal:", e.message); ng.releaseLock(); process.exit(1); });
}
