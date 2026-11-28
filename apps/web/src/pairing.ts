/** The one-time link a desktop shows as a QR code or copies into a phone. */
export const PAIR_PATH = '/pair';
export const PAIR_CODE_PARAM = 'code';
export const PAIR_CLAIM_PATH = '/pair/claim';

export interface PairingLocation {
  pathname: string;
  search: string;
}

/** Reads the one-time code from `/pair?code=...`, and ignores every other route. */
export function pairingCodeFromLocation(location: PairingLocation): string | undefined {
  if (location.pathname !== PAIR_PATH && location.pathname !== `${PAIR_PATH}/`) return undefined;
  const code = new URLSearchParams(location.search).get(PAIR_CODE_PARAM)?.trim();
  return code === undefined || code.length === 0 ? undefined : code;
}

/** A short name the desktop session list can show, without any device fingerprint. */
export function defaultDeviceName(): string {
  const platform =
    typeof navigator === 'undefined' ? 'Browser' : navigator.platform || 'Browser';
  return `Phone browser (${platform})`.slice(0, 120);
}

export interface ClaimPairingOptions {
  fetchImpl?: typeof fetch;
  deviceName?: string;
}

/**
 * Exchanges the one-time code for the HttpOnly session cookie. The cookie is the
 * only credential the browser keeps; the file bearer token never reaches the page.
 */
export async function claimPairing(
  code: string,
  options: ClaimPairingOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('This browser cannot pair.');
  const response = await fetchImpl(PAIR_CLAIM_PATH, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code, deviceName: options.deviceName ?? defaultDeviceName() }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const suffix = detail.length > 0 ? `: ${detail.slice(0, 200)}` : '';
    throw new Error(`Pairing failed with HTTP ${response.status}${suffix}`);
  }
}
