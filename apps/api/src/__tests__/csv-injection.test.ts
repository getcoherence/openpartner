/**
 * CSV formula-injection guard. Excel, Google Sheets, and Numbers all
 * evaluate a cell that starts with =, +, -, @, tab, or CR as a formula
 * — which can run =HYPERLINK, =IMPORTXML, and other payloads that
 * silently exfiltrate data from the spreadsheet. Prefix with ' so the
 * cell renders as text.
 */

import { describe, expect, it } from 'vitest';
import { rowsToCsv } from '../export.js';

describe('CSV export formula injection', () => {
  it("prefixes cells starting with =, +, -, @ with '", () => {
    const csv = rowsToCsv([
      { a: '=1+1' },
      { a: '+HYPERLINK()' },
      { a: '-1' },
      { a: '@sum(a1:a9)' },
    ]);
    const lines = csv.split('\n');
    // Header + 4 rows = 5 lines
    expect(lines).toHaveLength(5);
    // Each guarded value gets a leading '; because it now contains a comma/equals
    // the quote-wrap kicks in too — check both shapes.
    expect(lines[1]).toMatch(/^"?'=1\+1"?$/);
    expect(lines[2]).toMatch(/^"?'\+HYPERLINK\(\)"?$/);
    expect(lines[3]).toMatch(/^"?'-1"?$/);
    expect(lines[4]).toMatch(/^"?'@sum\(a1:a9\)"?$/);
  });

  it("also guards tab / CR leading characters (hidden formula triggers)", () => {
    const csv = rowsToCsv([{ a: '\t=1+1' }, { a: '\r=2' }]);
    const lines = csv.split('\n').filter((l) => l.length > 0);
    // Quoted because of the embedded \t or \r
    expect(lines[1]).toContain("'");
    expect(lines[2]).toContain("'");
  });

  it('leaves normal strings untouched', () => {
    const csv = rowsToCsv([{ a: 'hello' }, { a: '123' }, { a: 'https://example.com' }]);
    const lines = csv.split('\n');
    expect(lines[1]).toBe('hello');
    expect(lines[2]).toBe('123');
    expect(lines[3]).toBe('https://example.com');
  });
});
