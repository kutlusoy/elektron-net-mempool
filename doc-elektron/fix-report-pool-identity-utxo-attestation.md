# Elektron Net - `elektron-net-mempool` Fix Report: Pool Identity Detection Removed

- **Version:** 1.0
- **Date:** September 6, 2026
- **Audience:** `elektron-net-mempool` backend developers
- **Reference implementation:** [`elektron-net-pool`](https://github.com/kutlusoy/elektron-net-pool) - `doc-elektron/fix-report-pool-identity-utxo-attestation.md`, [`elektron-net-ppool`](https://github.com/kutlusoy/elektron-net-ppool) - `doc-elektron/fix-report-pool-identity-utxo-attestation.md` (the pool-side reverts this document is the consumer-side counterpart to)
- **See also:** [`guideline-pool-identity-ranking.md`](./guideline-pool-identity-ranking.md) (the self-reported-pools ranking feature this affects; left in place, see Section 4 below)

- Never use the em dash character in this document or its follow-up code comments; use a hyphen and spaces instead, as done throughout.

---

## 1. What Happened

`elektron-net-pool` and `elektron-net-ppool` both added two informational coinbase `OP_RETURN` outputs (`EPNM` name, `EPUR` URL) so blocks could self-report a pool identity. It turned out every block carrying either output was rejected by the network with `bad-utxo-attestation` (see the fix-report docs in those two repos for the root cause: Elektron's per-block UTXO attestation pins the coinbase to exactly `vout[0]` payout plus `coinbase_required_outputs`, and any extra output changes the coinbase txid the node validates against). Both repos reverted the on-chain outputs entirely; there is no pool-side way to keep them.

A direct consequence: no valid Elektron Net block has ever existed, or ever will, with an `EPNM`/`EPUR` coinbase output. `pool-identity-parser.ts` (this repo's detector for those bytes) was therefore looking for data that provably cannot exist on any block that made it into the chain. This document records its removal.

## 2. Fix Applied

- Deleted `backend/src/api/pool-identity-parser.ts` and its test.
- Removed the `GET /block/:hash` response augmentation (`pool_identity_name` / `pool_identity_url` / `pool_identity_pruned`) and its supporting cache (`backend/src/api/bitcoin/bitcoin.routes.ts`) - the route now returns the block unmodified, as it did before this feature existed.
- Removed the self-reported-pool branch from `Blocks.$findBlockMiner()` (`backend/src/api/blocks.ts`): a registry match miss now falls straight through to the generic unknown-pool bucket, same as before this feature existed.
- Deleted `doc-elektron/guideline-pool-identity-detection.md` (the design this reverts).
- Left the frontend's `pool_identity_*` fields (`frontend/src/app/interfaces/node-api.interface.ts`, `frontend/src/app/components/block/block.component.html`) in place; the backend never sends these fields anymore, so the guarding `*ngIf` simply never renders. Harmless, but a candidate for cleanup if this repo wants to remove it later.

## 3. What Was Deliberately Left Alone

`backend/src/repositories/SelfReportedPoolsRepository.ts`, `backend/src/tasks/self-reported-pools-pruner.ts`, and the "Private Pools" ranking bucket (`pools-parser.ts`) are unaffected by this change and were not touched. They are reachable only through the branch removed in Section 2, so as of this fix they can never receive a new entry again - functionally dormant, not broken. See Section 4.

## 4. Open Question: What To Do With the Self-Reported-Pools Ranking Feature

`guideline-pool-identity-ranking.md` describes a real, live-tested feature (ranking entries, hashrate/luck stats, and pruning for self-reported pools) built entirely on top of the coinbase detection this document just removed. Since no block can ever carry that data again, this feature will never create a new ranking entry from here on; only its pruning logic (removing existing entries once they age out) still does anything, and only for rows that already exist. Two options, not decided here:

1. Leave it as-is. Any self-reported-pool rows already in a production database keep aging out normally via the existing pruner; no new ones are ever added. No further code change needed.
2. Remove `SelfReportedPoolsRepository`, the pruner task, the "Private Pools" bucket, and the associated `pools-parser.ts` / `PoolsRepository` hooks entirely, since they can no longer serve their purpose. A larger change than this fix report's scope, and would retire a feature that took several iterations to get right, so left for a separate decision.

## 5. Checklist

- [x] Remove `pool-identity-parser.ts` and its test
- [x] Remove the `GET /block/:hash` response augmentation and its cache
- [x] Remove the self-reported-pool branch from `$findBlockMiner()`
- [x] Remove the now-incorrect guideline document
- [ ] Decide the fate of the self-reported-pools ranking feature (Section 4)
