import { describe, it, expect } from 'vitest';
import { rowsToCsv } from '../export.js';

describe('rowsToCsv', () => {
  it('returns empty for no rows', () => {
    expect(rowsToCsv([])).toBe('');
  });

  it('writes header + rows', () => {
    const out = rowsToCsv([
      { id: '1', name: 'Ada' },
      { id: '2', name: 'Grace' },
    ]);
    expect(out).toBe('id,name\n1,Ada\n2,Grace');
  });

  it('escapes commas, quotes, and newlines', () => {
    const out = rowsToCsv([{ x: 'a,b', y: 'he said "hi"', z: 'line1\nline2' }]);
    expect(out).toBe('x,y,z\n"a,b","he said ""hi""","line1\nline2"');
  });

  it('flattens objects as json, dates as iso', () => {
    const out = rowsToCsv([{ meta: { k: 'v' }, when: new Date('2026-04-23T12:00:00Z') }]);
    expect(out).toContain('"{""k"":""v""}"');
    expect(out).toContain('2026-04-23T12:00:00.000Z');
  });

  it('renders null/undefined as empty', () => {
    const out = rowsToCsv([{ a: null, b: undefined, c: '' }]);
    expect(out).toBe('a,b,c\n,,');
  });
});
