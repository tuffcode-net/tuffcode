import { describe, expect, it } from 'vitest';
import { parseSubagentFooter } from './footer';

describe('subagent footer parser', () => {
  it('reads a plain footer', () => {
    const footer = parseSubagentFooter(
      [
        'I changed the parser and ran the tests.',
        '',
        'STATUS: done',
        'SUMMARY: the parser now tolerates markdown',
        'FILES: src/a.ts:12, src/b.ts:40',
        'OPEN QUESTIONS: none',
      ].join('\n'),
    );
    expect(footer.status).toBe('done');
    expect(footer.summary).toBe('the parser now tolerates markdown');
    expect(footer.files).toEqual(['src/a.ts:12', 'src/b.ts:40']);
    expect(footer.openQuestions).toBe('none');
  });

  it('reads a footer a child wrote in markdown', () => {
    const footer = parseSubagentFooter(
      [
        '## Report',
        '**STATUS:** partial',
        '**SUMMARY:**',
        'two of the three callers are fixed;',
        'the third needs a migration',
        '- FILES:',
        '  - src/one.ts:3',
        '  - src/two.ts:9',
        '> OPEN QUESTIONS: should the migration be reversible?',
      ].join('\n'),
    );
    expect(footer.status).toBe('partial');
    expect(footer.summary).toBe('two of the three callers are fixed;\nthe third needs a migration');
    expect(footer.files).toEqual(['src/one.ts:3', 'src/two.ts:9']);
    expect(footer.openQuestions).toBe('should the migration be reversible?');
  });

  it('never rejects and leaves missing sections null', () => {
    const footer = parseSubagentFooter('Just an answer with no footer at all.');
    expect(footer).toEqual({ status: null, summary: null, files: [], openQuestions: null });
    expect(parseSubagentFooter('')).toEqual({
      status: null,
      summary: null,
      files: [],
      openQuestions: null,
    });
  });

  it('does not mistake the prompt template line for a declaration', () => {
    const footer = parseSubagentFooter(
      ['STATUS: done | partial | blocked', 'SUMMARY: 300 words at most'].join('\n'),
    );
    expect(footer.status).toBeNull();
  });

  it('keeps the first occurrence of a section and ignores an unknown status word', () => {
    const footer = parseSubagentFooter(
      [
        'STATUS: finished',
        'SUMMARY: first',
        'FILES: none',
        'SUMMARY: second',
        'OPEN QUESTIONS:',
      ].join('\n'),
    );
    expect(footer.status).toBeNull();
    expect(footer.summary).toBe('first');
    expect(footer.files).toEqual([]);
    expect(footer.openQuestions).toBeNull();
  });

  it('marks a blocked child as blocked and keeps its open questions', () => {
    const footer = parseSubagentFooter(
      [
        'I could not continue.',
        'STATUS: blocked',
        'SUMMARY: the provider rejected every request',
        'FILES: src/a.ts:1',
        'OPEN QUESTIONS: is the key rotated?',
      ].join('\n'),
    );
    expect(footer.status).toBe('blocked');
    expect(footer.openQuestions).toBe('is the key rotated?');
  });
});
