import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProcessGuards } from './process-guards.js';

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;
type ExceptionListener = (error: Error) => void;

const added: Array<{ event: 'unhandledRejection' | 'uncaughtException'; listener: unknown }> = [];

afterEach(() => {
  for (const entry of added.splice(0)) {
    if (entry.event === 'unhandledRejection') {
      process.removeListener('unhandledRejection', entry.listener as RejectionListener);
    } else {
      process.removeListener('uncaughtException', entry.listener as ExceptionListener);
    }
  }
  vi.restoreAllMocks();
});

describe('process guards', () => {
  it('logs a rejection outside a turn and keeps the process alive', () => {
    const lines: string[] = [];
    const before = new Set(process.listeners('unhandledRejection'));
    installProcessGuards({ write: (line) => lines.push(line) });
    const listener = process.listeners('unhandledRejection').find(
      (candidate) => !before.has(candidate),
    );
    expect(listener).toBeDefined();
    if (listener === undefined) return;
    added.push({ event: 'unhandledRejection', listener });
    (listener as RejectionListener)(new Error('boom'), Promise.resolve());
    expect(lines.join('')).toContain('unhandled rejection outside a turn: boom');
  });

  it('logs an uncaught exception and exits', () => {
    const lines: string[] = [];
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error('exit ' + String(code));
      }) as never);
    const before = new Set(process.listeners('uncaughtException'));
    installProcessGuards({ write: (line) => lines.push(line) });
    const listener = process.listeners('uncaughtException').find(
      (candidate) => !before.has(candidate),
    );
    expect(listener).toBeDefined();
    if (listener === undefined) return;
    added.push({ event: 'uncaughtException', listener });
    expect(() => (listener as ExceptionListener)(new Error('boom'))).toThrow('exit 1');
    expect(lines.join('')).toContain('uncaught exception: boom');
    expect(exit).toHaveBeenCalledWith(1);
  });

});
