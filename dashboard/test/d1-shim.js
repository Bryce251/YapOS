import { DatabaseSync } from 'node:sqlite';

function normalize(value) {
  if (value === undefined) throw new TypeError('D1_TYPE_ERROR: Type undefined is not supported');
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`D1_TYPE_ERROR: Type ${typeof value} is not supported`);
}

const READ_RE = /^\s*(SELECT|WITH|PRAGMA)\b/i;

class D1PreparedStatement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...values) {
    return new D1PreparedStatement(this.database, this.sql, values.map(normalize));
  }

  execute() {
    const started = performance.now();
    const raw = this.database.raw;
    const stmt = raw.prepare(this.sql);
    let results = [];
    let changes = 0;
    let lastRowId = 0;
    if (stmt.columns().length > 0) {
      results = stmt.all(...this.params).map((r) => ({ ...r }));
      if (!READ_RE.test(this.sql)) {
        changes = Number(raw.prepare('SELECT changes() AS c').get().c);
        lastRowId = Number(raw.prepare('SELECT last_insert_rowid() AS r').get().r);
      }
    } else {
      const info = stmt.run(...this.params);
      changes = Number(info.changes);
      lastRowId = Number(info.lastInsertRowid);
    }
    this.database.queries.push(this.sql);
    return {
      success: true,
      results,
      meta: {
        duration: performance.now() - started,
        changes,
        last_row_id: lastRowId,
        changed_db: changes > 0,
        rows_read: results.length,
        rows_written: changes,
      },
    };
  }

  async first(column) {
    const { results } = this.execute();
    const row = results[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column];
  }

  async all() {
    return this.execute();
  }

  async run() {
    return this.execute();
  }

  async raw(options = {}) {
    const raw = this.database.raw;
    const stmt = raw.prepare(this.sql);
    const cols = stmt.columns().map((c) => c.name);
    const rows = stmt.all(...this.params).map((r) => cols.map((c) => r[c]));
    return options.columnNames ? [cols, ...rows] : rows;
  }
}

export class D1Database {
  constructor(filename = ':memory:') {
    this.raw = new DatabaseSync(filename);
    this.queries = [];
  }

  prepare(sql) {
    return new D1PreparedStatement(this, sql);
  }

  async batch(statements) {
    this.raw.exec('BEGIN');
    try {
      const out = statements.map((s) => s.execute());
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql) {
    this.raw.exec(sql);
    return { count: 1, duration: 0 };
  }

  close() {
    this.raw.close();
  }
}
