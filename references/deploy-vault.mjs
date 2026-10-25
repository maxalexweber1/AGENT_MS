#!/usr/bin/env node
/**
 * Deploy your OWN AttestationVault on Midnight (one-time): build + prove +
 * sign the deploy locally with your seed, let the sponsor pay (needs
 * `allowDeploy` with budget on the grant - the landed address is then
 * recorded in the grant's deployedContracts and is sponsorable automatically).
 *
 *   node references/deploy-vault.mjs --dry-run   # build + prove only, nothing is sent
 *   node references/deploy-vault.mjs             # prints the new contract address
 *
 * Needs NIGHTGATE_SEED_HEX and NIGHTGATE_TOKEN. The chain is read through the
 * NIGHTGATE API unless NIGHTGATE_INDEXER_* and NIGHTGATE_NODE_URL are set.
 * Afterwards: set NIGHTGATE_VAULT=<address> in .env.
 */

import path from "node:path";
import { loadDotEnv, dataDir, log } from "../scripts/lib/mc.mjs";
import * as ng from "../scripts/lib/nightgate.mjs";

loadDotEnv();
const cfg = ng.config();
const dryRun = process.argv.includes("--dry-run");

async function main() {
  if (!cfg.seedHex || !cfg.token) throw new Error("set NIGHTGATE_SEED_HEX and NIGHTGATE_TOKEN in .env");
  log(`${dryRun ? "dry run: building" : "deploying"} a fresh ${cfg.artifact} on ${cfg.network} via ${cfg.baseUrl} (chain from ${ng.usesOwnIndexer(cfg) ? "own indexer" : "the API"})...`);

  const [{ createTxBuilder }, calls, vault] = await Promise.all([
    import("@odatano/nightgate-tx/txbuilder"),
    import("@odatano/nightgate-tx/calls"),
    cfg.artifact === "attestation-vault-32"
      ? import("@odatano/nightgate-tx/attestation-vault-32")
      : import("@odatano/nightgate-tx/attestation-vault"),
  ]);
  const b = await createTxBuilder({
    seedHex: cfg.seedHex, networkId: cfg.network,
    ...ng.builderChainOptions(cfg),
    zkConfigBaseUrl: `${cfg.baseUrl}/zk-config/${cfg.artifact}`,
    contractClass: vault.Contract, contractName: cfg.artifact,
    cacheDir: path.join(dataDir, "zk-cache", cfg.artifact),
    // a deploy moves no value: no wallet sync
    walletSync: false,
  });
  try {
    const t0 = Date.now();
    const slotWidth = cfg.artifact === "attestation-vault-32" ? 32 : 16;
    // constructor (registrar, recovery). The registrar is your attester id; the recovery id
    // may later re-point the registrar. NIGHTGATE_RECOVERY_ID (64 hex) sets it, default zero.
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
    if (dryRun) { log("dry run: nothing sent, the grant's deploy is still unused"); return; }
    const sub = await ng.sponsorUnbound(built.unboundTxB64, `vault-deploy-${Date.now()}`, cfg);
    log(`sponsored: job ${sub.jobId} (session ${sub.sessionId})`);
    const job = await ng.waitForJob(sub.jobId, sub.sessionId, { cfg, timeoutMs: 300_000 });
    if (job.status !== "succeeded") throw new Error(`deploy job ended ${job.status}: ${job.errorMessage || job.errorCode || "?"}`);
    const explorerHash = await ng.resolveTxHash(job.txHash, cfg);
    log(`vault is live: ${built.contractAddress} (identifier ${job.txHash}${explorerHash ? `, explorer hash ${explorerHash}` : ""})`);
    log(`next: set NIGHTGATE_VAULT=${built.contractAddress} in .env`);
  } finally {
    try { await b.close?.(); } catch { /* best effort */ }
  }
}

main().then(() => process.exit(0)).catch((e) => { log("deploy failed:", e.message); process.exit(1); });
