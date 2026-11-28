import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  estimateContext,
  harnessToolOutputs,
  resolveContextWindow,
} from './usage.js';

describe('estimateContext', () => {
  it('sums prompt sections, message rows, and harness tool output into segments', () => {
    const usage = estimateContext({
      sections: [
        { name: 'base', tokens: 100 },
        { name: 'user-message', tokens: 25 },
      ],
      messages: [{ content: 'abcd' }, { content: '12345678' }],
      harnessHistory: ['1234'],
      contextWindow: 1000,
    });

    expect(usage.segments).toEqual([
      { name: 'base', tokens: 100 },
      { name: 'user-message', tokens: 25 },
      { name: 'messages', tokens: 3 },
      { name: 'harness-history', tokens: 1 },
    ]);
    expect(usage.usedTokens).toBe(129);
    expect(usage.maxTokens).toBe(1000);
    expect(usage.percent).toBeCloseTo(0.129);
  });

  it('counts an image even when the message has no text', () => {
    const usage = estimateContext({
      sections: [],
      messages: [
        { content: '', attachments: [{ mimeType: 'image/png', width: 1024, height: 512 }] },
        { content: '', attachments: [{ mimeType: 'image/png' }] },
        { content: '', attachments: [{ mimeType: 'text/plain' }] },
      ],
    });

    // 1024x512 / 750 rounds up to 700; an image with no size falls back to 1100.
    expect(usage.segments.at(-1)).toEqual({ name: 'messages', tokens: 700 + 1100 });
  });

  it('keeps the messages segment when the thread has no history', () => {
    const usage = estimateContext({
      sections: [{ name: 'base', tokens: 40 }],
      messages: [],
    });

    expect(usage.segments).toEqual([
      { name: 'base', tokens: 40 },
      { name: 'messages', tokens: 0 },
    ]);
    expect(usage.maxTokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(usage.percent).toBeCloseTo(40 / DEFAULT_CONTEXT_WINDOW);
  });

  it('clamps percent to one when the estimate overshoots the window', () => {
    const usage = estimateContext({
      sections: [{ name: 'base', tokens: 500 }],
      messages: [{ content: 'x'.repeat(4000) }],
      contextWindow: 100,
    });

    expect(usage.usedTokens).toBe(1500);
    expect(usage.percent).toBe(1);
  });

  it('falls back to the default window for a missing or invalid window', () => {
    expect(resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow(null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow(0)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow(-5)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow(1.5)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow(128_000)).toBe(128_000);
  });
});

describe('harnessToolOutputs', () => {
  it('keeps tool output and ignores other event payloads', () => {
    const outputs = harnessToolOutputs([
      { type: 'tool.finished', payload: { output: 'wrote out.txt', isError: false } },
      { type: 'text.delta', payload: { text: 'assistant text' } },
      { type: 'tool.finished', payload: { output: '' } },
      { type: 'tool.finished', payload: null },
      { type: 'tool.finished', payload: { output: 42 } },
      { type: 'tool.finished', payload: { output: 'second' } },
    ]);

    expect(outputs).toEqual(['wrote out.txt', 'second']);
  });
});
