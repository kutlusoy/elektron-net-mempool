# Elektron Net - `elektron-net-mempool` Pool Registry Reporting Guideline

- **Version:** 0.1 (planning, nothing implemented yet)
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

- `pools.txt`: one line per pool (both `ppool` and solo `pool` entries together), format `"Name"; "URL";`
- `mempools.txt`: one line per known block-explorer instance, same format

Both `elektron-net-mempool` and the two pool repos point at this **one** repo URL via a single config value; each side's own updater derives whichever file(s) it needs and how to fetch/diff them, so nothing beyond that one URL needs configuring (mirrors how `MEMPOOL_POOLS_JSON_URL` already works today, generalized to a single base URL instead of two separately-configured endpoints).

Reporting is push-based and per-block, not periodic-match like the old registry-address matching:

1. A pool finds a block. Its own software already knows this the moment it calls `submitblock` successfully.
2. It looks up its locally-synced copy of `mempools.txt` and sends every known mempool instance a small report: pool name and the found block's hash.
3. A receiving mempool instance does **not** trust this report at face value. It looks up the claimed pool name in its own locally-synced copy of `pools.txt` to get that pool's **registered** URL (never the URL the caller supplied in the report itself), then calls back to that URL asking specifically "did you report block `<hash>`?".
4. Only a confirming answer from the pool's own server, reached at its own registered address, gets the block attributed. A third party cannot forge this, since they do not control that server; the pool's own server can truthfully answer yes only for blocks it actually just found.

This binds trust to domain control, the same principle behind ACME HTTP-01 or Slack's URL verification challenge, without tokens, signatures, or any wallet involvement, and is identical for both pool types since neither needs a wallet, only their existing web server.

## 3. What Changes in This Repo

- **New updater task**, modeled directly on `pools-updater.ts`: fetches `pools.txt` from the registry, parses `"Name"; "URL";` lines, keeps an in-memory/DB-backed map of known pool names to their registered URLs. Poll interval should be much shorter than `pools-v2.json`'s weekly cadence (open question below).
- **New API endpoint** (exact path to be decided at implementation time) accepting a report: pool name plus block hash.
- **Verification step**: look up the claimed name in the synced registry map, call back to the registered URL's confirmation endpoint (to be defined jointly with the pool repos, see their own planning documents) with the block hash, and only proceed on a positive, matching answer.
- **Attribution**: on a confirmed report, attribute the referenced block the same way the old self-reported-pools code did, reusing `SelfReportedPoolsRepository` and the existing `pools`/`blocks.pool_id` ranking infrastructure (`guideline-pool-identity-ranking.md`), which has been sitting dormant since the on-chain source was removed. This is the first real, verified, ongoing data source that infrastructure will have had.

## 4. Open Questions

1. Exact endpoint paths and payload shapes for both the incoming report and the outgoing confirmation callback; must be agreed with `elektron-net-pool`/`elektron-net-ppool` before implementation, since both sides need to match exactly.
2. Registry poll interval. Weekly (today's `pools-v2.json` cadence) is too slow for prompt attribution; something in the 15-60 minute range seems more appropriate, needs a decision.
3. Retry/timeout behavior if a pool's confirmation endpoint is briefly unreachable when a report comes in.
4. Basic ingest validation for `pools.txt`/`mempools.txt` (duplicate names with different URLs, malformed lines), same category of problem `pools-v2.json` ingestion already has to handle.
5. Whether `elektron-net-mempool` itself needs an entry in `mempools.txt` for anything code-driven, or whether that list is purely informational for pool operators to discover explorer instances manually.

## 5. Checklist

- [ ] `elektron-net-registry` repository created with `pools.txt` / `mempools.txt`
- [ ] Registry updater task implemented (mirrors `pools-updater.ts`)
- [ ] Report-receiving endpoint implemented
- [ ] Callback verification implemented
- [ ] Confirmed reports wired into `SelfReportedPoolsRepository` / ranking
- [ ] Open questions above resolved and reflected here before implementation begins
