/**
 * Canonical envelope templates (v1) for everything M₳X anchors on Midnight.
 *
 * The anchored payloadHash is sha256 over EXACTLY the canonical JSON this
 * module produces: the template fixes the field list AND the field order, the
 * serialization is JSON.stringify with no whitespace. Anyone holding the
 * values can reproduce the hash - the templates are published in
 * docs/SCHEMAS.md, which must be kept in sync with this file.
 *
 * Rules:
 *  - every envelope starts with the same header: v, agent, agentId, kind, date, ts
 *  - kind-specific fields follow in the order listed here
 *  - all fields are required (missing -> error), extras are rejected
 *  - never reorder or rename fields within a version; changes bump `v`
 *
 * The daily report is the one exception: its payloadHash/contentRoot come
 * from NIGHTGATE's server-side `prepareDocumentProof` canonicalization; its
 * input field list lives here only as documentation (REPORT_FIELDS is owned
 * by attest-report.mjs and part of the Merkle tree identity).
 */

import crypto from "node:crypto";

export const SCHEMA_VERSION = 1;

const HEADER = ["v", "agent", "agentId", "kind", "date", "ts"];

/** kind -> ordered list of kind-specific fields (after the common header) */
export const SCHEMAS = {
  batch: ["coins", "earned"],
  meeting: ["name", "summarySha256"],
  explore: ["district", "noteSha256"],
  notary: ["claimant", "claimantId", "claim", "claimSha256"],
  "notary-paid": ["claimant", "claimantId", "claim", "claimSha256", "paid"],
  prediction: ["predictedCoins"],
  "grant-test": ["note"],
  pulse: ["crystal", "coins", "hunger", "mode", "place"],
  meal: ["food", "cost", "hungerBefore", "hungerAfter"],
  sleep: ["bed", "minutes"],
  // progression (skill system since 2026-08-27, used by M₳X since 2026-09-07)
  contract: ["contractId", "skill", "xp"],
  levelup: ["skill", "level", "xp"],
  tool: ["itemId", "cost", "level"],
  // one contract run across all skills (quest.mjs, since 2026-09-07): contracts delivered, XP earned, gathers made
  quest: ["contracts", "xp", "gathers"],
  // one craft action at a workstation (quest.mjs): recipe, its skill, XP granted, batches made
  craft: ["recipeId", "skill", "xp", "batches"],
  // one notary sales run (hustle.mjs, since 2026-09-11): where, pitches made, quotes given, anchors paid, minutes spent
  hustle: ["place", "pitches", "quotes", "paid", "minutes"],
};

/** Metadata envelope (hashed into metadataHash), same for every kind. */
export const META_FIELDS = ["v", "agentId", "kind", "date"];

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Build the canonical envelope for `kind` from the kind-specific values plus
 * identity. Returns { envelope, json, payloadHash, meta, metaJson, metadataHash }.
 * Throws on missing or unexpected fields - a hash over a sloppy document is
 * worse than no hash.
 */
export function canonical(kind, values, { agentId, date = new Date().toISOString().slice(0, 10), ts = Date.now() } = {}) {
  const fields = SCHEMAS[kind];
  if (!fields) throw new Error(`no schema for kind '${kind}' (have: ${Object.keys(SCHEMAS).join(", ")})`);
  if (!agentId) throw new Error("canonical() needs the agentId");

  const extra = Object.keys(values).filter((k) => !fields.includes(k));
  if (extra.length) throw new Error(`schema ${kind}/v${SCHEMA_VERSION} does not know: ${extra.join(", ")}`);

  const envelope = { v: SCHEMA_VERSION, agent: "MAX", agentId, kind, date, ts };
  for (const f of fields) {
    if (values[f] === undefined) throw new Error(`schema ${kind}/v${SCHEMA_VERSION} requires '${f}'`);
    envelope[f] = values[f];
  }

  const json = JSON.stringify(envelope); // header order + template order, no whitespace
  const meta = { v: SCHEMA_VERSION, agentId, kind, date };
  const metaJson = JSON.stringify(meta);
  return { envelope, json, payloadHash: sha256(json), meta, metaJson, metadataHash: sha256(metaJson) };
}

/** The header fields, for docs generation and sanity checks. */
export const HEADER_FIELDS = HEADER;
