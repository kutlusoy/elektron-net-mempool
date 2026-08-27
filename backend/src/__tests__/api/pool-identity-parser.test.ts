import * as bitcoinjs from 'bitcoinjs-lib';
import { extractPoolIdentity, extractPoolIdentityField, POOL_IDENTITY_MAGIC_NAME, POOL_IDENTITY_MAGIC_URL } from '../../api/pool-identity-parser';
import { IEsploraApi } from '../../api/bitcoin/esplora-api.interface';

function opReturnVout(script: Buffer): IEsploraApi.Vout {
  return {
    scriptpubkey: script.toString('hex'),
    scriptpubkey_asm: '',
    scriptpubkey_type: 'op_return',
    value: 0,
  };
}

function payoutVout(): IEsploraApi.Vout {
  return {
    scriptpubkey: '0014' + '00'.repeat(20),
    scriptpubkey_asm: '',
    scriptpubkey_type: 'v0_p2wpkh',
    scriptpubkey_address: 'tb1qexampleexampleexampleexampleexamplex',
    value: 5000000000,
  };
}

function singlePushOpReturn(payload: Buffer): IEsploraApi.Vout {
  return opReturnVout(bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, payload]));
}

describe('pool-identity-parser', () => {
  it('returns null for both fields when there are no OP_RETURN outputs', () => {
    const vout = [payoutVout()];
    expect(extractPoolIdentity(vout)).toEqual({ name: null, url: null });
  });

  it('extracts the pool name when only the name magic is present', () => {
    const vout = [payoutVout(), singlePushOpReturn(Buffer.concat([POOL_IDENTITY_MAGIC_NAME, Buffer.from('MeinPool', 'utf8')]))];
    expect(extractPoolIdentity(vout)).toEqual({ name: 'MeinPool', url: null });
  });

  it('extracts both name and url when both magics are present', () => {
    const vout = [
      payoutVout(),
      singlePushOpReturn(Buffer.concat([POOL_IDENTITY_MAGIC_NAME, Buffer.from('MeinPool', 'utf8')])),
      singlePushOpReturn(Buffer.concat([POOL_IDENTITY_MAGIC_URL, Buffer.from('https://meinpool.example', 'utf8')])),
    ];
    expect(extractPoolIdentity(vout)).toEqual({ name: 'MeinPool', url: 'https://meinpool.example' });
  });

  it('finds the fields regardless of vout position (content-addressed, not position-addressed)', () => {
    const vout = [
      payoutVout(),
      singlePushOpReturn(Buffer.concat([POOL_IDENTITY_MAGIC_URL, Buffer.from('https://meinpool.example', 'utf8')])),
      singlePushOpReturn(Buffer.concat([POOL_IDENTITY_MAGIC_NAME, Buffer.from('MeinPool', 'utf8')])),
    ];
    expect(extractPoolIdentity(vout)).toEqual({ name: 'MeinPool', url: 'https://meinpool.example' });
  });

  it('ignores the real witness commitment (36-byte push starting with aa21a9ed)', () => {
    const witnessCommitMagic = Buffer.from('aa21a9ed', 'hex');
    const fakeMerkleRoot = Buffer.alloc(32, 0x11);
    const vout = [payoutVout(), singlePushOpReturn(Buffer.concat([witnessCommitMagic, fakeMerkleRoot]))];
    expect(extractPoolIdentity(vout)).toEqual({ name: null, url: null });
  });

  it('ignores a two-push output shaped like the UTXO attestation (<height><32 bytes>)', () => {
    // Two separate data pushes after OP_RETURN, mimicking the attestation
    // shape. Even if an adversary tried to smuggle EPNM-prefixed bytes into
    // the second push, this must never be read as pool identity, since a
    // pool identity output is single-push by construction.
    const heightPush = bitcoinjs.script.number.encode(900000);
    const fakeHash = Buffer.concat([POOL_IDENTITY_MAGIC_NAME, Buffer.alloc(28, 0x42)]); // 32 bytes total
    const script = bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, heightPush, fakeHash]);
    const vout = [payoutVout(), opReturnVout(script)];
    expect(extractPoolIdentity(vout)).toEqual({ name: null, url: null });
  });

  it('ignores a push shorter than the magic itself', () => {
    const vout = [payoutVout(), singlePushOpReturn(Buffer.from('EP', 'ascii'))];
    expect(extractPoolIdentityField(vout, POOL_IDENTITY_MAGIC_NAME)).toBeNull();
  });

  it('ignores a push that is exactly the magic with no payload', () => {
    const vout = [payoutVout(), singlePushOpReturn(POOL_IDENTITY_MAGIC_NAME)];
    expect(extractPoolIdentityField(vout, POOL_IDENTITY_MAGIC_NAME)).toBeNull();
  });

  it('does not throw on malformed scriptpubkey hex and treats it as no match', () => {
    const vout: IEsploraApi.Vout[] = [payoutVout(), { scriptpubkey: 'not-hex', scriptpubkey_asm: '', scriptpubkey_type: 'op_return', value: 0 }];
    expect(() => extractPoolIdentity(vout)).not.toThrow();
    expect(extractPoolIdentity(vout)).toEqual({ name: null, url: null });
  });

  it('decodes non-ASCII UTF-8 payloads correctly', () => {
    const vout = [singlePushOpReturn(Buffer.concat([POOL_IDENTITY_MAGIC_NAME, Buffer.from('Möönpool', 'utf8')]))];
    expect(extractPoolIdentityField(vout, POOL_IDENTITY_MAGIC_NAME)).toBe('Möönpool');
  });
});
