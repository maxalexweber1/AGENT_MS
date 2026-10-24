#!/usr/bin/env node
/**
 * Deploy M₳X's OWN AttestationVault on Midnight (one-time, 2026-09-03):
 * build + prove + sign the deploy locally with his seed, let the sponsor pay
 * (needs `allowDeploy` with budget on the grant - the landed address is then
 * recorded in the grant's deployedContracts and is sponsorable automatically).
 *
 *   node scripts/deploy-vault.mjs        # prints the new contract address
 *
 * Afterwards: set NIGHTGATE_VAULT=<address> in .env and recreate the
 * container. Old anchors stay verifiable on the old vault; pending prediction
 * reveals carry their own vault (see attest-report.mjs LEGACY_VAULT).
 */

import path from "node:path";
import { loadDotEnv, dataDir, log } from "../scripts/lib/mc.mjs";
import * as ng from "../scripts/lib/nightgate.mjs";

loadDotEnv();
const cfg = ng.config();

async function main() {
  if (!cfg.enabled) throw new Error("NIGHTGATE_* not configured");
  log(`deploying a fresh ${cfg.artifact} on ${cfg.network} (sponsor pays)...`);

  const [{ createTxBuilder }, calls, vault] = await Promise.all([
    import("@odatano/nightgate-tx/txbuilder"),
    import("@odatano/nightgate-tx/calls"),
    cfg.artifact === "attestation-vault-32"
      ? import("@odatano/nightgate-tx/attestation-vault-32")
      : import("@odatano/nightgate-tx/attestation-vault"),
  ]);
  const b = await createTxBuilder({
    seedHex: cfg.seedHex, networkId: cfg.network,
    indexerHttpUrl: cfg.indexerHttpUrl, indexerWsUrl: cfg.indexerWsUrl, nodeUrl: cfg.nodeUrl,
    zkConfigBaseUrl: `${cfg.baseUrl}/zk-config/${cfg.artifact}`,
    contractClass: vault.Contract, contractName: cfg.artifact,
    cacheDir: path.join(dataDir, "zk-cache", cfg.artifact),
  });
  try {
    const t0 = Date.now();
    const slotWidth = cfg.artifact === "attestation-vault-32" ? 32 : 16;
    // lineage 4 final (NIGHTGATE 0.24.0): constructor (registrar, recovery). The registrar is
    // M₳X' attester id; the recovery id may later re-point the registrar (registerDocument
    // modes 3/4). NIGHTGATE_RECOVERY_ID (64 hex) sets it; default zero, as in NIGHTGATE's own
    // deployContract - no recovery. Only the document-id registry uses either role, not attests.
    const rt = await import("@midnight-ntwrk/compact-runtime");
    const registrarId = rt.persistentHash(new rt.CompactTypeBytes(32), b.attestationSecret);
    const recHex = String(process.env.NIGHTGATE_RECOVERY_ID || "").toLowerCase();
    if (recHex && !/^[0-9a-f]{64}$/.test(recHex)) throw new Error("NIGHTGATE_RECOVERY_ID must be 64 hex chars");
    const recoveryId = recHex ? Uint8Array.from(Buffer.from(recHex, "hex")) : new Uint8Array(32);
    log(`registrar ${Buffer.from(registrarId).toString("hex").slice(0, 12)}…, recovery ${recHex ? `${recHex.slice(0, 12)}…` : "none (zero)"}`);
    const built = await b.buildDeploySponsorable({
      bind: false,
      constructorArgs: [registrarId, recoveryId],
      witnesses: calls.buildAttestationVaultWitnesses({ attestationSecret: b.attestationSecret, slotWidth }),
    });
    log(`deploy built+proved in ${Math.round((Date.now() - t0) / 1000)}s - address ${built.contractAddress}`);
    const sub = await ng.sponsorUnbound(built.unboundTxB64, `max-vault-deploy-${Date.now()}`, cfg);
    log(`sponsored: job ${sub.jobId} (session ${sub.sessionId})`);
    const job = await ng.waitForJob(sub.jobId, sub.sessionId, { cfg, timeoutMs: 300_000 });
    if (job.status !== "succeeded") throw new Error(`deploy job ended ${job.status}: ${job.errorMessage || job.errorCode || "?"}`);
    log(`M₳X's own vault is live: ${built.contractAddress} (tx ${job.txHash})`);
    log(`next: set NIGHTGATE_VAULT=${built.contractAddress} in .env and recreate the container`);
  } finally {
    try { await b.close?.(); } catch { /* best effort */ }
  }
}

main().then(() => process.exit(0)).catch((e) => { log("deploy failed:", e.message); process.exit(1); });
