import axios from 'axios';
import config from '../config';
import logger from '../logger';
import { Common } from '../api/common';
import { parsePoolsRegistry, RegistryPoolEntry } from '../api/pool-registry-parser';

/**
 * Maintains a local copy of the shared elektron-net-registry's pools.txt
 * (see doc-elektron/guideline-pool-registry-reporting.md), keyed by pool
 * name, so incoming block reports can be checked against a registered
 * pool's URL without hitting the registry on every request. Files are tiny
 * (a handful of KB even with hundreds of entries), so this simply refetches
 * on every poll rather than diffing like PoolsUpdater does for the much
 * larger pools-v2.json.
 */
class PoolRegistryUpdater {
  tag = 'PoolRegistryUpdater';

  private pools = new Map<string, RegistryPoolEntry>();

  /** @asyncSafe */
  public async $startService(): Promise<void> {
    while ('Bitcoin is still alive') {
      try {
        await this.updateRegistry();
      } catch (e: any) {
        logger.info(`Exception ${e} in PoolRegistryUpdater::$startService. Code: ${e.code}. Message: ${e.message}`, this.tag);
      }
      await Common.sleep$(config.MEMPOOL.POOL_REGISTRY_UPDATE_DELAY * 1000);
    }
  }

  /** @asyncSafe */
  public async updateRegistry(): Promise<void> {
    if (['mainnet', 'testnet', 'signet', 'testnet4', 'regtest'].includes(config.MEMPOOL.NETWORK) === false ||
      config.MEMPOOL.ENABLED === false
    ) {
      return;
    }

    const base = config.MEMPOOL.POOL_REGISTRY_URL?.replace(/\/$/, '');
    if (!base) {
      return;
    }

    try {
      const response = await axios.get<string>(`${base}/pools.txt`, {
        responseType: 'text',
        timeout: 10000,
        headers: { 'User-Agent': config.MEMPOOL.USER_AGENT },
      });
      const entries = parsePoolsRegistry(response.data);
      const next = new Map<string, RegistryPoolEntry>();
      for (const entry of entries) {
        next.set(entry.name, entry);
      }
      this.pools = next;
    } catch (e) {
      logger.err(`Failed to fetch pool registry from ${base}/pools.txt. Reason: ` + (e instanceof Error ? e.message : e), this.tag);
    }
  }

  public getPoolByName(name: string): RegistryPoolEntry | undefined {
    return this.pools.get(name);
  }
}

export default new PoolRegistryUpdater();
