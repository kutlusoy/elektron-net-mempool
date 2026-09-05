import { Common } from '../api/common';
import poolsRepository from '../repositories/PoolsRepository';
import selfReportedPoolsRepository from '../repositories/SelfReportedPoolsRepository';
import logger from '../logger';

// See doc-elektron/guideline-pool-identity-ranking.md. Runs occasionally,
// not per block: keeps the self-reported pools SelfReportedPoolsRepository
// creates bounded (best 1000 by block count, and evicts anything that has
// gone quiet for a long time), without adding load to the per-block
// indexing path.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

class SelfReportedPoolsPruner {
  tag = 'SelfReportedPoolsPruner';

  /** @asyncSafe */
  public async $startService(): Promise<void> {
    while ('Bitcoin is still alive') {
      try {
        await this.$runOnce();
      } catch (e) {
        logger.debug(`Exception in SelfReportedPoolsPruner::$startService. Reason: ` +
          (e instanceof Error ? e.message : e), this.tag);
      }
      await Common.sleep$(PRUNE_INTERVAL_MS);
    }
  }

  /** @asyncSafe */
  private async $runOnce(): Promise<void> {
    if (!Common.indexingEnabled()) {
      return;
    }
    const unknownPool = await poolsRepository.$getUnknownPool();
    if (!unknownPool) {
      return;
    }
    await selfReportedPoolsRepository.$pruneInactiveAndOverflow(unknownPool.id);
  }
}

export default new SelfReportedPoolsPruner();
