/*
 * Regression test for the AES-CTR leftover-block path.
 *
 * CTR._update keeps a partial-block remainder (leftLength) between calls
 * and re-enters with a non-16-byte chunk. That path used to call
 * `Uint8Array.prototype.concat`, which does not exist — an upstream bug
 * that only fired when two chunked encrypt/decrypt calls landed on the
 * same CTR session (flaky in CI under parallel load; the call hung and
 * the test timed out).
 */
import {describe, it, expect} from 'vitest';
import CTR from '@lib/crypto/utils/aesCTR';
import subtle from '@lib/crypto/subtle';

describe('AES-CTR leftover-block path (WebK crypto regression)', () => {
  it('processes chunked updates with a partial final block', async() => {
    const key = await subtle.importKey('raw', new Uint8Array(32), {name: 'AES-CTR'}, false, ['encrypt']);
    const ctr = new CTR('encrypt', key, new Uint8Array(16));

    // 36 % 16 = 4 → first call leaves a 4-byte leftover, second call must
    // handle the leftover branch (previously threw + hung the promise).
    const a = new Uint8Array(36).fill(1);
    const b = new Uint8Array(37).fill(2);

    const r1 = await ctr.update(a);
    expect(r1.length).toBe(36);

    const r2 = await ctr.update(b);
    expect(r2.length).toBe(37);
  });
});
