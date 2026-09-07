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

      await blocksRepository.$updateBlockPool(blockHash, pool.id);
      res.status(200).json({ attributed: true });
    } catch (e) {
      logger.err(`Failed to process pool-registry report for block ${blockHash} from "${name}". Reason: ` +
        (e instanceof Error ? e.message : e));
      res.status(500).end();
    }
  };

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
