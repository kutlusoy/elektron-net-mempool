# Elektron Net - `elektron-net-mempool` Pool Identity Ranking Guideline

- **Version:** 0.1 (draft, implemented on `poolrang`, pending review)
- **Date:** September 05, 2026
- **Audience:** `elektron-net-mempool` backend and frontend developers
- **Reference implementation:** [`elektron-net-mempool`](https://github.com/kutlusoy/elektron-net-mempool) - `backend/src/api/blocks.ts` (`$indexBlock()`), `backend/src/repositories/PoolIdentityStatsRepository.ts`, `backend/src/api/mining/mining-routes.ts` - treat as ground truth for anything referenced below
- **See also:** [`guideline-pool-identity-detection.md`](./guideline-pool-identity-detection.md) (companion document; Section 10, Open Question 1, is what this document resolves)

- Requirement-level words follow standard usage: **MUST** = mandatory, **SHOULD** = strongly recommended, **MAY** = optional.
- Never use the em dash character in this document or its follow-up code comments; use a hyphen and spaces instead, as done throughout.

---

## 1. Status of This Document

`guideline-pool-identity-detection.md` Section 5 deliberately chose not to persist self-reported pool identity anywhere, and Section 10 Open Question 1 explicitly deferred "should a per-block index/search be added for self-reported pool identity" as not needed for basic display. Ali has since asked for exactly that: a pool ranking list built from self-reported names, because most pools mining Elektron Net are not (and likely never will be) in the curated `pools.json` registry, so the existing, registry-based pool-ranking page shows them as "Unknown" - the self-reported identity is the only signal available for these pools at all.

This document specifies how that ranking is populated, kept bounded, and exposed, without reopening the single-block detection path (Section 4-6 of the companion document are unchanged) and without the cost/risk of a historical backfill.

## 2. Relationship to Existing Detection (Keep Both)

The single-block, compute-on-read detection in `bitcoin.routes.ts` (companion document Section 4/6) is unchanged. This is a second, independent consumer of the same `pool-identity-parser.ts` (`extractPoolIdentity()`), reading the same OP_RETURN outputs but at a different point in the pipeline (indexing, not request time) and for a different purpose (aggregate ranking, not single-block display).

Like the single-block feature, this ranking is **self-declared and unverified**. It **MUST NOT** be merged into, or influence, the registry-matched `pools` table, `pools.json`, or the existing pool-ranking page's data. It is exposed as its own, separately-labeled list.

## 3. Detection Point: On Index, Not On Read (Different Trade-off Than Section 4)

The companion document's Section 4 chose compute-on-read specifically because indexing writes the same `BlockExtended` row every time regardless of how many times it is later requested, so a value stored on that row only reflects whatever was true the one time it was computed - and once a block is in the DB, `$indexBlock()`'s early return (`if (dbBlock !== null) return dbBlock;`) means the coinbase is never looked at again.

That exact property is what this feature needs: **count each block exactly once, the first time it is indexed, and never again.** So the hook point here is deliberately the opposite of Section 4: inside `$indexBlock()`, immediately after `$getBlockExtended()` returns and inside the same `Common.indexingEnabled()` guard already wrapping `blocksRepository.$saveBlockInDatabase()` - i.e. only on the branch that just froze this block as a new row for the first time.

Consequences of this choice:

- **No historical backfill, by construction.** A block already in the `blocks` table when this feature is deployed is never revisited. Ranking data only accumulates forward from whichever block height happens to be the current tip when this ships. This is intentional (Ali: "ab einlangen der Blöcke gezählt werden", i.e. count as blocks come in, from a certain point forward) and also the only option that doesn't touch already-pruned coinbases (Section 4's pruning discussion: a pruned block's coinbase cannot be re-read at all).
- **Zero extra RPC/HTTP cost.** `$indexBlock()` already has the coinbase transaction in memory as `transactions[0]` (fetched by `$getTransactionsExtended()` a few lines earlier for the existing block-processing pipeline). `extractPoolIdentity(transactions[0].vout)` reads it directly - no additional `$getCoinbaseTx()` call, unlike the single-block route.
- **MUST use the raw `transactions[0].vout`, not `transactionUtils.stripCoinbaseTransaction()`'s output.** `$getBlockExtended()` calls `stripCoinbaseTransaction()` for its own coinbase-address bookkeeping, but that helper maps each vout down to `{scriptpubkey_address, scriptpubkey_asm, value}` and **filters out every zero-value output** - which silently discards all `OP_RETURN` outputs, pool-identity ones included. This was caught by `tsc` (the stripped type lacks `scriptpubkey`/`scriptpubkey_type`, which `extractPoolIdentityField()` requires) rather than by a silent runtime no-op, but is worth stating explicitly so a future refactor of either function does not reintroduce it.
- **Excludes stale/orphaned blocks** (`if (!block.stale)`), matching every existing pool ranking/stats query in `BlocksRepository.ts` (`WHERE stale = 0`). A block that gets reorged out was never really "found" by anyone in the canonical sense this ranking counts.
- **Runs once per newly-indexed block**, not per API request, so unlike the single-block feature this has no in-process cache to maintain - the persisted row itself is the cache.

## 4. Storage: One New Table, Deliberately Not the `blocks` Table

Companion document Section 5 speculated that if bulk persistence were ever wanted, it should be "a single additive `pool_identity` JSON column" on `blocks`. On reflection this ranking should **not** live on `blocks` at all:

- The ranking needs one row **per distinct self-reported name**, aggregated across many blocks - not one row per block. A per-block JSON column would still require a full table scan/aggregation query to produce a ranking, on every request, across a `blocks` table that already holds the entire chain history.
- A dedicated table lets the aggregate (`block_count`, first/last seen) be maintained incrementally at write time (Section 3), so reading the ranking is always just `ORDER BY block_count DESC LIMIT n` against a table capped at 1000 rows (Section 5) - cheap regardless of how many blocks the chain has indexed.

Schema (`database-migration.ts`, schema version 113, `isBitcoin === true` only, matching the `tx_index` precedent at version 112):

```sql
CREATE TABLE IF NOT EXISTS pool_identity_stats (
  pool_identity_name varchar(191) NOT NULL,
  pool_identity_url varchar(255) NULL,
  block_count int(10) unsigned NOT NULL DEFAULT 0,
  first_seen_height int(10) unsigned NOT NULL,
  last_seen_height int(10) unsigned NOT NULL,
  last_seen_time int(10) unsigned NOT NULL,
  PRIMARY KEY (pool_identity_name),
  INDEX (block_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- `pool_identity_name` is the natural key: one row per exact self-declared name string (trimmed, truncated to 191 bytes - the InnoDB utf8mb4 primary-key-safe length, same reasoning as any other varchar primary key in this codebase). No fuzzy matching, no case-folding, no dedup beyond exact-string equality - consistent with companion document Section 9's "no validation, allowlisting, or uniqueness enforcement of self-reported pool names."
- `pool_identity_url` is **not** part of the key and is overwritten on every matching block (`ON DUPLICATE KEY UPDATE pool_identity_url = VALUES(...)`) - it tracks the most recently self-declared URL for that name, since a pool could change its URL over time without changing its declared name.
- A block that declares a URL but no name is **not** tracked (nothing to group it under) - it still gets the existing single-block display (Section 6 of the companion document) unaffected.
- `utf8mb4` (not the `utf8` used by the `tx_index` table) because pool names are free-form operator text and MAY contain characters outside the BMP.

## 5. Bounding Growth: Top 1000 By Block Count

Ali's explicit requirement: this must not be able to strain the node/database, and suggested capping at the best 1000 pools. Since any block can self-declare an arbitrary, previously-unseen name, an attacker (or just a careless miner rotating names) could otherwise grow this table without bound - one new row per block, forever.

`PoolIdentityStatsRepository.$trackBlock()` upserts the block, then calls `$pruneToTopPools()`:

1. `SELECT COUNT(*) FROM pool_identity_stats` - cheap (the table is capped at ~1000 rows, so this is never a large scan) and gates the rest: if the count is still under the cap, nothing further runs. In the steady state (a handful of real pools), this `SELECT COUNT(*)` is the *only* extra query per block beyond the upsert itself.
2. Only once the table has actually grown past `MAX_TRACKED_POOLS` (1000) does the `DELETE ... WHERE pool_identity_name NOT IN (SELECT ... ORDER BY block_count DESC LIMIT 1000)` run, dropping the lowest-ranked names back down to exactly the cap.

This means a single low-effort spam name (one block, one new name) costs one upsert and one `COUNT(*)`; sustained spam across many distinct names is the only way to ever trigger the more expensive prune step, and even then it is bounded to running once per block rather than scanning unboundedly.

## 6. API / Frontend Exposure

- New route: `GET /api/v1/mining/pool-identity/ranking` (`mining-routes.ts`), mirroring the existing `mining/pools` route's caching headers (`Cache-control: public`, 60s `Expires`). Returns the ranking ordered by `block_count DESC, last_seen_height DESC`, capped at 1000 rows by construction (Section 5) - no pagination needed.
- Response shape (`PoolIdentityStat`, `mempool.interfaces.ts`): `{ name, url, blockCount, firstSeenHeight, lastSeenHeight, lastSeenTime }`.
- Frontend: not yet implemented in this revision (see Section 8). Should reuse the same "unverified/self-reported" visual language already established on the block-details page (muted badge, tooltip), and MUST be presented as a clearly separate list from the registry-verified pool-ranking page, not a replacement for it or a merged column within it.

## 7. Test Plan

- Unit-tested (`__tests__/repositories/pool-identity-stats-repository.test.ts`): the pure `normalizePoolIdentityName()`/`normalizePoolIdentityUrl()` helpers - null/empty/whitespace-only input, trimming, and truncation at the 191/255 boundaries. These are the only parts of the repository that do not require a live database, matching this codebase's existing convention of unit-testing pure logic only and leaving DB-touching repository methods to the (separate, DB-backed) integration test suite.
- Not yet covered by an integration test in this revision: `$trackBlock()`'s upsert/increment behavior and `$pruneToTopPools()`'s cap enforcement against a real database (see Section 8).

## 8. Checklist

- [x] `database-migration.ts`: schema version 113, `pool_identity_stats` table, `isBitcoin === true` gated
- [x] `PoolIdentityStatsRepository.ts`: `$trackBlock()` (upsert + increment), `$pruneToTopPools()` (cap at 1000), `$getRanking()`
- [x] Hook into `blocks.ts`'s `$indexBlock()`, reusing the already-fetched coinbase vout, excluding stale blocks
- [x] New route `GET /api/v1/mining/pool-identity/ranking` (`mining-routes.ts`)
- [x] `PoolIdentityStat` interface (`mempool.interfaces.ts`)
- [x] Unit tests for the pure normalization helpers
- [ ] Integration test against a real database for `$trackBlock()`/`$pruneToTopPools()`
- [ ] Frontend ranking page/section (Section 6) - separate follow-up
- [ ] Live-test on a syncing node to confirm the ranking actually accumulates as new blocks arrive, before merging to `main`

## 9. Non-Goals for This Revision

- No historical backfill of blocks indexed before this feature shipped (Section 3).
- No fuzzy matching, normalization beyond trim/truncate, or reconciliation with the `pools.json` registry (Section 4).
- No pagination of the ranking endpoint - the 1000-row cap makes it unnecessary.

## 10. Open Questions

1. Should the cap (1000) be configurable, or is a fixed constant acceptable? Currently fixed in `PoolIdentityStatsRepository.ts`. Deferred until there is a concrete reason to tune it.
2. Frontend visual design for the ranking page/section is open - deferred to a follow-up pass once Ali has reviewed the backend on this branch.
