const { Pool, types } = require('pg');
const fs = require('fs');
const path = require('path');

// DATE columns come back as 'YYYY-MM-DD' strings. Parsing them into a JS Date
// shifts them a day early in UTC-5 (Alexandria), so never do that.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Lightsail managed PG: chain isn't in Node's store. Do NOT add sslmode to the URL.
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: 5,
});

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  // Additive columns (kept here so schema.sql stays the CREATE-only baseline).
  await pool.query(`ALTER TABLE person ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}'`);
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { pool, migrate, tx };
