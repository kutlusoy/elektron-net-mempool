import DB from '../database';
import logger from '../logger';

/**
 * Elektron Net enforces mandatory pruning at this depth (~137 days at 60s
 * blocks) - block content older than this is deleted network-wide, and
 * -txindex can't be enabled on a pruned node (see elektron-net/src/init.cpp).
 * This index exists to stand in for -txindex within that same window: it
 * only remembers *where* a transaction is (its block height), not its
 * contents, and gets pruned to the same depth so it never becomes a
 * de-facto history node.
 */
export const MANDATORY_PRUNE_DEPTH = 197_280;

class TxIndexRepository {
  /**
   * Record which block each of these txids was confirmed in. Called once per
   * new block during the normal sync loop, so this never needs to backfill -
   * the index simply starts empty and grows forward from whenever it's
   * first deployed.
   * @asyncSafe
   */
  public async $indexBlockTransactions(txids: string[], height: number): Promise<void> {
    if (txids.length === 0) {
      return;
    }
    try {
      let query = 'INSERT IGNORE INTO tx_index (txid, height) VALUES ';
      query += txids.map(() => '(UNHEX(?), ?)').join(',') + ';';
      const params = txids.flatMap(txid => [txid, height]);
      await DB.query(query, params);
    } catch (e) {
      logger.err(`Cannot save tx index for block ${height}. Reason: ` + (e instanceof Error ? e.message : e));
    }
  }

  /**
   * @asyncSafe
   */
  public async $getBlockHeightForTx(txid: string): Promise<number | null> {
    try {
      const [rows]: any[] = await DB.query('SELECT height FROM tx_index WHERE txid = UNHEX(?)', [txid]);
      return rows.length ? rows[0].height : null;
    } catch (e) {
      logger.err(`Cannot read tx index for ${txid}. Reason: ` + (e instanceof Error ? e.message : e));
      return null;
    }
  }

  /**
   * Delete index entries for transactions the node itself has already (or
   * will have) pruned away - keeping anything older around would just be a
   * dangling pointer to unfetchable data, and grow the index unbounded.
   * @asyncSafe
   */
  public async $pruneOlderThan(tipHeight: number): Promise<void> {
    const minHeight = tipHeight - MANDATORY_PRUNE_DEPTH;
    if (minHeight <= 0) {
      return;
    }
    try {
      await DB.query('DELETE FROM tx_index WHERE height < ?', [minHeight]);
    } catch (e) {
      logger.err(`Cannot prune tx index below height ${minHeight}. Reason: ` + (e instanceof Error ? e.message : e));
    }
  }
}

export default new TxIndexRepository();
