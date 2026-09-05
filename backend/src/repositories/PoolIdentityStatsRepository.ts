import DB from '../database';
import logger from '../logger';
import { PoolIdentityStat } from '../mempool.interfaces';

// See doc-elektron/guideline-pool-identity-ranking.md. Tracks self-reported
// (unverified) pool identities as new blocks are indexed, entirely separate
// from the registry-matched `pools` table -- never used to influence that
// table or the authoritative pool match.
const MAX_TRACKED_POOLS = 1000;
const MAX_NAME_LENGTH = 191; // InnoDB utf8mb4 PRIMARY KEY-safe length
const MAX_URL_LENGTH = 255;

export function normalizePoolIdentityName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

export function normalizePoolIdentityUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? '').trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, MAX_URL_LENGTH);
}

class PoolIdentityStatsRepository {
  /**
   * Upserts one block's self-reported pool identity into the ranking.
   * A block with no self-reported name (name/url both unset, or name blank)
   * is silently skipped -- there is nothing to group it under. Never
   * throws: a failure here must not be able to break block indexing, which
   * is why every call site wraps this in the same try/catch already used
   * for other best-effort per-block bookkeeping.
   * @asyncSafe
   */
  public async $trackBlock(name: string | null | undefined, url: string | null | undefined, height: number, timestamp: number): Promise<void> {
    const normalizedName = normalizePoolIdentityName(name);
    if (normalizedName === null) {
      return;
    }
    const normalizedUrl = normalizePoolIdentityUrl(url);

    try {
      await DB.query(`
        INSERT INTO pool_identity_stats(pool_identity_name, pool_identity_url, block_count, first_seen_height, last_seen_height, last_seen_time)
        VALUES (?, ?, 1, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          pool_identity_url = VALUES(pool_identity_url),
          block_count = block_count + 1,
          last_seen_height = VALUES(last_seen_height),
          last_seen_time = VALUES(last_seen_time)
      `, [normalizedName, normalizedUrl, height, height, timestamp]);

      await this.$pruneToTopPools();
    } catch (e) {
      logger.debug(`Failed to track pool identity for block ${height}: ` +
        (e instanceof Error ? e.message : e));
    }
  }

  /**
   * Keeps the table bounded to the MAX_TRACKED_POOLS best-performing names
   * (by block_count) so a flood of distinct self-declared names cannot grow
   * it without bound. The COUNT(*) gate means the DELETE only ever runs
   * once the table has actually grown past the cap, not on every block.
   * @asyncSafe
   */
  private async $pruneToTopPools(): Promise<void> {
    const [countRows]: any[] = await DB.query('SELECT COUNT(*) AS count FROM pool_identity_stats');
    if (countRows[0].count <= MAX_TRACKED_POOLS) {
      return;
    }

    await DB.query(`
      DELETE FROM pool_identity_stats
      WHERE pool_identity_name NOT IN (
        SELECT pool_identity_name FROM (
          SELECT pool_identity_name FROM pool_identity_stats
          ORDER BY block_count DESC, last_seen_height DESC
          LIMIT ?
        ) top_pools
      )
    `, [MAX_TRACKED_POOLS]);
  }

  /** @asyncSafe */
  public async $getRanking(limit: number = MAX_TRACKED_POOLS): Promise<PoolIdentityStat[]> {
    const cappedLimit = Math.min(Math.max(Math.trunc(limit) || MAX_TRACKED_POOLS, 1), MAX_TRACKED_POOLS);
    try {
      const [rows] = await DB.query(`
        SELECT
          pool_identity_name AS name,
          pool_identity_url AS url,
          block_count AS blockCount,
          first_seen_height AS firstSeenHeight,
          last_seen_height AS lastSeenHeight,
          last_seen_time AS lastSeenTime
        FROM pool_identity_stats
        ORDER BY block_count DESC, last_seen_height DESC
        LIMIT ?
      `, [cappedLimit]);
      return rows as PoolIdentityStat[];
    } catch (e) {
      logger.err('Failed to get pool identity ranking: ' + (e instanceof Error ? e.message : e));
      return [];
    }
  }
}

export default new PoolIdentityStatsRepository();
