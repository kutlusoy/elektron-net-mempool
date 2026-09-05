# Elektron Net - `elektron-net-mempool` Pool Identity Ranking Guideline

- **Version:** 0.2 (draft, implemented on `poolrang`, pending review; revised to reuse the existing `pools`/`blocks.pool_id` infrastructure instead of a separate table)
- **Date:** September 05, 2026
- **Audience:** `elektron-net-mempool` backend developers
- **Reference implementation:** [`elektron-net-mempool`](https://github.com/kutlusoy/elektron-net-mempool) - `backend/src/api/blocks.ts` (`$findBlockMiner()`), `backend/src/repositories/SelfReportedPoolsRepository.ts`, `backend/src/tasks/self-reported-pools-pruner.ts` - treat as ground truth for anything referenced below
- **See also:** [`guideline-pool-identity-detection.md`](./guideline-pool-identity-detection.md) (companion document; Section 10, Open Question 1, is what this document resolves)

- Requirement-level words follow standard usage: **MUST** = mandatory, **SHOULD** = strongly recommended, **MAY** = optional.
- Never use the em dash character in this document or its follow-up code comments; use a hyphen and spaces instead, as done throughout.

---

## 1. Status of This Document

`guideline-pool-identity-detection.md` Section 5 deliberately chose not to persist self-reported pool identity anywhere, and Section 10 Open Question 1 explicitly deferred a per-block index/search as not needed for basic display. Ali has since asked for exactly that, because most pools mining Elektron Net are not (and likely never will be) in the curated `pools.json` registry, so the existing pool-ranking page shows them only as "Solo Pool Miner" (the generic unknown-pool bucket) - the self-reported identity is the only signal available for these pools at all.

**Revision note (v0.2):** the first draft of this document added a dedicated `pool_identity_stats` table and a new API endpoint, kept deliberately separate from the registry-matched `pools`/`blocks.pool_id` data to avoid any risk of self-declared text being mistaken for verified pool data. Ali's explicit direction: reuse what already exists rather than duplicate it, on the condition that growth stays bounded (cap at 1000, prune inactivity). This revision does exactly that - self-reported pools become ordinary rows in the existing `pools` table, referenced by `blocks.pool_id` like any registered pool, so the existing ranking page, hashrate charts, and luck/audit stats all pick them up automatically. There is no new table, no new migration, and no new API endpoint in this revision.

## 2. Why This Is Safe Despite Reusing `pools`/`blocks.pool_id`

`blocks.pool_id` is a real foreign key into `pools.id`, and it is the join key for essentially every mining statistic in this codebase: the ranking (`PoolsRepository.$getPoolsInfo()`), hashrate history (`HashratesRepository`, itself keyed by `pool_id`), and per-pool luck/match-rate (`blocks_audits` joined by block height, filtered by `pool_id`). Reusing this structure for self-declared, unverified text is exactly the spoofing concern `guideline-pool-identity-detection.md` Section 2 already raised for the single-block display - just at the database level instead of the page level. Ali's decision (see also this branch's chat history) is to treat self-reported pools identically to registered ones everywhere they are displayed, accepting that trade-off explicitly rather than adding a "verified" flag/badge.

One scoping rule remains **mandatory**, independent of that display decision, because it protects *registered pools' own statistics*, not just how self-reported ones look: a self-declared name **MUST NOT** ever be able to resolve to a real registered pool's row. Concretely, self-reported pools are always given a **negative** `unique_id` (registered pools always have a positive one, assigned by the pools-v2.json project; the generic unknown pool uses `0`), and every lookup/creation query is scoped to `unique_id < 0`. Without this, an attacker could self-declare e.g. "Foundry USA" and have their blocks silently folded into the real Foundry USA's hashrate/luck stats - a strictly worse outcome than anything the visual-badge question above was about, and one the "treat them identically" decision does not require accepting.

## 3. Detection Point: Inside `$findBlockMiner()`, as the Last Fallback

`blocks.ts`'s `$findBlockMiner(txMinerInfo, rawCoinbaseVout?)` is the single function responsible for resolving a block's pool, called from all three places a block's pool ever gets determined:

1. The live new-block handler (`blocks.ts`, the main polling/notification loop) - calls `$findBlockMiner()` directly, then passes the resolved pool into `block-processor.ts` as `providedPool`.
2. `$getBlockExtended()`'s own internal call, used by `$indexBlock()` (single-block reindex/on-demand indexing) and by the bounded backfill loop that catches up on recently-missing blocks.
3. (Indirectly) anywhere else that ends up calling either of the above.

`$findBlockMiner()` already falls back to the generic unknown pool once `PoolsParser.matchBlockMiner()` (the registry match) fails. This revision inserts one more fallback step **between** that failure and returning "unknown": if a `rawCoinbaseVout` was supplied and `extractPoolIdentity()` finds a self-reported name, resolve (creating if necessary) a `pools` row for it via `SelfReportedPoolsRepository.$getOrCreatePool()` and return that instead.

`rawCoinbaseVout` **MUST** be the coinbase transaction's unstripped `vout` array (`transactions[0].vout`), not `txMinerInfo.vout`. `transactionUtils.stripCoinbaseTransaction()` maps every vout down to `{scriptpubkey_address, scriptpubkey_asm, value}` and filters out zero-value outputs entirely - which silently discards every `OP_RETURN` output, pool-identity ones included. This was caught by `tsc` (the stripped type lacks `scriptpubkey`/`scriptpubkey_type`, which `extractPoolIdentityField()` requires) during the first implementation pass of this feature, not by a silent runtime no-op, but is worth stating explicitly so a future refactor of either function does not reintroduce it. Both call sites now pass `transactions[0]?.vout` alongside the already-stripped `txMinerInfo`.

Because this only ever runs as a fallback inside the same function the registry match already runs in, it inherits that function's existing count-once behavior for free: `$indexBlock()`'s early return (`if (dbBlock !== null) return dbBlock;`) means a block already in the database is never re-resolved, so a self-reported pool is only ever created (or has its block count incremented, implicitly, by the next block being attributed to the same `pools.id`) the first time each block is seen - no historical backfill, and no extra RPC call (the coinbase vout is already in memory).

## 4. Storage: No New Table, No Migration

Self-reported pools are inserted directly into the existing `pools` table (`SelfReportedPoolsRepository.$createPool()`):

- `name`: the self-declared name, trimmed and truncated to 50 characters (`pools.name varchar(50)`).
- `link`: the self-declared URL, trimmed and truncated to 255 characters (`pools.link varchar(255)`, `NOT NULL` - an empty string when no URL was declared, matching the column's existing constraint).
- `addresses`, `regexes`: `"[]"`, matching every other pool with none configured - self-reported pools are never matched against by `matchBlockMiner()` on subsequent blocks; each block reaches this fallback independently.
- `slug`: derived the same way the existing codebase already derives one for registered pools (`name.replace(/[^a-z0-9]/gi, '').toLowerCase()`), falling back to `pool` if that produces an empty string, and disambiguated with a numeric suffix (the row's own id) if another pool - registered or self-reported - already has that slug. `pools.slug` carries no unique constraint in this schema, but the pool-detail page's routing (`/mining/pool/:slug`) assumes one in practice.
- `unique_id`: set to the negative of the row's own auto-increment `id` in a follow-up `UPDATE`, once that id exists (Section 2). No new column, no schema change at all.

Get-or-create is a plain `SELECT ... WHERE name = ? AND unique_id < 0` followed by an `INSERT` on miss - no database-level uniqueness is enforced on `pools.name`, matching this table's existing schema, and safe in practice because blocks are indexed one at a time in this codebase (no concurrent indexing of the same not-yet-seen name).

## 5. Bounding Growth: Cap at 1000, Prune Long-Inactive Pools

Since any block can self-declare an arbitrary, previously-unseen name, the set of self-reported `pools` rows could otherwise grow without bound - one new row per distinct name, forever, each one also a permanent `blocks.pool_id` foreign-key target. `SelfReportedPoolsRepository.$pruneInactiveAndOverflow()`, run once a day by `self-reported-pools-pruner.ts` (mirroring `pools-updater.ts`'s existing periodic-task pattern, not part of the per-block indexing path at all), enforces two independent limits over the `unique_id < 0` rows:

- **Overflow:** ranked by block count, only the best `MAX_TRACKED_POOLS` (1000) are kept.
- **Inactivity:** any self-reported pool with no block in the last `INACTIVITY_THRESHOLD_SECONDS` (90 days) is removed, regardless of its rank.

**Deleting a pruned pool is not a plain `DELETE`.** `blocks.pool_id` is a real foreign key, and `blocks` is permanent chain history that is never deleted - a naive `DELETE FROM pools` would either be rejected by the FK constraint (the default `RESTRICT` behavior) or, if cascaded, would delete real historical block rows, which is not acceptable. `$reassignAndDeletePool()` instead first runs `UPDATE blocks SET pool_id = <unknownPoolId> WHERE pool_id = <prunedPoolId>`, folding those blocks back into the generic "Solo Pool Miner" bucket - the same state they would be in if the pool had never declared an identity - and only then deletes the now-unreferenced `pools` row. This is a rare, occasional write (only for the pools actually being evicted, at most once a day), not a per-block cost, and it never touches a row with `unique_id >= 0` (`$reassignAndDeletePool` and the underlying `DELETE` are both scoped to `unique_id < 0` as an extra safeguard).

## 6. API / Frontend Exposure

None needed. Every existing endpoint and page that reads from `pools`/`blocks.pool_id` - the pool-ranking page, hashrate history, per-pool blocks/luck page - already includes self-reported pools automatically, with the same visual treatment as any registered pool, per Ali's decision in Section 2. This was verified by inspecting `PoolsRepository.$getPoolsInfo()`, `mining.$getPools()`, and `pool-ranking.component.ts`/`.html`: none of them filter by `unique_id`, `slug`, or any other field that would need adjusting.

## 7. Test Plan

- Unit-tested (`__tests__/repositories/self-reported-pools-repository.test.ts`): the pure `normalizeSelfReportedName()`/`normalizeSelfReportedUrl()`/`slugifySelfReportedName()` helpers - null/empty/whitespace-only input, trimming, truncation at the 50/255 boundaries, and slug fallback/character-stripping behavior. These are the only parts of this feature that do not require a live database, matching this codebase's existing convention of unit-testing pure logic only and leaving DB-touching repository methods to the (separate, DB-backed) integration test suite.
- Not yet covered by an integration test in this revision: `$getOrCreatePool()`'s get-or-create behavior, slug disambiguation, and `$pruneInactiveAndOverflow()`'s reassign-then-delete behavior against a real database (see Section 8).

## 8. Checklist

- [x] `SelfReportedPoolsRepository.ts`: `$getOrCreatePool()` (get-or-create, scoped to `unique_id < 0`), `$pruneInactiveAndOverflow()` (cap at 1000 + 90-day inactivity, reassign-then-delete)
- [x] `blocks.ts`'s `$findBlockMiner()`: self-reported fallback after the registry match fails, before returning unknown; both call sites updated to pass the raw (unstripped) coinbase vout
- [x] `self-reported-pools-pruner.ts`: daily periodic task, wired up in `index.ts` alongside `poolsUpdater`
- [x] Unit tests for the pure normalization/slugify helpers
- [ ] Integration test against a real database for `$getOrCreatePool()`/`$pruneInactiveAndOverflow()`
- [ ] Live-test on a syncing node to confirm self-reported pools actually appear in the existing ranking page as new blocks arrive, before merging to `main`

## 9. Non-Goals for This Revision

- No historical backfill of blocks indexed before this feature shipped - only blocks resolved through `$findBlockMiner()` from here on can create or grow a self-reported pool's block count.
- No visual distinction between self-reported and registered pools anywhere in the frontend (Section 2 - Ali's explicit decision).
- No fuzzy name matching or normalization beyond trim/truncate - two self-declared names that differ by punctuation or case are different pools.

## 10. Open Questions

1. Is 90 days the right inactivity threshold, and is ranking purely by raw block count (ignoring difficulty/network growth over that window) good enough for the overflow cutoff? Currently fixed constants in `SelfReportedPoolsRepository.ts`. Deferred until there is a concrete reason to tune them.
2. Should `$pruneInactiveAndOverflow()`'s daily cadence be configurable? Currently fixed in `self-reported-pools-pruner.ts`. Deferred for the same reason.
