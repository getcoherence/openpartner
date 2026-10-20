/**
 * An in-memory stand-in for the few knex calls the router makes, so router
 * tests don't touch Postgres: `pnpm test` runs packages in parallel, and the
 * API suite wipes and counts the same tables in the shared database.
 */

export type Row = Record<string, unknown>;

/** `db(table).where({...}).first(cols?)` and `db(table).insert(row)`. */
export function fakeDb(tables: Record<string, Row[]>) {
  return (name: string) => {
    const rows = (tables[name] ??= []);
    const filters: Row[] = [];
    const builder = {
      where(filter: Row) {
        filters.push(filter);
        return builder;
      },
      async first(cols?: string[]) {
        const row = rows.find((r) => filters.every((f) => Object.entries(f).every(([k, v]) => r[k] === v)));
        return row && cols ? Object.fromEntries(cols.map((c) => [c, row[c]])) : row;
      },
      async insert(row: Row) {
        rows.push(row);
      },
    };
    return builder;
  };
}

// What @hono/node-server hands the app; resolveLink reads the socket IP.
export const NODE_BINDINGS = { incoming: { socket: { remoteAddress: '203.0.113.7' } } };
