// Creates/updates the schema and, on an empty database, seeds the people.
//   ADMIN_PIN=123456 ADMIN_EMAIL=you@x.com node scripts/migrate.js
require('../lib/env');
const bcrypt = require('bcryptjs');
const { pool, migrate } = require('../lib/db');

(async () => {
  await migrate();
  const n = (await pool.query('SELECT count(*)::int AS n FROM person')).rows[0].n;
  if (n === 0) {
    const pin = process.env.ADMIN_PIN;
    if (!pin || !/^\d{4,8}$/.test(pin)) throw new Error('Empty database: set ADMIN_PIN (4-8 digits) to seed Houston.');
    await pool.query(
      `INSERT INTO person (name, email, pin_hash, is_admin, can_collect, aliases) VALUES ('Houston', $1, $2, true, true, $3)`,
      [process.env.ADMIN_EMAIL || null, await bcrypt.hash(pin, 10), ['Andrew', 'Andrew Moncure', 'Houston Moncure']]);
    for (const name of ['Rachel', 'Kate', 'Debbie', 'Forrest']) {
      await pool.query('INSERT INTO person (name, can_collect) VALUES ($1, true)', [name]);
    }
    console.log('Seeded Houston (admin) + Rachel, Kate, Debbie, Forrest.');
  } else {
    console.log(`Schema up to date; ${n} people already present, nothing seeded.`);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
