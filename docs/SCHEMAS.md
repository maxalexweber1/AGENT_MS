# M₳X anchor formats (v1)

Every hash M₳X anchors on Midnight is `sha256` over a **canonical JSON
envelope** defined here. Hold the values and you can reproduce the hash —
no trust in M₳X or NIGHTGATE required. The authoritative implementation is
[`scripts/lib/schemas.mjs`](../scripts/lib/schemas.mjs); this document must
stay in sync with it.

> v1 status: the formats below are what the agent runs today. They are
> considered *testing* — breaking changes bump `v`, and anchors always carry
> the version inside the hashed envelope itself.

## Canonical serialization

- The envelope is a JSON object serialized with **no whitespace** and the
  **exact field order** given below (`JSON.stringify` of an object built in
  template order).
- Every field is required. Nothing else may appear.
- `payloadHash = sha256(canonical JSON)` — this is the value anchored on the
  AttestationVault and returned by M₳X as a receipt.
- A second, smaller envelope is hashed into the anchor's `metadataHash`:
  `{"v":1,"agentId":…,"kind":…,"date":…}` (same order).

## Common header (every kind, in this order)

| # | field | type | meaning |
|---|---|---|---|
| 1 | `v` | number | schema version, currently `1` |
| 2 | `agent` | string | always `"MAX"` |
| 3 | `agentId` | string | the Midnight City agent id |
| 4 | `kind` | string | one of the kinds below |
| 5 | `date` | string | `YYYY-MM-DD` (UTC) |
| 6 | `ts` | number | unix milliseconds at envelope creation |

## Kinds (fields after the header, in this order)

| kind | fields | notes |
|---|---|---|
| `batch` | `coins`, `earned` | one sold meme-coin batch: quantity and crystal earned |
| `meeting` | `name`, `summarySha256` | a finished conversation; only the sha256 of the private summary goes into the envelope |
| `explore` | `district`, `noteSha256` | one exploration trip; the note itself stays local |
| `notary` | `claimant`, `claimantId`, `claim`, `claimSha256` | the free notary service: `claim` is the claimant's **exact message text**, `claimSha256 = sha256(claim)` |
| `notary-paid` | `claimant`, `claimantId`, `claim`, `claimSha256`, `paid` | the paid notary (since 2026-09-07): same as `notary` plus `paid` = crystal received via `send-crystal` before the anchor was queued |
| `prediction` | `predictedCoins` | the daily hidden prediction (commit/reveal, see below) |
| `grant-test` | `note` | plumbing self-tests |
| `pulse` | `crystal`, `coins`, `hunger`, `mode`, `place` | hourly liveness snapshot: crystal balance, meme coins in the bag, hunger (0-100), current mode (`work`/`social`/`explore`/`sleep`) and space id |
| `meal` | `food`, `cost`, `hungerBefore`, `hungerAfter` | one meal bought and eaten |
| `sleep` | `bed`, `minutes` | one night in a Charging House bed (planned duration) |
| `contract` | `contractId`, `skill`, `xp` | one delivered game contract (content id, the skill it trains, XP the definition grants) |
| `levelup` | `skill`, `level`, `xp` | a skill reached a new level; `xp` is the total at that moment |
| `tool` | `itemId`, `cost`, `level` | a profession tool bought once its required level was reached (crystal paid, skill level at purchase) |
| `craft` | `recipeId`, `skill`, `xp`, `batches` | one craft action at a workstation (recipe id, the skill it trains, XP granted for all batches, batches made) |
| `quest` | `contracts`, `xp`, `gathers` | one contract run across all skills (since 2026-09-07): contracts delivered, XP earned incl. gathering, gathers made; each delivered contract is also anchored as its own `contract` |
| `hustle` | `place`, `pitches`, `quotes`, `paid`, `minutes` | one notary sales run (since 2026-09-11): the area id M₳X worked, pitches delivered, quotes given (price + claim hash), anchors paid for out of those pitches, minutes spent; each paid anchor is also anchored as its own `notary-paid` |
| `gathers` | `gathers`, `xp`, `sources` | every 25 resource gathers (since 2026-09-16): how many, the gather XP they earned, and the sources worked as `sourceId:count` pairs sorted by count, comma-separated (e.g. `canal_eddy:23,drone_wreckfield:2`) |

### Worked example (`batch`)

```json
{"v":1,"agent":"MAX","agentId":"user-agent-d23b30d5-520e-4b3f-aae4-307ed85a7b34","kind":"batch","date":"2026-09-03","ts":1788766815000,"coins":100,"earned":1000}
```

```
sha256 → 41a837526c590d5cc78fb93d4dce0a3156a123867cf78111e07b281162167868
```

Reproduce it (note `printf`, not `echo` — no trailing newline):

```bash
printf '%s' '{"v":1,"agent":"MAX",…,"earned":1000}' | sha256sum
```

## Predictions (commit/reveal)

Since vault lineage 4 (NIGHTGATE 0.24, `@odatano/nightgate-tx` 0.6) there is
no commit/reveal circuit any more. Both steps are plain `attest` calls on the
same vault, scheme `sha256(payloadHashHex||nonceHex)/v1`:

1. **Commit (morning).** M₳X builds the `prediction` envelope, draws a
   32-byte random `nonce` and anchors
   `commitment = sha256(payloadHash || nonce)` — the two values as lowercase
   hex strings, concatenated, hashed as UTF-8 text. The anchored payload is the
   commitment; its `metadataHash` is the usual envelope over
   `{"v":1,"agentId":…,"kind":"prediction-commit","date":…}`. The envelope and
   the nonce stay private.
2. **Reveal (next morning).** M₳X anchors the envelope itself (`payloadHash`,
   `metadataHash` over kind `prediction`) and publishes the nonce.

Anyone checks the pair without trusting M₳X: re-hash the envelope to get
`payloadHash`, compute `sha256(payloadHash || nonce)`, and confirm it equals
the commitment that was attested on chain *before* the predicted day ended
(the commit's block time is the proof of ordering).

```bash
printf '%s' "<payloadHash><nonce>" | sha256sum   # = the commitment
```

Up to lineage 3 the commit went through the vault's `attestGuarded` circuit
(`persistentHash(payloadHash, metadataHash, nonce)`, recomputed in-chain at
the reveal). Commitments made that way cannot be revealed on a lineage-4 vault.

## Daily report (structured document)

The daily report is not hashed by this module: its canonical form, salted
Merkle `contentRoot` and `schemaId` come from NIGHTGATE's
`prepareDocumentProof` (server-side canonicalization; witnesses stay with
M₳X). Its ordered proof-field list — part of the Merkle tree identity, never
to be reordered — is:

```
crystal, coinsSold, crystalFromCoins, batches, meals,
replies, openers, conversations, explores
```

(all `uint`, scale 1), inside a document that also carries `date`, `agentId`
and `reportSha256` (sha256 of the rendered markdown report). This is what
zero-knowledge claims like *"crystal ≥ 100000"* are proven against
(`proveFieldPredicate`), without revealing the value.

## Daily progress (structured document, since 2026-09-16)

A second structured document per day, built the same way (NIGHTGATE's
`prepareDocumentProof`, anchored with `attest` + `anchorContentRoot`), over
M₳X's skill progression and public leaderboard standing. Ordered proof fields,
never to be reordered:

```
xpTotal,
xp_agility, xp_bounty_hunting, xp_chemistry, xp_combat, xp_cooking,
xp_crafting, xp_defence, xp_energy, xp_engineering, xp_farming, xp_fishing,
xp_hacking, xp_infiltration, xp_mining, xp_ranged, xp_scavenging,
xp_smithing, xp_vitality, xp_woodcutting,
contractsCompleted, rankExperience, rankContracts, rankRichest, rankMostLiked
```

(all `uint`, scale 1; a rank of 0 means "not ranked"), inside a document that
also carries `date` and `agentId`. Daily claims proven against it, values
hidden: total XP ≥ a round 100k step, each of the three strongest skills at
least at its current level (its XP ≥ the level's threshold from the game's
XP table), completed contracts ≥ a step of 5, and experience rank ≤ the next
multiple of 50.

## Verifying an anchor

Any NIGHTGATE token can check a payloadHash against live Midnight contract
state — no wallet:

```
GET /api/v1/nightgate/verifyAttestationState(
      contractAddress='<vault>',payloadHash='<sha256>',
      compiledArtifactRef='attestation-vault-32')
```

M₳X's vault (since 2026-09-03):
`0923eee3c5908ca82d671708dcb85af06080b0920b6bd754e1b138843105240c`.
Anchors before that date live on the shared public vault
`9b97a6764805789852351a401b7cfc137097d591cabe33926dfbc42792c00137`.
Envelopes anchored before this spec existed used ad-hoc field order; from v1
on, this document is the contract.
