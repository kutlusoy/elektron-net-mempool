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

function isPrivateOrLoopbackIPv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a > 255 || b > 255 || Number(match[3]) > 255 || Number(match[4]) > 255) {
    return false; // not a valid IPv4 literal at all -- let URL parsing have already handled that
  }
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (carrier-grade NAT)
  return false;
}

function isPrivateOrLoopbackIPv6(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1') return true; // loopback
  if (h.startsWith('fe80:')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique local, fc00::/7
  return false;
}

/**
 * A purely structural check (no DNS lookup, no HTTP request -- the indexer
 * must never make outbound requests to an arbitrary, attacker-controlled
 * URL found in a coinbase). Rejects anything that could not possibly be
 * reachable/checkable by anyone other than the pool's own operator: no
 * URL, a non-http(s) scheme, localhost/loopback/link-local/private-range
 * hosts, or a bare hostname with no dot (never a real public domain). Does
 * NOT verify the pool actually controls the domain -- only that the URL is
 * not obviously local-only.
 */
export function isPubliclyVerifiableUrl(url: string | null | undefined): boolean {
  const trimmed = (url ?? '').trim();
  if (trimmed.length === 0) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0 || hostname === 'localhost' || hostname === '0.0.0.0' ||
    hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
    return false;
  }

  if (isPrivateOrLoopbackIPv4(hostname) || isPrivateOrLoopbackIPv6(hostname)) {
    return false;
  }

  if (!hostname.includes('.') && !hostname.includes(':')) {
    return false; // a bare hostname (e.g. "router", "mypool") is never a real public domain
  }

  return true;
}

class SelfReportedPoolsRepository {

  /**
   * Resolves (creating if necessary) a `pools` row for a self-reported,
   * unverified pool name that also declared a publicly verifiable URL --
   * callers MUST check isPubliclyVerifiableUrl() themselves first and route
   * anything else to the "Private Pools" bucket instead (PoolsRepository.
   * $getPrivatePool()); this method does not check it again.
   *
   * Scoped to `unique_id < -1` -- real registered pools always have a
   * positive unique_id (assigned by the pools-v2.json project), the
   * generic unknown pool uses 0, and -1 is permanently reserved for the
   * "Private Pools" bucket, so a self-declared name identical to a real
   * pool's name (or to "Private Pools" itself) can never resolve to that
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
      'SELECT id, unique_id AS uniqueId, name, link, slug FROM pools WHERE name = ? AND unique_id < -1 LIMIT 1',
      [name]
    );
    return rows.length > 0 ? (rows[0] as PoolTag) : null;
  }

  private async $createPool(name: string, url: string): Promise<PoolTag> {
    const baseSlug = slugifySelfReportedName(name);
    // Placeholder unique_id: any non-negative value works here, since it is
    // immediately overwritten below once the row's real id exists (a
    // duplicate placeholder briefly shared with other freshly-created rows
    // is harmless -- nothing looks it up by unique_id until after the fixup).
    const [insertResult]: any = await DB.query(
      'INSERT INTO pools(name, link, addresses, regexes, slug, unique_id) VALUES (?, ?, "[]", "[]", ?, 0)',
      [name, url, baseSlug]
    );
    const id = insertResult.insertId;

    // unique_id must end up unique per self-reported pool and <= -2 (see
    // class doc comment: -1 is reserved for "Private Pools"), which can
    // only be derived from the row's own auto increment id once it exists
    // -- hence the follow-up UPDATE rather than computing it up front. Also
    // disambiguate the slug here if another pool (self-reported or
    // registered) already has it: `slug` carries no unique constraint in
    // this schema, but the pool-detail page's routing assumes one in
    // practice.
    const slugTaken = await this.$isSlugTaken(baseSlug, id);
    const finalSlug = slugTaken ? `${baseSlug}${id}`.slice(0, MAX_SLUG_LENGTH) : baseSlug;
    const uniqueId = -(id + 1);

    await DB.query('UPDATE pools SET unique_id = ?, slug = ? WHERE id = ?', [uniqueId, finalSlug, id]);

    return { id, uniqueId, name, link: url, slug: finalSlug } as PoolTag;
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
   * Never touches a row with unique_id >= -1 (a registered pool, the
   * unknown pool, or the "Private Pools" bucket).
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
        WHERE pools.unique_id < -1
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
      await DB.query('DELETE FROM pools WHERE id = ? AND unique_id < -1', [poolId]);
    } catch (e) {
      logger.err(`Failed to prune self-reported pool ${poolId}: ` + (e instanceof Error ? e.message : e));
    }
  }
}

export default new SelfReportedPoolsRepository();
