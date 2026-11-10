// Keep the repository's prepared-statement interface while using a durable
// libSQL database. The caller creates the official @libsql/client/web client.
function jsonInteger(value) {
  if (typeof value !== 'bigint') return value;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value.toString();
}

function rowValues(result, row) {
  return result.columns.map((_, index) => jsonInteger(row[index]));
}

function resultRows(result) {
  // libSQL rows expose both numeric and named properties. Reading columns by
  // index avoids leaking those numeric properties into API JSON responses.
  return result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, jsonInteger(row[index])])));
}

function d1Result(result) {
  return {
    success: true,
    results: resultRows(result),
    meta: {
      changes: result.rowsAffected ?? 0,
      ...(result.lastInsertRowid === undefined ? {} : { last_row_id: jsonInteger(result.lastInsertRowid) }),
    },
  };
}

export function createLibsqlDatabase(client) {
  const statements = new WeakMap();

  function prepare(sql, args = []) {
    const input = { sql, args };
    const statement = {
      bind(...parameters) { return prepare(sql, parameters); },
      async first(column) {
        const rows = resultRows(await client.execute(input));
        if (!rows.length) return null;
        return column === undefined ? rows[0] : rows[0][column];
      },
      async all() { return d1Result(await client.execute(input)); },
      async run() { return d1Result(await client.execute(input)); },
      async raw() {
        const result = await client.execute(input);
        return result.rows.map(row => rowValues(result, row));
      },
    };
    statements.set(statement, input);
    return statement;
  }

  return {
    prepare,
    async batch(preparedStatements) {
      const inputs = preparedStatements.map(statement => {
        const input = statements.get(statement);
        if (!input) throw new TypeError('Batch statements must be prepared by this database.');
        return input;
      });
      if (!inputs.length) return [];
      // One SDK batch is one transaction, including SELECT results. Separate
      // execute() calls would break import revision checks and atomic writes.
      return (await client.batch(inputs, 'write')).map(d1Result);
    },
    async exec(sql) {
      await client.executeMultiple(sql);
      return { count: 1, duration: 0 };
    },
    close() { client.close(); },
  };
}
