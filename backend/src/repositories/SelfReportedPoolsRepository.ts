import DB from '../database';
import logger from '../logger';
import { PoolTag } from '../mempool.interfaces';

// See doc-elektron/guideline-pool-identity-ranking.md. Self-reported
// (unverified) pool identities are stored as ordinary rows in the existing
// `pools` table, and referenced by `blocks.pool_id` exactly like a
// registered pool, so the existing ranking, hashrate, and luck-stat queries
// pick them up with no separate infrastructure. Only ever consulted as a
// fallback once PoolsParser.matchBlockMiner() has already failed to find a
// registered match, so this can never override a verified one.
const MAX_NAME_LENGTH = 50; // pools.name varchar(50)
const MAX_SLUG_LENGTH = 50; // pools.slug char(50)
const MAX_URL_LENGTH = 255; // pools.link varchar(255)
const MAX_TRACKED_POOLS = 1000;
const INACTIVITY_THRESHOLD_SECONDS = 90 * 24 * 60 * 60; // 90 days

export function normalizeSelfReportedName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

export function normalizeSelfReportedUrl(url: string | null | undefined): string {
  return (url ?? '').trim().slice(0, MAX_URL_LENGTH);
}

export function slugifySelfReportedName(name: string): string {
  const slug = name.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, MAX_SLUG_LENGTH);
  return slug.length > 0 ? slug : 'pool';
}

class SelfReportedPoolsRepository {

  /**
   * Resolves (creating if necessary) a `pools` row for a self-reported,
   * unverified pool name. Scoped to `unique_id < 0` -- real registered
   * pools always have a positive unique_id (assigned by the pools-v2.json
   * project) and the generic unknown pool uses 0, so a self-declared name
   * identical to a real pool's name can never resolve to that real pool's
   * row here. Without this scoping, an attacker could self-declare e.g.
   * "Foundry USA" and have their blocks silently folded into the real
   * pool's hashrate/luck stats -- this way it instead gets its own,
   * separate (still unverified) row.
   * @asyncSafe
   */
  public async $getOrCreatePool(name: string | null | undefined, url: string | null | undefined): Promise<PoolTag | null> {
    const normalizedName = normalizeSelfReportedName(name);
    if (normalizedName === null) {
      return null;
    }
    const normalizedUrl = normalizeSelfReportedUrl(url);

    try {
      const existing = await this.$findSelfReportedPoolByName(normalizedName);
      if (existing) {
        return existing;
      }
      return await this.$createPool(normalizedName, normalizedUrl);
    } catch (e) {
      logger.debug(`Failed to resolve self-reported pool "${normalizedName}": ` +
        (e instanceof Error ? e.message : e));
      return null;
    }
  }

  private async $findSelfReportedPoolByName(name: string): Promise<PoolTag | null> {
    const [rows]: any[] = await DB.query(
      'SELECT id, unique_id AS uniqueId, name, link, slug FROM pools WHERE name = ? AND unique_id < 0 LIMIT 1',
      [name]
    );
    return rows.length > 0 ? (rows[0] as PoolTag) : null;
  }

  private async $createPool(name: string, url: string): Promise<PoolTag> {
    const baseSlug = slugifySelfReportedName(name);
    const [insertResult]: any = await DB.query(
      'INSERT INTO pools(name, link, addresses, regexes, slug, unique_id) VALUES (?, ?, "[]", "[]", ?, -1)',
      [name, url, baseSlug]
    );
    const id = insertResult.insertId;

    // unique_id must end up unique per self-reported pool (see class doc
    // comment), which can only be derived from the row's own auto
    // increment id once it exists -- hence the follow-up UPDATE rather than
    // computing it up front. Also disambiguate the slug here if another
    // pool (self-reported or registered) already has it: `slug` carries no
    // unique constraint in this schema, but the pool-detail page's routing
    // assumes one in practice.
    const slugTaken = await this.$isSlugTaken(baseSlug, id);
    const finalSlug = slugTaken ? `${baseSlug}${id}`.slice(0, MAX_SLUG_LENGTH) : baseSlug;

    await DB.query('UPDATE pools SET unique_id = ?, slug = ? WHERE id = ?', [-id, finalSlug, id]);

    return { id, uniqueId: -id, name, link: url, slug: finalSlug } as PoolTag;
  }

  private async $isSlugTaken(slug: string, excludingId: number): Promise<boolean> {
    const [rows]: any[] = await DB.query('SELECT 1 FROM pools WHERE slug = ? AND id != ? LIMIT 1', [slug, excludingId]);
    return rows.length > 0;
  }

  /**
   * Maintenance sweep, meant to run occasionally (see
   * self-reported-pools-pruner.ts), not per block: keeps the self-reported
   * pool set bounded to the MAX_TRACKED_POOLS best-performing names by
   * block count, and separately removes any self-reported pool that hasn't
   * found a block in INACTIVITY_THRESHOLD_SECONDS, regardless of rank.
   * Never touches a row with unique_id >= 0 (a registered or unknown pool).
   *
   * blocks.pool_id is a real foreign key into pools.id, and blocks are
   * never deleted (permanent chain history), so a pool being pruned has
   * its historical blocks reassigned back to the generic unknown pool
   * first -- this "forgets" the self-declared identity without erasing
   * the blocks themselves, the same way they would have looked before the
   * pool ever declared an identity.
   * @asyncSafe
   */
  public async $pruneInactiveAndOverflow(unknownPoolId: number): Promise<void> {
    try {
      const [rows]: any[] = await DB.query(`
        SELECT pools.id AS id, COUNT(blocks.height) AS blockCount, MAX(UNIX_TIMESTAMP(blocks.blockTimestamp)) AS lastSeen
        FROM pools
        LEFT JOIN blocks ON blocks.pool_id = pools.id AND blocks.stale = 0
        WHERE pools.unique_id < 0
        GROUP BY pools.id
      `);

      const nowSeconds = Math.floor(Date.now() / 1000);
      const overflowIds: number[] = [...rows]
        .sort((a: any, b: any) => b.blockCount - a.blockCount)
        .slice(MAX_TRACKED_POOLS)
        .map((row: any) => row.id);
      const inactiveIds: number[] = rows
        .filter((row: any) => row.lastSeen === null || (nowSeconds - row.lastSeen) > INACTIVITY_THRESHOLD_SECONDS)
        .map((row: any) => row.id);

      const toPrune = [...new Set([...overflowIds, ...inactiveIds])];
      for (const poolId of toPrune) {
        await this.$reassignAndDeletePool(poolId, unknownPoolId);
      }
    } catch (e) {
      logger.err('Failed to prune self-reported pools: ' + (e instanceof Error ? e.message : e));
    }
  }

  private async $reassignAndDeletePool(poolId: number, unknownPoolId: number): Promise<void> {
    try {
      await DB.query('UPDATE blocks SET pool_id = ? WHERE pool_id = ?', [unknownPoolId, poolId]);
      await DB.query('DELETE FROM pools WHERE id = ? AND unique_id < 0', [poolId]);
    } catch (e) {
      logger.err(`Failed to prune self-reported pool ${poolId}: ` + (e instanceof Error ? e.message : e));
    }
  }
}

export default new SelfReportedPoolsRepository();
