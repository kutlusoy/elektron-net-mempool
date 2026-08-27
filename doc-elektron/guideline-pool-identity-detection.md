# Elektron Net - `elektron-net-mempool` Pool Identity Detection Guideline

- **Version:** 0.1 (draft)
- **Date:** August 27, 2026
- **Audience:** `elektron-net-mempool` backend and frontend developers
- **Reference implementation:** [`elektron-net-ppool`](https://github.com/kutlusoy/elektron-net-ppool) - `doc-elektron/guideline-pool-identity-op-return.md` (companion document, defines the exact coinbase byte format this document detects); this repo's `backend/src/api/blocks.ts` (`$getBlockExtended()`, `$findBlockMiner()`), `backend/src/api/pools-parser.ts` (`matchBlockMiner()`), `backend/src/repositories/BlocksRepository.ts`, `backend/src/api/database-migration.ts` (schema version 112 at time of writing) - treat as ground truth for anything referenced below
- **Consumer:** block-details / mining-pool pages in `frontend/`
- **See also:** [`guideline-pool-identity-op-return.md`](https://github.com/kutlusoy/elektron-net-ppool/blob/poolidentity/doc-elektron/guideline-pool-identity-op-return.md), [`guideline-coinbase-third-op-return.md`](https://github.com/kutlusoy/elektron-net/blob/main/doc-elektron/guideline-coinbase-third-op-return.md)

- Requirement-level words follow standard usage: **MUST** = mandatory, **SHOULD** = strongly recommended, **MAY** = optional.
- Never use the em dash character in this document or its follow-up code comments; use a hyphen and spaces instead, as done throughout.

---

## 1. Status of This Document

This is a **plan, not yet implemented**. It is the companion to `elektron-net-ppool`'s `doc-elektron/guideline-pool-identity-op-return.md`, which specifies two new, magic-tagged, informational `OP_RETURN` outputs a pool may add to its coinbase transaction (a self-declared pool name and pool URL). This document specifies how `elektron-net-mempool` detects, stores, and exposes them, without touching consensus code and without changing any existing pool-matching logic.

No code in this repo has been changed yet. The checklist in Section 8 is the follow-up work.

## 2. Relationship to Existing Address-Based Matching (Keep Both)

`backend/src/api/pools-parser.ts`'s `matchBlockMiner(scriptsig, addresses, pools)` remains the **authoritative** pool match, based on the curated `pools.json` registry (`addresses`/`regexes`). This document does not change that function or that registry.

The two new coinbase fields are, by construction, **self-declared and unverified** - any miner can put any text into a coinbase `OP_RETURN`. They **MUST** be treated and displayed as a supplementary, clearly-labeled "self-reported" signal, and **MUST NOT** silently override or replace the registry-matched pool name or logo. Failing to keep this distinction would create a spoofing vector: an unrelated miner could tag their blocks with a well-known pool's name to appear legitimate. See also Section 1 of `elektron-net`'s `guideline-coinbase-third-op-return.md`, which already establishes that this whole class of output is "informational only."

## 3. Byte Format Being Detected (From the Companion Document)

| Output | Magic (hex) | Magic (ASCII) | Payload |
|---|---|---|---|
| Pool name | `45504e4d` | `EPNM` | UTF-8 pool name |
| Pool URL | `45505552` | `EPUR` | UTF-8 URL |

Each is a **single** `OP_RETURN` data push: `MAGIC (4 bytes) || UTF-8 payload`, value `0`, always among the **last** coinbase outputs but **MUST** be located by **content**, not by position - mirroring how the node itself locates the UTXO attestation and witness commitment (`guideline-coinbase-third-op-return.md` Section 3: "both are content-addressed, not position-addressed").

## 4. Detection Point

`$getBlockExtended()` in `backend/src/api/blocks.ts`, at the same place `coinbaseAddress`/`coinbaseAddresses`/`coinbaseSignature` are already derived from `coinbaseTx.vout` (current lines ~311-321):

```ts
if (coinbaseTx?.vout.length > 0) {
    extras.coinbaseAddress = coinbaseTx.vout[0].scriptpubkey_address ?? null;
    extras.coinbaseAddresses = [...new Set<string>(coinbaseTx.vout.map(v => v.scriptpubkey_address).filter(a => a) as string[])];
    extras.coinbaseSignature = coinbaseTx.vout[0].scriptpubkey_asm ?? null;
    extras.coinbaseSignatureAscii = transactionUtils.hex2ascii(coinbaseTx.vin[0].scriptsig) ?? null;
    // planned addition:
    // extras.poolIdentityName = extractPoolIdentityField(coinbaseTx.vout, POOL_IDENTITY_MAGIC_NAME);
    // extras.poolIdentityUrl = extractPoolIdentityField(coinbaseTx.vout, POOL_IDENTITY_MAGIC_URL);
} else {
    ...
}
```

Planned new module `backend/src/api/pool-identity-parser.ts`, exporting `extractPoolIdentityField(vout, magic)`:

- Iterates every `vout` entry (not just a fixed index), matching the same content-addressed philosophy as Section 3.
- For each output whose `scriptpubkey_type` is `op_return`: decode the script's single data push directly from `scriptpubkey` (raw hex), rather than relying on esplora's human-readable `scriptpubkey_asm` string formatting, so the parser does not depend on asm-formatting conventions.
- **MUST** first verify the decoded script is exactly `OP_RETURN <one push>` (reject anything with a second push, which rules out any accidental match against the two-push UTXO-attestation shape).
- If the single push's first 4 bytes equal the given `magic`, return the remaining bytes decoded as UTF-8 (replacing invalid sequences rather than throwing); otherwise return `null`.
- **MUST NOT** match a 36-byte push starting with `aa21a9ed` (the witness-commitment magic) against either `EPNM`/`EPUR` magic - this is automatic since the byte comparison is exact-prefix, not partial, but is worth an explicit unit test (Section 7).

## 5. Storage

- New `BlockExtension` fields in `backend/src/mempool.interfaces.ts`, next to the existing `coinbaseSignature`/`coinbaseSignatureAscii` (current lines ~320-321):
  ```ts
  poolIdentityName: string | null;
  poolIdentityUrl: string | null;
  ```
- New `blocks` table columns, added via a new migration step in `backend/src/api/database-migration.ts` (current `currentVersion = 112` -> bump to `113`), following the exact pattern already used for `coinbase_signature`/`coinbase_signature_ascii` (current lines ~1602-1605):
  ```sql
  ADD pool_identity_name varchar(200) NULL,
  ADD pool_identity_url varchar(200) NULL,
  ```
- `backend/src/repositories/BlocksRepository.ts`:
  - Extend the `SELECT` list (pattern at current lines ~93-94) to read the two new columns.
  - Extend the extras-hydration block (pattern at current lines ~1305-1306) to populate `extras.poolIdentityName`/`extras.poolIdentityUrl`.
  - Extend the truncation-on-save logic (pattern at current lines ~120-121, where `coinbaseSignature`/`coinbaseSignatureAscii` are truncated to 500 chars before insert) to similarly cap the two new fields at the column width, since both are free-form operator-supplied text.

## 6. API / Frontend Exposure

- Add `pool_identity_name` / `pool_identity_url` to the block API response, alongside the existing `coinbase_signature`/`coinbase_signature_ascii` fields.
- Frontend (block-details page): a small, visually secondary line such as "Pool self-reported: `<name>` (`<url>`)" next to the existing registry-matched pool tag/logo. It **MUST** be visually distinguishable from the verified pool tag (e.g. muted styling, an "unverified" tooltip) so users do not mistake a self-declared claim for a registry-confirmed identity. Exact component design is out of scope for this draft and is flagged as follow-up UI work (Section 10).

## 7. Test Plan

Unit-test `pool-identity-parser.ts` against:

- No `OP_RETURN` outputs in the coinbase.
- One matching magic, both matching magics, only one of the two.
- A decoy 36-byte push starting with `aa21a9ed` (the real witness commitment) - must be ignored, never reported as pool identity.
- A two-push output shaped like `<height><32 bytes>` (the real UTXO attestation, or an adversarial look-alike) - must be ignored, since the parser only ever accepts a single-push `OP_RETURN`.
- Truncated or malformed pushes (fewer than 4 bytes after `OP_RETURN`).
- Payload bytes that are not valid UTF-8.

Integration test: extend the existing block-processing test fixtures with a synthetic coinbase carrying both new outputs (in addition to the existing attestation/witness-commitment outputs) and assert that `BlockExtended.extras.poolIdentityName`/`poolIdentityUrl` populate correctly on `$getBlockExtended()`, and correctly persist and reload via `BlocksRepository`.

## 8. Checklist (Not Yet Implemented)

- [ ] Implement `pool-identity-parser.ts` (Section 4)
- [ ] Wire the two new fields into `$getBlockExtended()` (Section 4)
- [ ] Add `poolIdentityName`/`poolIdentityUrl` to `mempool.interfaces.ts` (Section 5)
- [ ] Add database migration `113` (Section 5)
- [ ] Extend `BlocksRepository.ts` read/write/truncation paths (Section 5)
- [ ] Add the two fields to the block API response (Section 6)
- [ ] Frontend display (Section 6) - separate follow-up, needs design input
- [ ] Tests per Section 7
- [ ] Confirm the magic byte values against the final `elektron-net-ppool` implementation before merging (Section 3)

## 9. Non-Goals for This Revision

- No automatic reconciliation into the `pools.json` registry or the `pools` database table - this stays purely informational/display, consistent with the "informational only" decision recorded in `elektron-net`'s `guideline-coinbase-third-op-return.md` Section 1.
- No validation, allowlisting, or uniqueness enforcement of self-reported pool names.
- No support for any pool implementation that does not use the exact magic bytes from Section 3 (notably `elektron-net-pool`, unless and until it adopts the same format - see Open Questions).

## 10. Open Questions

1. Should a per-block index/search be added for self-reported pool identity (e.g. "find all blocks self-tagged as X")? Deferred - not needed for basic display.
2. Exact frontend visual treatment for "self-reported, unverified" needs Ali's input on how prominent versus how muted it should be.
3. Should `elektron-net-pool` (the solo pool) adopt the identical `EPNM`/`EPUR` magic bytes, so this parser works unmodified for both pools? Recommendation: yes, since this parser is already pool-agnostic and purely content-addressed - no mempool-side change would be needed if `elektron-net-pool` later ships the same coinbase format.
