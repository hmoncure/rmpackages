// Creates the office_packages database + login role using the master URL,
// without ever putting the plaintext password in SQL text (PG echoes statements
// in errors): the role gets a client-computed SCRAM verifier.
//   MASTER_URL=... node deploy/create-db.js   -> prints the app DATABASE_URL to stdout
const { Client } = require('pg');
const crypto = require('crypto');
const DB = 'office_packages', ROLE = 'office_packages_app';
function scram(pw) {
  const salt = crypto.randomBytes(16), it = 4096;
  const salted = crypto.pbkdf2Sync(pw, salt, it, 32, 'sha256');
  const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  const stored = crypto.createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  return `SCRAM-SHA-256$${it}:${salt.toString('base64')}$${stored.toString('base64')}:${hmac(salted, 'Server Key').toString('base64')}`;
}
(async () => {
  const master = new URL(process.env.MASTER_URL);
  master.searchParams.delete('sslmode');
  const c = new Client({ connectionString: master.toString(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const pw = crypto.randomBytes(24).toString('base64url');
  const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE])).rowCount;
  await c.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${ROLE} WITH LOGIN PASSWORD '${scram(pw)}'`);
  if (!(await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB])).rowCount) {
    await c.query(`GRANT ${ROLE} TO CURRENT_USER`).catch(() => {});
    await c.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  }
  await c.query(`REVOKE CONNECT ON DATABASE ${DB} FROM PUBLIC`);
  await c.query(`GRANT CONNECT ON DATABASE ${DB} TO ${ROLE}`);
  await c.end();
  const u = new URL(master.toString());
  u.username = ROLE; u.password = pw; u.pathname = '/' + DB;
  process.stdout.write(u.toString());
})().catch((e) => { console.error('create-db failed:', e.message); process.exit(1); });
