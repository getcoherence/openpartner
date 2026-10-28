/**
 * An in-memory stand-in for the few knex calls the router makes, so router
 * tests don't touch Postgres: `pnpm test` runs packages in parallel, and the
 * API suite wipes and counts the same tables in the shared database.
 */

export type Row = Record<string, unknown>;

type Filter = (r: Row) => boolean;

/**
 * `db(table).where({...}).first(cols?)`, `db(table).insert(row)` and
 * `db(table).where({...}).where(col, '>', value).update(patch)`, which
 * returns the number of rows it changed.
 */
export function fakeDb(tables: Record<string, Row[]>) {
  return (name: string) => {
    const rows = (tables[name] ??= []);
    const filters: Filter[] = [];
    const matches = (r: Row) => filters.every((f) => f(r));
    const builder = {
      where(filter: Row | string, op?: string, value?: unknown) {
        if (typeof filter === 'string') {
          if (op !== '>') throw new Error(`fakeDb: unsupported operator ${op}`);
          filters.push((r) => (r[filter] as Date | number) > (value as Date | number));
        } else {
          filters.push((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
        }
        return builder;
      },
      async first(cols?: string[]) {
        const row = rows.find(matches);
        return row && cols ? Object.fromEntries(cols.map((c) => [c, row[c]])) : row;
      },
      async insert(row: Row) {
        rows.push(row);
      },
      async update(patch: Row) {
        const hit = rows.filter(matches);
        for (const r of hit) Object.assign(r, patch);
        return hit.length;
      },
    };
    return builder;
  };
}

// What @hono/node-server hands the app; resolveLink reads the socket IP.
export const NODE_BINDINGS = { incoming: { socket: { remoteAddress: '203.0.113.7' } } };
