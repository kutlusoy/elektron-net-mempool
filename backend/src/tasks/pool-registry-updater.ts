import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import config from '../config';
import logger from '../logger';
import { Common } from '../api/common';
import { parsePoolsRegistry, RegistryPoolEntry } from '../api/pool-registry-parser';

// Local, on-disk copy of the last successfully fetched pools.txt, next to
// the rest of this instance's cache. Read first on startup so this
// explorer has a usable list immediately even if the registry host is
// unreachable at boot, then kept in sync in the background -- see
// doc-elektron/guideline-pool-registry-reporting.md.
const LOCAL_REGISTRY_CACHE_FILENAME = 'pools-registry.txt';

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
    this.loadLocalCache();
    while ('Bitcoin is still alive') {
      try {
        await this.updateRegistry();
      } catch (e: any) {
        logger.info(`Exception ${e} in PoolRegistryUpdater::$startService. Code: ${e.code}. Message: ${e.message}`, this.tag);
      }
      await Common.sleep$(config.MEMPOOL.POOL_REGISTRY_UPDATE_DELAY * 1000);
    }
  }

  private get cachePath(): string {
    return path.join(config.MEMPOOL.CACHE_DIR, LOCAL_REGISTRY_CACHE_FILENAME);
  }

  private loadLocalCache(): void {
    try {
      const text = fs.readFileSync(this.cachePath, 'utf8');
      this.setPoolsFromText(text);
    } catch {
      // No local cache yet (first run) -- fine, updateRegistry() below will
      // populate it as soon as the registry is reachable.
    }
  }

  private saveLocalCache(text: string): void {
    try {
      fs.mkdirSync(config.MEMPOOL.CACHE_DIR, { recursive: true });
      fs.writeFileSync(this.cachePath, text);
    } catch (e) {
      logger.warn(`Failed to save local pool registry cache. Reason: ` + (e instanceof Error ? e.message : e), this.tag);
    }
  }

  private setPoolsFromText(text: string): void {
    const entries = parsePoolsRegistry(text);
    const next = new Map<string, RegistryPoolEntry>();
    for (const entry of entries) {
      next.set(entry.name, entry);
    }
    this.pools = next;
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
      // Never let a fetch that returns garbage (a GitHub outage page, a
      // redirect to an HTML error, etc.) wipe out an already-known good
      // list -- only replace it once the response actually parses into at
      // least one entry.
      const entries = parsePoolsRegistry(response.data);
      if (entries.length > 0) {
        this.setPoolsFromText(response.data);
        this.saveLocalCache(response.data);
      }
    } catch (e) {
      // Registry unreachable (e.g. GitHub is down) -- keep whatever is
      // already loaded (local cache or a previous successful fetch) rather
      // than going empty.
      logger.err(`Failed to fetch pool registry from ${base}/pools.txt. Reason: ` + (e instanceof Error ? e.message : e), this.tag);
    }
  }

  public getPoolByName(name: string): RegistryPoolEntry | undefined {
    return this.pools.get(name);
  }
}

export default new PoolRegistryUpdater();
