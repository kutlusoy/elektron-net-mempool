# Elektron Net - `elektron-net-mempool` Pool Registry Reporting Guideline

- **Version:** 0.2 (implemented on `reporegistry`, pending review/merge and live testing before `main`)
- **Date:** September 6, 2026
- **Audience:** `elektron-net-mempool` backend developers
- **Reference implementation:** `backend/src/tasks/pools-updater.ts` (the polling/SHA-diffing pattern this reuses), `backend/src/repositories/SelfReportedPoolsRepository.ts` and `backend/src/tasks/self-reported-pools-pruner.ts` (the dormant storage/ranking layer this finally gives a real data source)
- **See also:** [`fix-report-pool-identity-utxo-attestation.md`](./fix-report-pool-identity-utxo-attestation.md) (why the old on-chain approach was reverted, and Section 4's open question this document resolves), the sibling planning documents in `elektron-net-pool`, `elektron-net-ppool`, and `elektron-net-stack` (same filename, `doc-elektron/guideline-pool-registry-reporting.md`)

- Never use the em dash character in this document or its follow-up code comments; use a hyphen and spaces instead, as done throughout.

---

## 1. Problem This Solves

The reverted on-chain pool-identity feature (`fix-report-pool-identity-utxo-attestation.md`) broke UTXO attestation on every block that used it. Its intended goal, letting a block explorer show a real name/URL for pools not in the curated `pools-v2.json` registry, is still wanted, but must not touch consensus, must cost nothing, and must work identically for both `elektron-net-pool` (solo, no wallet) and `elektron-net-ppool` (PPLNS, has a wallet) - a solo pool has no on-chain footprint of its own at all (the coinbase pays the finding miner directly), so any solution keyed on wallet ownership or coinbase content only ever works for one of the two pool types.

## 2. Design Overview

A new repository, `github.com/kutlusoy/elektron-net-registry` (not created yet), holds two plain text files, each line self-describing and extended purely by fork + pull request, the same trust model already used for `pools-v2.json`:

- `pools.txt`: one line per pool (both `ppool` and solo `pool` entries together), format `"Type", "Name", "URL";` where Type is `"PPLNS"` or `"SOLO"` (added after this section was first written; the type field is not used by the reporting/verification flow itself, kept for possible future filtered listings)
- `mempools.txt`: one line per known block-explorer instance, format `"Name", "URL";`

Both `elektron-net-mempool` and the two pool repos point at this **one** repo URL via a single config value; each side's own updater derives whichever file(s) it needs and how to fetch/diff them, so nothing beyond that one URL needs configuring (mirrors how `MEMPOOL_POOLS_JSON_URL` already works today, generalized to a single base URL instead of two separately-configured endpoints).

Reporting is push-based and per-block, not periodic-match like the old registry-address matching:

1. A pool finds a block. Its own software already knows this the moment it calls `submitblock` successfully.
2. It looks up its locally-synced copy of `mempools.txt` and sends every known mempool instance a small report: pool name and the found block's hash.
3. A receiving mempool instance does **not** trust this report at face value. It looks up the claimed pool name in its own locally-synced copy of `pools.txt` to get that pool's **registered** URL (never the URL the caller supplied in the report itself), then calls back to that URL asking specifically "did you report block `<hash>`?".
4. Only a confirming answer from the pool's own server, reached at its own registered address, gets the block attributed. A third party cannot forge this, since they do not control that server; the pool's own server can truthfully answer yes only for blocks it actually just found.

This binds trust to domain control, the same principle behind ACME HTTP-01 or Slack's URL verification challenge, without tokens, signatures, or any wallet involvement, and is identical for both pool types since neither needs a wallet, only their existing web server.

## 3. What Changed in This Repo

- **`backend/src/api/pool-registry-parser.ts`** (new): parses `pools.txt`'s `"Type", "Name", "URL";` lines by extracting every quoted substring on the line, so it is agnostic to whatever separator sits between them (comma, semicolon, or nothing) - only the quoted content is ever read. Skips malformed lines rather than failing the whole registry.
- **`backend/src/tasks/pool-registry-updater.ts`** (new): fetches `${POOL_REGISTRY_URL}/pools.txt` every `POOL_REGISTRY_UPDATE_DELAY` seconds (default 900, 15 minutes), keeps an in-memory `Map<name, entry>`. Unlike `pools-updater.ts`, this simply refetches on every poll rather than SHA-diffing against a git tree API; the files here are tiny (a few KB even with hundreds of entries) so the extra complexity of change detection was not worth it.
- **`backend/src/api/pool-registry.routes.ts`** (new): `POST /api/v1/pool-registry/report`, body `{ name, blockHash }`. Looks up `name` in the synced registry map to get its **registered** URL (never the URL the caller supplied), calls back to `<url>/pool/identity/confirm?blockHash=<hash>` with a 5-second timeout, and only on `{ confirmed: true }` resolves/creates the pool via `SelfReportedPoolsRepository.$getOrCreatePool()` and attributes the block via the new `BlocksRepository.$updateBlockPool()`.
- **`BlocksRepository.$updateBlockPool(hash, poolId)`** (new): a plain `UPDATE blocks SET pool_id = ? WHERE hash = ?`, used only by the report handler above once a claim is verified.
- **Config**: `POOL_REGISTRY_URL` / `POOL_REGISTRY_UPDATE_DELAY` added to `config.ts`, the docker config template, `start.sh`, and the sample/fixture config files, following the exact pattern `POOLS_JSON_URL` already uses. Because `config.ts` merges an in-code `defaults` object with whatever `mempool-config.json` actually contains, an existing installation that upgrades without regenerating that file still gets the baked-in default URL for the new keys - no separate fallback logic was needed for that, unlike the pool repos (see their own documents).
- **Local cache**: the last successfully fetched `pools.txt` is written to `<CACHE_DIR>/pools-registry.txt` (same persisted cache volume `pools-v2.json` refresh state already lives near). Read first on startup, before any network attempt. A failed or empty-parsing fetch never overwrites the in-memory map or the cache file.
- **Attribution reuse**: confirmed reports flow straight into `SelfReportedPoolsRepository` and the existing `pools`/`blocks.pool_id` ranking infrastructure (`guideline-pool-identity-ranking.md`), which had been sitting dormant since the on-chain source was removed. This is the first real, verified, ongoing data source that infrastructure has had.

## 4. Decisions Made

1. Endpoints: `POST /api/v1/pool-registry/report` (this repo) and `GET /pool/identity/confirm?blockHash=<hex>` (pool side), matching payload shapes on both ends, identical between `elektron-net-pool` and `elektron-net-ppool`.
2. Registry poll interval: 15 minutes (not weekly like `pools-v2.json` - these files are small and prompt attribution matters more here).
3. Retry/timeout: none. The confirmation callback has a 5-second timeout; on failure or a non-`true` answer, the report is simply not attributed. No retry, no queue.
4. Ingest validation: malformed lines are skipped (parser returns only well-formed entries); a duplicate name in the source file overwrites the earlier one in the in-memory map (last one wins), no explicit dedup step needed beyond that.
5. `elektron-net-mempool` does not need its own entry in `mempools.txt` for any code-driven purpose; that list is only consumed by the pool repos to discover where to send reports.

## 5. Checklist

- [x] `elektron-net-registry` repository created with `pools.txt` / `mempools.txt`
- [x] Registry updater task implemented (`pool-registry-updater.ts`)
- [x] Report-receiving endpoint implemented
- [x] Callback verification implemented
- [x] Confirmed reports wired into `SelfReportedPoolsRepository` / ranking
- [ ] Live-test on regtest/testnet (real found block, real report, real callback, real ranking entry) before merging to `main`
