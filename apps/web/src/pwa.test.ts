import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPwa } from './pwa';

interface BrowserStub {
  protocol?: string;
  isSecureContext?: boolean;
  register?: (url: string, init: { scope: string }) => Promise<ServiceWorkerRegistration>;
}

const REGISTRATION = { scope: '/', active: null } as unknown as ServiceWorkerRegistration;

/**
 * `registerPwa` reads `window.location`, `window.isSecureContext`, and
 * `navigator.serviceWorker`, so each case installs exactly the globals it describes and
 * `vi.unstubAllGlobals` removes them again.
 */
function stubBrowser(browser: BrowserStub): void {
  vi.stubGlobal('window', {
    location: { protocol: browser.protocol ?? 'https:' },
    ...(browser.isSecureContext === undefined ? {} : { isSecureContext: browser.isSecureContext }),
  });
  vi.stubGlobal(
    'navigator',
    browser.register === undefined ? {} : { serviceWorker: { register: browser.register } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerPwa', () => {
  it('returns null when the browser has no service workers', async () => {
    stubBrowser({ protocol: 'file:' });

    await expect(registerPwa()).resolves.toBeNull();
  });

  it('does not register from the file protocol the Electron renderer loads', async () => {
    const register = vi.fn(async () => REGISTRATION);
    stubBrowser({ protocol: 'file:', register });

    await expect(registerPwa({ force: true })).resolves.toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('does not register from an insecure http origin such as a LAN address', async () => {
    const register = vi.fn(async () => REGISTRATION);
    stubBrowser({ protocol: 'http:', isSecureContext: false, register });

    await expect(registerPwa({ force: true })).resolves.toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('registers the shell worker once on a secure origin', async () => {
    const register = vi.fn(async () => REGISTRATION);
    stubBrowser({ protocol: 'https:', isSecureContext: true, register });

    await expect(registerPwa({ force: true })).resolves.toBe(REGISTRATION);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('resolves null when the browser rejects the registration', async () => {
    const register = vi.fn(async () => {
      throw new Error('SecurityError: the operation is insecure');
    });
    stubBrowser({ protocol: 'http:', isSecureContext: true, register });

    await expect(registerPwa({ force: true })).resolves.toBeNull();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('leaves the Vite dev server alone unless forced', async () => {
    const register = vi.fn(async () => REGISTRATION);
    stubBrowser({ protocol: 'http:', isSecureContext: true, register });

    await expect(registerPwa()).resolves.toBeNull();
    expect(register).not.toHaveBeenCalled();

    await expect(registerPwa({ force: true })).resolves.toBe(REGISTRATION);
    expect(register).toHaveBeenCalledTimes(1);
  });
});
