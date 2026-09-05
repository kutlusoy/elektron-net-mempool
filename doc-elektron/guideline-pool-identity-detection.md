# Elektron Net - `elektron-net-mempool` Pool Identity Detection Guideline

- **Version:** 0.4 (backend implemented on `poolidentity`, pending review/merge and live testing before `main`; frontend display still open)
- **Date:** September 4, 2026
- **Audience:** `elektron-net-mempool` backend and frontend developers
- **Reference implementation:** [`elektron-net-ppool`](https://github.com/kutlusoy/elektron-net-ppool) - `doc-elektron/guideline-pool-identity-op-return.md` (companion document, defines the exact coinbase byte format this document detects); this repo's `backend/src/api/blocks.ts` (`$indexBlock()`, `$getBlockExtended()`, `$findBlockMiner()`), `backend/src/api/pools-parser.ts` (`matchBlockMiner()`), `backend/src/api/bitcoin/bitcoin.routes.ts` (`getBlock` handler), `backend/src/api/bitcoin/bitcoin-api.ts` / `esplora-api.ts` (`$getCoinbaseTx()`) - treat as ground truth for anything referenced below
- **Consumer:** block-details / mining-pool pages in `frontend/`
- **See also:** [`guideline-pool-identity-op-return.md`](https://github.com/kutlusoy/elektron-net-ppool/blob/poolidentity/doc-elektron/guideline-pool-identity-op-return.md), [`guideline-coinbase-third-op-return.md`](https://github.com/kutlusoy/elektron-net/blob/main/doc-elektron/guideline-coinbase-third-op-return.md)

- Requirement-level words follow standard usage: **MUST** = mandatory, **SHOULD** = strongly recommended, **MAY** = optional.
- Never use the em dash character in this document or its follow-up code comments; use a hyphen and spaces instead, as done throughout.

---

## 1. Status of This Document

This is a **plan, not yet implemented**. It is the companion to `elektron-net-ppool`'s `doc-elektron/guideline-pool-identity-op-return.md`, which specifies two new, magic-tagged, informational `OP_RETURN` outputs a pool may add to its coinbase transaction (a self-declared pool name and pool URL). This document specifies how `elektron-net-mempool` detects, stores, and exposes them, without touching consensus code and without changing any existing pool-matching logic.

**Backend implemented** on the `poolidentity` branch (`backend/src/api/pool-identity-parser.ts`, `backend/src/api/bitcoin/bitcoin.routes.ts`), not yet merged to `main` - Ali is running it through further live testing before merging himself. Frontend display (Section 6) is not part of this revision. See Section 8 for what remains.

## 2. Relationship to Existing Address-Based Matching (Keep Both)

`backend/src/api/pools-parser.ts`'s `matchBlockMiner(scriptsig, addresses, pools)` remains the **authoritative** pool match, based on the curated `pools.json` registry (`addresses`/`regexes`). This document does not change that function or that registry.

The two new coinbase fields are, by construction, **self-declared and unverified** - any miner can put any text into a coinbase `OP_RETURN`. They **MUST** be treated and displayed as a supplementary, clearly-labeled "self-reported" signal, and **MUST NOT** silently override or replace the registry-matched pool name or logo. Failing to keep this distinction would create a spoofing vector: an unrelated miner could tag their blocks with a well-known pool's name to appear legitimate. See also Section 1 of `elektron-net`'s `guideline-coinbase-third-op-return.md`, which already establishes that this whole class of output is "informational only."

## 3. Byte Format Being Detected (From the Companion Document)

| Output | Magic (hex) | Magic (ASCII) | Payload |
|---|---|---|---|
| Pool name | `45504e4d` | `EPNM` | UTF-8 pool name |
| Pool URL | `45505552` | `EPUR` | UTF-8 URL |

Each is a **single** `OP_RETURN` data push: `MAGIC (4 bytes) || UTF-8 payload`, value `0`, always among the **last** coinbase outputs but **MUST** be located by **content**, not by position - mirroring how the node itself locates the UTXO attestation and witness commitment (`guideline-coinbase-third-op-return.md` Section 3: "both are content-addressed, not position-addressed").

## 4. Detection Point: Compute on Read, Not on Index (Revised August 27, 2026)

**Revision note:** an earlier draft of this document hooked detection into `$getBlockExtended()` and planned to persist the result via new `blocks` table columns (Section 5 as originally written). That approach was rejected after checking `$indexBlock()` (`backend/src/api/blocks.ts:1442-1448`):

```ts
public async $indexBlock(hash: string, block?: IEsploraApi.Block, skipDb = false): Promise<BlockExtended> {
    if (Common.indexingEnabled() && !skipDb) {
      const dbBlock = await blocksRepository.$getBlockByHash(hash);
      if (dbBlock !== null) {
        return dbBlock;
      }
    }
    ...
```

Once a block is indexed into SQL, every later request for it returns the **stored row** directly and never touches `coinbaseTx.vout` again. Hooking detection into `$getBlockExtended()` without a persisted column would only populate the fields on the single, first indexing pass, then silently lose them on every subsequent request - not an acceptable "non-invasive" outcome, and not something Ali asked for.

The chosen design avoids new columns entirely by **not persisting this at all**. The coinbase transaction is never actually lost: it lives permanently in the underlying node/Esplora backend, addressable by block hash via the already-existing, already-used `bitcoinApi.$getCoinbaseTx(blockhash)` (`backend/src/api/bitcoin/esplora-api.ts:606`, `backend/src/api/bitcoin/bitcoin-api.ts:284`, already called today by the coinbase-address backfill job at `blocks.ts:966`). `elektron-net-mempool`'s own `blocks` SQL table is a cache for list/search performance, not the only source of this data - so detection can simply run **at request time**, in the single-block (and single-tx) detail handlers, computed fresh from a live `$getCoinbaseTx()` call:

- `backend/src/api/bitcoin/bitcoin.routes.ts`, the `getBlock` handler (current line ~483, calling `blocks.$getBlock(req.params.hash)`): after the existing call returns (regardless of whether it came from the DB cache or was freshly indexed), fetch the coinbase transaction once more via `bitcoinApi.$getCoinbaseTx(hash)` and merge the two parsed fields into the JSON response before it is sent. `BlocksRepository`, `mempool.interfaces.ts`, and `database-migration.ts` are **not** touched.
- The equivalent single-transaction detail endpoint for a coinbase txid gets the same treatment, parsing directly from the transaction it already fetched.

Cost: one extra, cheap, already-battle-tested transaction lookup per block-detail request (the exact same call the existing backfill job already performs in bulk without issue). This is strictly a single-block/single-tx feature - it cannot be used to filter or search across many blocks by pool identity in bulk, since nothing is stored, but that was already out of scope (Section 9, "no automatic reconciliation ... no search").

Planned new module `backend/src/api/pool-identity-parser.ts`, exporting `extractPoolIdentityField(vout, magic)`:

- Iterates every `vout` entry (not just a fixed index), matching the same content-addressed philosophy as Section 3.
- For each output whose `scriptpubkey_type` is `op_return`: decode the script's single data push directly from `scriptpubkey` (raw hex), rather than relying on esplora's human-readable `scriptpubkey_asm` string formatting, so the parser does not depend on asm-formatting conventions.
- **MUST** first verify the decoded script is exactly `OP_RETURN <one push>` (reject anything with a second push, which rules out any accidental match against the two-push UTXO-attestation shape).
- If the single push's first 4 bytes equal the given `magic`, return the remaining bytes decoded as UTF-8 (replacing invalid sequences rather than throwing); otherwise return `null`.
- **MUST NOT** match a 36-byte push starting with `aa21a9ed` (the witness-commitment magic) against either `EPNM`/`EPUR` magic - this is automatic since the byte comparison is exact-prefix, not partial, but is worth an explicit unit test (Section 7).

## 5. Storage: None (By Design)

No new `BlockExtension` fields, no new `blocks` table columns, no `database-migration.ts` step, no changes to `BlocksRepository.ts`. Per Section 4, the two fields are computed fresh from `bitcoinApi.$getCoinbaseTx(hash)` at request time and attached only to the outgoing API response object, never written back to SQL or to the in-memory `BlockExtended` object that gets persisted by `blocksRepository.$saveBlockInDatabase()`.

This is a deliberate trade-off, not an oversight:

- **Gain:** zero migration, zero schema change, zero backfill risk for the existing block history, zero new persisted columns to maintain (truncation limits, index bloat, GDPR-style "how do we scrub this" questions for free-form operator text - none of that applies to data that is never stored).
- **Cost:** one extra transaction lookup per block-detail request (same call the coinbase-address backfill job already performs in bulk today), and no ability to bulk-search/filter/list blocks by pool identity - already ruled out as a non-goal in Section 9 before this revision, so nothing is actually given up versus the original plan.
- **MAY, later, if bulk search is ever wanted:** revisit persistence at that point, ideally as a single additive `pool_identity` JSON column (`{"name": "...", "url": "..."}`) rather than two separate `varchar` columns, keeping any future migration to one line. Not needed for this revision.

## 6. API / Frontend Exposure

- In the `getBlock` route handler (`backend/src/api/bitcoin/bitcoin.routes.ts`, current line ~483), after `blocks.$getBlock(req.params.hash)` returns, call `bitcoinApi.$getCoinbaseTx(hash)`, run `extractPoolIdentityField()` for both magics, and add `pool_identity_name` / `pool_identity_url` to the JSON response only if either is non-null (omit the keys entirely otherwise, so existing API consumers see no shape change for blocks that opt out).
- `$getCoinbaseTx(blockhash)` (`bitcoin-api.ts`) now passes `blockhash` through to `$getRawTransaction()`. This fork is always pruned and never runs `-txindex`, so without a block hash, `getrawtransaction` can only find a transaction still sitting in the mempool - a confirmed coinbase tx never is, so the lookup failed for every block until this was added.
- If the coinbase lookup instead fails because the block has aged out of the mandatory pruning window (RPC error message containing "pruned"), the response additionally carries `pool_identity_pruned: true` alongside `pool_identity_name`/`pool_identity_url` both `null` - distinct from a pool that simply never added these outputs (where the three keys are omitted entirely). The in-process cache (`bitcoin.routes.ts`) stores this result permanently too, since a pruned block never becomes readable again.
- Frontend (block-details page): a small, visually secondary line such as "Pool self-reported: `<name>` (`<url>`)" next to the existing registry-matched pool tag/logo, and a distinct "unknown (pruned)" treatment when `pool_identity_pruned` is set. It **MUST** be visually distinguishable from the verified pool tag (e.g. muted styling, an "unverified" tooltip) so users do not mistake a self-declared claim for a registry-confirmed identity. Exact component design is out of scope for this draft and is flagged as follow-up UI work (Section 10).

## 7. Test Plan

Unit-test `pool-identity-parser.ts` against:

- No `OP_RETURN` outputs in the coinbase.
- One matching magic, both matching magics, only one of the two.
- A decoy 36-byte push starting with `aa21a9ed` (the real witness commitment) - must be ignored, never reported as pool identity.
- A two-push output shaped like `<height><32 bytes>` (the real UTXO attestation, or an adversarial look-alike) - must be ignored, since the parser only ever accepts a single-push `OP_RETURN`.
- Truncated or malformed pushes (fewer than 4 bytes after `OP_RETURN`).
- Payload bytes that are not valid UTF-8.

Integration test: hit the `getBlock` route handler with a fixture block whose coinbase carries both new outputs (in addition to the existing attestation/witness-commitment outputs) and assert the JSON response contains `pool_identity_name`/`pool_identity_url`, while a block-detail request served from the DB cache (`$getBlockByHash` returning non-null) still gets the fields merged in correctly, proving the compute-on-read step runs independently of whether the block itself came from cache or from fresh indexing.

## 8. Checklist

- [x] Implement `pool-identity-parser.ts` (Section 4) - content-addressed, single-push-only, magic-prefix match, never mistakes the witness commitment or a two-push attestation-shaped output for pool identity
- [x] Wire the compute-on-read step into the `getBlock` route handler in `bitcoin.routes.ts` (Section 4/6), calling `bitcoinApi.$getCoinbaseTx(hash)`, with a small bounded in-process cache (1000 entries) and a try/catch fallback to the plain block response if the coinbase lookup fails
- [x] Add the two fields to the block API response, omitted when both are null (Section 6)
- [x] Tests per Section 7 (10 unit tests on `pool-identity-parser.ts`; all passing)
- [x] Confirm the magic byte values against the final `elektron-net-ppool` implementation before merging (Section 3) - confirmed identical (`EPNM`/`EPUR`)
- [x] Confirm the same magic byte values against `elektron-net-pool`'s parity implementation (added September 4, 2026) - confirmed identical, no parser change needed
- [x] Fix `$getCoinbaseTx()` (`bitcoin-api.ts`) to pass the block hash through to `$getRawTransaction()` - without it, the RPC-backed lookup could never find a confirmed coinbase tx on this fork (always pruned, never `-txindex`: `getrawtransaction` without a block hash only checks the mempool), so pool identity silently never resolved for any block
- [x] Distinguish "block aged out of the pruning window" from "pool declared no identity" in the `getBlock` response (`pool_identity_pruned: true` vs. the fields simply being omitted) - both looked identical to API consumers before this fix
- [ ] Add the equivalent compute-on-read step to the single-transaction detail endpoint for a coinbase txid (Section 4) - not done in this pass; only the block-details endpoint was wired up
- [ ] Frontend display (Section 6) - separate follow-up, needs design input
- [ ] Live-test on regtest/testnet against a real elektron-net-ppool-built block before merging to `main` - Ali is doing this before merge

## 9. Non-Goals for This Revision

- No automatic reconciliation into the `pools.json` registry or the `pools` database table - this stays purely informational/display, consistent with the "informational only" decision recorded in `elektron-net`'s `guideline-coinbase-third-op-return.md` Section 1.
- No validation, allowlisting, or uniqueness enforcement of self-reported pool names.
- No persistence anywhere (SQL, Redis, or otherwise) and no bulk search/filter/list by pool identity across many blocks - see Section 5.

## 10. Open Questions

1. Should a per-block index/search be added for self-reported pool identity (e.g. "find all blocks self-tagged as X")? Deferred - not needed for basic display. **Resolved (September 5, 2026):** yes, for a ranking use case specifically - see [`guideline-pool-identity-ranking.md`](./guideline-pool-identity-ranking.md), implemented on the `poolrang` branch. This adds a separate, incrementally-populated table rather than revisiting the "storage: none" decision in Section 5 above, which still holds for the single-block detection path this document covers.
2. Exact frontend visual treatment for "self-reported, unverified" needs Ali's input on how prominent versus how muted it should be. This now also needs to cover the `pool_identity_pruned` case (Section 6) - a block whose coinbase can no longer be read at all should read as "unknown" to the user, not as "this pool declared nothing."
3. Should `elektron-net-pool` (the solo pool) adopt the identical `EPNM`/`EPUR` magic bytes, so this parser works unmodified for both pools? **Resolved (September 4, 2026):** yes - `elektron-net-pool` implemented the identical coinbase format on its own `poolidentity` branch (see that repo's `doc-elektron/guideline-pool-identity-op-return.md`), confirming this parser is pool-agnostic in practice and required no code change.
