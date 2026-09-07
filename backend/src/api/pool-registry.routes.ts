import { Application, Request, Response } from 'express';
import axios from 'axios';
import config from '../config';
import logger from '../logger';
import { handleError } from '../utils/api';
import poolRegistryUpdater from '../tasks/pool-registry-updater';
import selfReportedPoolsRepository, { isPubliclyVerifiableUrl } from '../repositories/SelfReportedPoolsRepository';
import blocksRepository from '../repositories/BlocksRepository';

// See doc-elektron/guideline-pool-registry-reporting.md. Replaces the
// reverted on-chain pool-identity coinbase outputs: a pool that finds a
// block reports it here directly, and this handler verifies the claim by
// calling back to the pool's own registered URL before ever attributing
// anything, rather than trusting the report at face value.

const BLOCK_HASH_REGEX = /^[a-f0-9]{64}$/i;
const CALLBACK_TIMEOUT_MS = 5000;
// A pool's report is a near-instant HTTP round-trip, but this server still
// has to fetch and process that same block itself (several RPC calls plus
// a database write) before a row exists to attribute it to - the report
// can easily arrive first. Retried in the background, after responding to
// the pool, since waiting here would just make the pool's own 5-second
// report timeout fire instead. Bounded, not a persistent queue: if the
// block still is not indexed after this window, the report is dropped,
// same as any other unconfirmed report.
const ATTRIBUTION_RETRY_DELAY_MS = 3000;
const ATTRIBUTION_MAX_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface ConfirmResponse {
  confirmed?: boolean;
  name?: string | null;
  url?: string | null;
}

class PoolRegistryRoutes {
  public initRoutes(app: Application) {
    app.post(config.MEMPOOL.API_URL_PREFIX + 'pool-registry/report', this.$postReport.bind(this));
  }

  private $postReport = async (req: Request, res: Response): Promise<void> => {
    if (config.DATABASE.ENABLED !== true) {
      res.status(503).end();
      return;
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const blockHash = typeof req.body?.blockHash === 'string' ? req.body.blockHash.trim().toLowerCase() : '';

    if (name.length === 0 || !BLOCK_HASH_REGEX.test(blockHash)) {
      handleError(req, res, 400, 'Invalid pool-registry report');
      return;
    }

    const registryEntry = poolRegistryUpdater.getPoolByName(name);
    if (!registryEntry) {
      // Unknown pool name -- either not in the registry yet (poll interval
      // lag) or a bogus claim. Either way, nothing to verify against.
      res.status(404).end();
      return;
    }

    try {
      const confirmed = await this.$confirmWithPool(registryEntry.url, blockHash);
      if (!confirmed) {
        res.status(200).json({ attributed: false });
        return;
      }

      if (!isPubliclyVerifiableUrl(registryEntry.url)) {
        // Should not normally happen (the registry is public and PR-gated),
        // but the same safety rule as the old self-reported detector still
        // applies: never resolve a pool row for a URL that could not be
        // independently checked by anyone else.
        res.status(200).json({ attributed: false });
        return;
      }

      const pool = await selfReportedPoolsRepository.$getOrCreatePool(registryEntry.name, registryEntry.url);
      if (!pool) {
        res.status(200).json({ attributed: false });
        return;
      }

      const attributed = await blocksRepository.$updateBlockPool(blockHash, pool.id);
      res.status(200).json({ attributed });
      if (!attributed) {
        // Block not indexed yet - keep trying for a bit in the background,
        // now that the response has already gone out.
        void this.$retryAttribution(blockHash, pool.id);
      }
    } catch (e) {
      logger.err(`Failed to process pool-registry report for block ${blockHash} from "${name}". Reason: ` +
        (e instanceof Error ? e.message : e));
      res.status(500).end();
    }
  };

  /**
   * Keeps retrying a confirmed report's attribution after the HTTP response
   * has already been sent, for blocks this server has not indexed yet at
   * report time (see ATTRIBUTION_RETRY_DELAY_MS above). Never throws - it
   * has no caller left to report a failure to.
   * @asyncSafe
   */
  private async $retryAttribution(blockHash: string, poolId: number): Promise<void> {
    for (let attempt = 1; attempt <= ATTRIBUTION_MAX_ATTEMPTS; attempt++) {
      await sleep(ATTRIBUTION_RETRY_DELAY_MS);
      try {
        if (await blocksRepository.$updateBlockPool(blockHash, poolId)) {
          return;
        }
      } catch (e) {
        logger.err(`Failed to retry pool-registry attribution for block ${blockHash}. Reason: ` +
          (e instanceof Error ? e.message : e));
        return;
      }
    }
    logger.debug(`Gave up attributing block ${blockHash} to pool ${poolId} - still not indexed after ${ATTRIBUTION_MAX_ATTEMPTS} retries.`);
  }

  /** @asyncUnsafe -- callers must try/catch */
  private async $confirmWithPool(url: string, blockHash: string): Promise<boolean> {
    const base = url.replace(/\/$/, '');
    // The registered pool URL is the dashboard's public domain, not the API
    // itself - both elektron-net-pool and elektron-net-ppool serve their
    // NestJS routes under a global "api" prefix, and the reference stack's
    // reverse proxy only forwards /api/* to the backend (everything else
    // goes to the dashboard frontend), so this must include /api or every
    // callback 404s against the frontend instead of reaching the pool.
    const response = await axios.get<ConfirmResponse>(`${base}/api/pool/identity/confirm`, {
      params: { blockHash },
      timeout: CALLBACK_TIMEOUT_MS,
    });
    return response.data?.confirmed === true;
  }
}

export default new PoolRegistryRoutes();
