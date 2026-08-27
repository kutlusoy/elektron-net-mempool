import * as bitcoinjs from 'bitcoinjs-lib';
import { IEsploraApi } from './bitcoin/esplora-api.interface';

// Pool identity outputs (doc-elektron/guideline-pool-identity-detection.md,
// companion to elektron-net-ppool's doc-elektron/guideline-pool-identity-op-return.md):
// two informational, single-push OP_RETURN coinbase outputs a pool may add,
// each tagged with its own 4-byte magic so this parser can find them by
// content rather than by position, mirroring how the node itself locates the
// UTXO attestation and witness commitment. Self-declared and unverified --
// never treat these as equivalent to the registry-matched pool tag from
// pools-parser.ts.
export const POOL_IDENTITY_MAGIC_NAME = Buffer.from('EPNM', 'ascii'); // 0x45504e4d
export const POOL_IDENTITY_MAGIC_URL = Buffer.from('EPUR', 'ascii'); // 0x45505552

export interface PoolIdentity {
  name: string | null;
  url: string | null;
}

/**
 * Scans every vout for a single-push OP_RETURN output whose pushed bytes
 * start with `magic`, and returns the remaining bytes decoded as UTF-8.
 *
 * MUST reject anything but exactly one data push after OP_RETURN -- a
 * two-push output is structurally the UTXO attestation's shape
 * (<height><32 bytes>) and must never be considered here, matching the
 * safety argument in guideline-pool-identity-op-return.md Section 3/4.
 */
export function extractPoolIdentityField(vout: IEsploraApi.Vout[], magic: Buffer): string | null {
  for (const out of vout) {
    if (out.scriptpubkey_type !== 'op_return' || !out.scriptpubkey) {
      continue;
    }

    let script: Buffer;
    try {
      script = Buffer.from(out.scriptpubkey, 'hex');
    } catch {
      continue;
    }

    let ops: (number | Buffer)[] | null;
    try {
      ops = bitcoinjs.script.decompile(script);
    } catch {
      continue;
    }

    if (!Array.isArray(ops) || ops.length !== 2 || ops[0] !== bitcoinjs.opcodes.OP_RETURN || !Buffer.isBuffer(ops[1])) {
      continue;
    }

    const push = ops[1] as Buffer;
    if (push.length <= magic.length || !push.subarray(0, magic.length).equals(magic)) {
      continue;
    }

    const payload = push.subarray(magic.length);
    return new TextDecoder('utf-8', { fatal: false }).decode(payload);
  }
  return null;
}

export function extractPoolIdentity(vout: IEsploraApi.Vout[]): PoolIdentity {
  return {
    name: extractPoolIdentityField(vout, POOL_IDENTITY_MAGIC_NAME),
    url: extractPoolIdentityField(vout, POOL_IDENTITY_MAGIC_URL),
  };
}
