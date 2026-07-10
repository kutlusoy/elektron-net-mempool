# Elektron Net Mempool Explorer

Elektron Net's mempool visualizer, block explorer, and API service.

This fork derives from [mempool/mempool](https://github.com/mempool/mempool) (mempool.space), licensed under the GNU Affero General Public License v3.0 (see [LICENSE](./LICENSE)). "The Mempool Open Source Project", "mempool.space", and related names/logos are trademarks of Mempool Holdings S.A. de C.V. and are not used here; this fork does not claim any affiliation with mempool.space or Mempool Holdings.

Elektron-Net-specific changes in this fork:

- Mainnet bech32 address prefix `be1` (Elektron Net's own HRP) instead of Bitcoin's `bc1`. Legacy base58 address prefixes are unchanged from Bitcoin mainnet, since Elektron Net reuses them — this fork does not rely on the base58 prefix alone to distinguish networks.
- Difficulty adjustment and halving math updated for Elektron Net's 60-second block target (2016-block retarget window, 2,102,400-block halving interval, 5 ELEK genesis subsidy).
- Currency unit display renamed: BTC → ELEK, sats → lep, following Elektron Net's `CURRENCY_UNIT`/`CURRENCY_ATOM` naming.
- Fiat price feed and the paid Accelerator/Services integrations are disabled by default (no market data or commercial services exist for ELEK yet).
- `docker-compose.yml` at the repository root, wired for Elektron Net's node (Core-RPC-only mode for now) and matching the `elektron-net-stack` Docker network conventions. It also pre-wires (but does not yet enable) an Electrum backend for the future `elektron-net-electrs` service — see below.
- Elektron Net enforces mandatory pruning at 197,280 blocks (~137 days) on every node; there is no archival mode. Block-level data (heights, hashes, stats, charts) is cached permanently in this explorer's own database as each block arrives, so it stays available regardless of later pruning. Individual old-transaction lookups and address history depend on the connected node/backend still having that data, so they degrade once the underlying blocks are pruned — see the `elektron-net-electrs` note below.

### Electrum backend (planned)

Address lookups and pruning-independent historical transaction detail require an Electrum-protocol server. `elektron-net-electrs` (a separate, not-yet-built repo) is planned for this. `docker-compose.yml` already declares an `elektron-electrs` service behind the `electrs` Compose profile, and `elektron-mempool-api` already has `ELECTRUM_HOST`/`ELECTRUM_PORT` set to match it (inert while `MEMPOOL_BACKEND` is `"none"`). Once `elektron-net-electrs` exists and is cloned as a sibling directory, and has indexed the chain from genesis (indexing must start before blocks age past the prune horizon, otherwise that history is unrecoverable), activate it by setting `MEMPOOL_BACKEND` to `"electrum"` and running with `docker compose --profile electrs up`.

See [kutlusoy/elektron-net](https://github.com/kutlusoy/elektron-net) for the node software and its consensus parameters.

## Installation

- See the [`docker/`](./docker/) directory for the upstream Docker build instructions, and the root [`docker-compose.yml`](./docker-compose.yml) for an Elektron-Net-specific example deployment.
- See the [`backend/`](./backend/) and [`frontend/`](./frontend/) directories for manual install instructions oriented for developers.
- See the [`production/`](./production/) directory for guidance on setting up a production instance designed for high performance at scale.
