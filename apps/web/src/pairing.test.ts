import { describe, expect, it } from 'vitest';
import { claimPairing, pairingCodeFromLocation } from './pairing';

describe('pairingCodeFromLocation', () => {
  it('reads the code only from the pair route', () => {
    expect(pairingCodeFromLocation({ pathname: '/pair', search: '?code=ABCD2345' })).toBe(
      'ABCD2345',
    );
    expect(pairingCodeFromLocation({ pathname: '/pair/', search: '?code=abcd2345' })).toBe(
      'abcd2345',
    );
    expect(pairingCodeFromLocation({ pathname: '/', search: '?code=ABCD2345' })).toBeUndefined();
    expect(pairingCodeFromLocation({ pathname: '/pair', search: '' })).toBeUndefined();
  });
});

describe('claimPairing', () => {
  it('posts the code and device name with the cookie enabled', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    await claimPairing('ABCD2345', {
      deviceName: 'Phone',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('{}', { status: 201 });
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/pair/claim');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      code: 'ABCD2345',
      deviceName: 'Phone',
    });
  });

  it('surfaces the status when the code is refused', async () => {
    await expect(
      claimPairing('WRONG999', {
        fetchImpl: async () => new Response('invalid-code', { status: 401 }),
      }),
    ).rejects.toThrow('Pairing failed with HTTP 401: invalid-code');
  });
});
