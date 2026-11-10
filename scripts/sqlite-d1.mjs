import { DatabaseSync } from 'node:sqlite';

// A small local adapter for the same prepared-statement API used by D1.
// Production uses D1 directly; no local database files are deployed.
export function createDatabase(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  function prepare(sql, values = []) {
    const statement = sqlite.prepare(sql);
    return {
      bind(...parameters) { return prepare(sql, parameters); },
      async first(column) {
        const row = statement.get(...values);
        return row ? (column ? row[column] : { ...row }) : null;
      },
      async all() { return { success: true, results: statement.all(...values).map(row => ({ ...row })) }; },
      async raw() { return statement.all(...values).map(row => Object.values(row)); },
      async run() {
        if (statement.columns().length) {
          return { success: true, results: statement.all(...values).map(row => ({ ...row })), meta: { changes: 0 } };
        }
        const result = statement.run(...values);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      }
    };
  }
  return {
    prepare,
    async exec(sql) { sqlite.exec(sql); return { count: 1, duration: 0 }; },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    close() { sqlite.close(); }
  };
}
