// Office Packages — tracks every package addressed to 726 N Washington St,
// Alexandria VA 22314 from "expected" to "arrived (photo + location)" to
// "collected (who left with it)".
require('./lib/env');
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, migrate, tx } = require('./lib/db');
const storage = require('./lib/storage');
const mail = require('./lib/mail');

const PORT = Number(process.env.PORT || 3020);
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TZ = 'America/New_York';
const SESSION_DAYS = 60;
const COOKIE = 'pk_sess';

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

// ---------- helpers ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const clean = (v, max = 500) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T12:00:00Z'));
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

async function logEvent(c, packageId, actorId, action, detail, actorNote) {
  await c.query(
    'INSERT INTO package_event (package_id, actor_id, actor_note, action, detail) VALUES ($1,$2,$3,$4,$5)',
    [packageId, actorId || null, actorNote || null, action, detail ? JSON.stringify(detail) : null]
  );
}

// ---------- security middleware ----------
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});

// Browser writes must carry X-PK: 1 (a cross-site form cannot set it).
app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.path.startsWith('/import')) {
    if (req.get('X-PK') !== '1') return res.status(403).json({ error: 'Missing request header.' });
  }
  next();
});

async function loadSession(req, res, next) {
  try {
    const tok = parseCookies(req)[COOKIE];
    if (tok) {
      const r = await pool.query(
        `SELECT p.id, p.name, p.is_admin, p.can_collect, p.must_change_pin FROM session s JOIN person p ON p.id = s.person_id
          WHERE s.token_hash = $1 AND s.expires_at > now() AND p.active`, [sha256(tok)]);
      if (r.rows[0]) req.user = r.rows[0];
    }
    next();
  } catch (e) { next(e); }
}
app.use('/api', loadSession);

// Signed in, PIN may still be the starter one (only /me, /me/pin, /logout use this).
const requireSignedIn = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in.' }));
// Everything else: a starter PIN must be replaced before anything can be done.
const requireUser = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (req.user.must_change_pin) return res.status(403).json({ error: 'Choose your own PIN first.', must_change_pin: true });
  next();
};
const requireAdmin = (req, res, next) => requireUser(req, res, () =>
  (req.user.is_admin ? next() : res.status(403).json({ error: 'Admins only.' })));

// Reject PINs anyone would guess: one repeated digit, or a straight run (1234, 9876…).
function weakPin(pin) {
  if (/^(\d)\1+$/.test(pin)) return true;
  const d = pin.split('').map(Number);
  const up = d.every((x, i) => i === 0 || x === (d[i - 1] + 1) % 10);
  const down = d.every((x, i) => i === 0 || x === (d[i - 1] + 9) % 10);
  return up || down;
}

async function requireService(req, res, next) {
  try {
    const m = /^Bearer\s+(\S+)$/.exec(req.get('Authorization') || '');
    if (!m) return res.status(401).json({ error: 'Bearer token required.' });
    const r = await pool.query(
      'UPDATE service_token SET last_used = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, label', [sha256(m[1])]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid token.' });
    req.service = r.rows[0];
    next();
  } catch (e) { next(e); }
}

// ---------- auth ----------
app.get('/api/signin-names', wrap(async (req, res) => {
  const r = await pool.query('SELECT id, name FROM person WHERE active AND pin_hash IS NOT NULL ORDER BY name');
  res.json(r.rows);
}));

app.post('/api/login', express.json(), wrap(async (req, res) => {
  const id = Number(req.body.person_id);
  const pin = String(req.body.pin || '');
  if (!id || !/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'Choose your name and enter your PIN.');
  const r = await pool.query('SELECT id, pin_hash, locked_until FROM person WHERE id = $1 AND active', [id]);
  const p = r.rows[0];
  if (!p || !p.pin_hash) throw new HttpError(401, 'That PIN is not right.');
  if (p.locked_until && new Date(p.locked_until) > new Date()) {
    throw new HttpError(429, 'Too many wrong PINs. Try again in 15 minutes.');
  }
  if (!(await bcrypt.compare(pin, p.pin_hash))) {
    await pool.query(
      `UPDATE person SET failed_pins = failed_pins + 1,
         locked_until = CASE WHEN failed_pins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
       WHERE id = $1`, [id]);
    throw new HttpError(401, 'That PIN is not right.');
  }
  await pool.query('UPDATE person SET failed_pins = 0, locked_until = NULL WHERE id = $1', [id]);
  const tok = crypto.randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO session (token_hash, person_id, expires_at) VALUES ($1,$2, now() + interval '${SESSION_DAYS} days')`, [sha256(tok), id]);
  await pool.query('DELETE FROM session WHERE expires_at < now()');
  res.set('Set-Cookie', `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${APP_URL.startsWith('https') ? '; Secure' : ''}`);
  res.json({ ok: true });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const tok = parseCookies(req)[COOKIE];
  if (tok) await pool.query('DELETE FROM session WHERE token_hash = $1', [sha256(tok)]);
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}));

app.get('/api/me', requireSignedIn, (req, res) => res.json(req.user));

// Change my own PIN. Needs the current one, so a borrowed signed-in phone can't take over an account.
app.post('/api/me/pin', requireSignedIn, express.json(), wrap(async (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.pin || '');
  if (!/^\d{4,8}$/.test(next)) throw new HttpError(400, 'Your new PIN must be 4 to 8 digits.');
  if (weakPin(next)) throw new HttpError(400, 'That PIN is too easy to guess. Avoid repeated digits and runs like 1234.');
  const p = (await pool.query('SELECT pin_hash FROM person WHERE id = $1', [req.user.id])).rows[0];
  if (!p || !p.pin_hash || !(await bcrypt.compare(current, p.pin_hash))) throw new HttpError(400, 'Your current PIN is not right.');
  if (current === next) throw new HttpError(400, 'Choose a PIN different from the one you were given.');
  await pool.query('UPDATE person SET pin_hash = $2, must_change_pin = false, failed_pins = 0, locked_until = NULL WHERE id = $1',
    [req.user.id, await bcrypt.hash(next, 10)]);
  // Sign out every OTHER session of this person; keep this one.
  const tok = parseCookies(req)[COOKIE];
  await pool.query('DELETE FROM session WHERE person_id = $1 AND token_hash <> $2', [req.user.id, sha256(tok || '')]);
  res.json({ ok: true });
}));

app.get('/api/people', requireUser, wrap(async (req, res) => {
  const r = await pool.query('SELECT id, name, can_collect, is_admin FROM person WHERE active ORDER BY name');
  res.json(r.rows);
}));

// ---------- packages ----------
const LIST_SQL = `
  SELECT pk.*, r.name AS recipient_name, a.name AS arrived_by_name, c.name AS collected_by_name,
         rel.name AS released_by_name,
         (SELECT id FROM photo ph WHERE ph.package_id = pk.id AND ph.removed_at IS NULL
            ORDER BY (ph.kind IN ('arrival','moved')) DESC, ph.taken_at DESC LIMIT 1) AS photo_id,
         (pk.status = 'expected' AND pk.carrier_delivered_at IS NOT NULL) AS flag_carrier_delivered,
         (pk.status = 'expected' AND pk.expected_date IS NOT NULL AND pk.expected_date < $1::date - 1) AS flag_overdue,
         CASE WHEN pk.status = 'arrived' THEN floor(extract(epoch FROM now() - pk.arrived_at) / 86400)::int END AS days_waiting
    FROM package pk
    LEFT JOIN person r ON r.id = pk.recipient_id
    LEFT JOIN person a ON a.id = pk.arrived_by
    LEFT JOIN person c ON c.id = pk.collected_by
    LEFT JOIN person rel ON rel.id = pk.released_by`;

app.get('/api/packages', requireUser, wrap(async (req, res) => {
  const status = String(req.query.status || 'expected');
  const q = clean(req.query.q, 100);
  const params = [todayET()];
  const where = [];
  if (status !== 'all') {
    if (!['expected', 'arrived', 'collected', 'missing', 'cancelled'].includes(status)) throw new HttpError(400, 'Bad status.');
    params.push(status); where.push(`pk.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const n = params.length;
    where.push(`(lower(pk.description) LIKE $${n} OR lower(coalesce(pk.tracking,'')) LIKE $${n} OR lower(coalesce(pk.order_number,'')) LIKE $${n}
              OR lower(coalesce(pk.vendor,'')) LIKE $${n} OR lower(coalesce(pk.location,'')) LIKE $${n} OR lower(coalesce(r.name,'')) LIKE $${n})`);
  }
  const order = {
    expected: 'flag_carrier_delivered DESC, pk.expected_date ASC NULLS LAST, pk.id',
    arrived: 'pk.arrived_at ASC',
    collected: 'pk.collected_at DESC',
  }[status] || 'pk.updated_at DESC';
  const limit = ['collected', 'all', 'cancelled', 'missing'].includes(status) ? 'LIMIT 200' : '';
  const r = await pool.query(`${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} ${limit}`, params);
  res.json(r.rows);
}));

app.get('/api/counts', requireUser, wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT status, count(*)::int AS n,
            count(*) FILTER (WHERE status = 'expected' AND (carrier_delivered_at IS NOT NULL OR expected_date < $1::date - 1))::int AS attention
       FROM package GROUP BY status`, [todayET()]);
  const out = { expected: 0, arrived: 0, collected: 0, missing: 0, cancelled: 0, attention: 0 };
  r.rows.forEach((x) => { out[x.status] = x.n; out.attention += x.attention; });
  res.json(out);
}));

async function getPackage(id) {
  const r = await pool.query(`${LIST_SQL} WHERE pk.id = $2`, [todayET(), id]);
  return r.rows[0];
}

app.get('/api/packages/:id(\\d+)', requireUser, wrap(async (req, res) => {
  const p = await getPackage(Number(req.params.id));
  if (!p) throw new HttpError(404, 'No such package.');
  const photos = await pool.query(
    `SELECT ph.id, ph.kind, ph.taken_at, pe.name AS taken_by_name FROM photo ph LEFT JOIN person pe ON pe.id = ph.taken_by
      WHERE ph.package_id = $1 AND ph.removed_at IS NULL ORDER BY ph.taken_at`, [p.id]);
  const events = await pool.query(
    `SELECT e.action, e.detail, e.at, coalesce(pe.name, e.actor_note) AS actor FROM package_event e
       LEFT JOIN person pe ON pe.id = e.actor_id WHERE e.package_id = $1 ORDER BY e.at, e.id`, [p.id]);
  res.json({ ...p, photos: photos.rows, events: events.rows });
}));

const EDITABLE = ['description', 'vendor', 'carrier', 'tracking', 'order_number', 'expected_date', 'notes', 'recipient_id', 'location', 'label_name'];

function readFields(body, { requireDescription }) {
  const f = {};
  for (const k of EDITABLE) {
    if (!(k in body)) continue;
    if (k === 'expected_date') {
      const v = clean(body[k], 10);
      if (v && !isDate(v)) throw new HttpError(400, 'Expected date must be YYYY-MM-DD.');
      f[k] = v;
    } else if (k === 'recipient_id') {
      f[k] = body[k] ? Number(body[k]) : null;
    } else {
      f[k] = clean(body[k], k === 'notes' ? 2000 : 300);
    }
  }
  if (requireDescription && !f.description) throw new HttpError(400, 'Say what the package is.');
  if ('description' in f && !f.description) throw new HttpError(400, 'Description cannot be blank.');
  return f;
}

app.post('/api/packages', requireUser, express.json(), wrap(async (req, res) => {
  const f = readFields(req.body, { requireDescription: true });
  const walkIn = !!req.body.walk_in;
  const id = await tx(async (c) => {
    const cols = Object.keys(f);
    const vals = cols.map((k) => f[k]);
    cols.push('source', 'created_by'); vals.push(walkIn ? 'walk-in' : 'manual', req.user.id);
    const r = await c.query(
      `INSERT INTO package (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, vals);
    await logEvent(c, r.rows[0].id, req.user.id, walkIn ? 'walk-in created' : 'created', f);
    return r.rows[0].id;
  });
  res.status(201).json(await getPackage(id));
}));

app.patch('/api/packages/:id(\\d+)', requireUser, express.json(), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const f = readFields(req.body, { requireDescription: false });
  delete f.location; // location changes go through /move so they carry a photo + event
  if (!Object.keys(f).length) throw new HttpError(400, 'Nothing to change.');
  await tx(async (c) => {
    const cur = (await c.query('SELECT * FROM package WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'No such package.');
    if (cur.status === 'collected' && !req.user.is_admin) throw new HttpError(409, 'This package has already left the office.');
    const changed = {};
    for (const [k, v] of Object.entries(f)) if (String(cur[k] ?? '') !== String(v ?? '')) changed[k] = { from: cur[k], to: v };
    if (!Object.keys(changed).length) return;
    const keys = Object.keys(changed);
    await c.query(`UPDATE package SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [id, ...keys.map((k) => f[k])]);
    await logEvent(c, id, req.user.id, 'edited', changed);
  });
  res.json(await getPackage(id));
}));

// Photo upload: raw JPEG body (the browser shrinks it first).
app.post('/api/packages/:id(\\d+)/photo', requireUser,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'], limit: '12mb' }),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const kind = String(req.query.kind || 'arrival');
    if (!['arrival', 'label', 'moved', 'collected'].includes(kind)) throw new HttpError(400, 'Bad photo kind.');
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw new HttpError(400, 'No photo received.');
    const exists = await pool.query('SELECT 1 FROM package WHERE id = $1', [id]);
    if (!exists.rowCount) throw new HttpError(404, 'No such package.');
    const key = `packages/${id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
    await storage.put(key, req.body, req.get('Content-Type'));
    const r = await pool.query(
      'INSERT INTO photo (package_id, kind, storage_key, bytes, taken_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [id, kind, key, req.body.length, req.user.id]);
    res.status(201).json({ id: r.rows[0].id });
  }));

app.get('/api/photos/:id(\\d+)', requireUser, wrap(async (req, res) => {
  const r = await pool.query('SELECT storage_key FROM photo WHERE id = $1 AND removed_at IS NULL', [Number(req.params.id)]);
  if (!r.rows[0]) throw new HttpError(404, 'No such photo.');
  const obj = await storage.get(r.rows[0].storage_key);
  if (!obj) throw new HttpError(404, 'Photo file missing.');
  res.set('Content-Type', obj.contentType);
  res.set('Cache-Control', 'private, max-age=86400');
  obj.stream.pipe(res);
}));

async function photoBelongs(c, photoId, packageId) {
  if (!photoId) return false;
  const r = await c.query('SELECT 1 FROM photo WHERE id = $1 AND package_id = $2 AND removed_at IS NULL', [photoId, packageId]);
  return r.rowCount > 0;
}

app.post('/api/packages/:id(\\d+)/arrive', requireUser, express.json(), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const location = clean(req.body.location, 200);
  const photoId = Number(req.body.photo_id) || null;
  if (!location) throw new HttpError(400, 'Say where you put it.');
  await tx(async (c) => {
    const cur = (await c.query('SELECT status FROM package WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'No such package.');
    if (cur.status !== 'expected' && cur.status !== 'missing') throw new HttpError(409, `This package is already ${cur.status}.`);
    if (!(await photoBelongs(c, photoId, id))) throw new HttpError(400, 'Take a photo of where you put it.');
    await c.query(`UPDATE package SET status = 'arrived', arrived_at = now(), arrived_by = $2, location = $3, updated_at = now() WHERE id = $1`,
      [id, req.user.id, location]);
    await logEvent(c, id, req.user.id, 'arrived', { location, photo_id: photoId, was: cur.status });
  });
  const p = await getPackage(id);
  sendArrivalAlert(p).catch((e) => console.error('arrival alert', e));
  res.json(p);
}));

app.post('/api/packages/:id(\\d+)/move', requireUser, express.json(), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const location = clean(req.body.location, 200);
  const photoId = Number(req.body.photo_id) || null;
  if (!location) throw new HttpError(400, 'Say where it is now.');
  await tx(async (c) => {
    const cur = (await c.query('SELECT status, location FROM package WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'No such package.');
    if (cur.status !== 'arrived') throw new HttpError(409, 'Only a package in the office can be moved.');
    if (photoId && !(await photoBelongs(c, photoId, id))) throw new HttpError(400, 'Photo does not belong to this package.');
    await c.query('UPDATE package SET location = $2, updated_at = now() WHERE id = $1', [id, location]);
    await logEvent(c, id, req.user.id, 'moved', { from: cur.location, to: location, photo_id: photoId });
  });
  res.json(await getPackage(id));
}));

app.post('/api/packages/:id(\\d+)/collect', requireUser, express.json(), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const who = Number(req.body.collected_by);
  const note = clean(req.body.note, 500);
  await tx(async (c) => {
    const person = (await c.query('SELECT id, name FROM person WHERE id = $1 AND active AND can_collect', [who])).rows[0];
    if (!person) throw new HttpError(400, 'Choose who is leaving with it.');
    const cur = (await c.query('SELECT status FROM package WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'No such package.');
    if (cur.status !== 'arrived') throw new HttpError(409, cur.status === 'collected' ? 'This package has already left the office.' : 'Log it as arrived first.');
    await c.query(`UPDATE package SET status = 'collected', collected_at = now(), collected_by = $2, released_by = $3, updated_at = now() WHERE id = $1`,
      [id, who, req.user.id]);
    await logEvent(c, id, req.user.id, 'collected', { by: person.name, note });
  });
  res.json(await getPackage(id));
}));

// Mark missing / cancelled, or put a package back a step (admin) — always with a reason.
app.post('/api/packages/:id(\\d+)/status', requireUser, express.json(), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const to = String(req.body.status || '');
  const reason = clean(req.body.reason, 500);
  if (!reason) throw new HttpError(400, 'Give a reason.');
  await tx(async (c) => {
    const cur = (await c.query('SELECT status FROM package WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'No such package.');
    const allowed = {
      expected: ['missing', 'cancelled'],
      arrived: ['missing'],
      missing: ['expected'],
      cancelled: ['expected'],
    }[cur.status] || [];
    const adminUndo = req.user.is_admin && ((cur.status === 'collected' && to === 'arrived') || (cur.status === 'arrived' && to === 'expected'));
    if (!allowed.includes(to) && !adminUndo) throw new HttpError(409, `Cannot go from ${cur.status} to ${to}.`);
    const extra = {
      arrived: ', collected_at = NULL, collected_by = NULL, released_by = NULL',
      expected: cur.status === 'arrived' ? ', arrived_at = NULL, arrived_by = NULL, location = NULL' : '',
    }[to] || '';
    await c.query(`UPDATE package SET status = $2${extra}, updated_at = now() WHERE id = $1`, [id, to]);
    await logEvent(c, id, req.user.id, 'status', { from: cur.status, to, reason });
  });
  res.json(await getPackage(id));
}));

app.get('/api/locations', requireUser, wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT location, max(updated_at) AS last FROM package WHERE location IS NOT NULL GROUP BY location ORDER BY last DESC LIMIT 30`);
  res.json(r.rows.map((x) => x.location));
}));

// ---------- admin ----------
app.get('/api/admin/people', requireAdmin, wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT id, name, email, aliases, is_admin, can_collect, active, (pin_hash IS NOT NULL) AS has_pin FROM person ORDER BY active DESC, name`);
  res.json(r.rows);
}));

function readPerson(b) {
  const f = {};
  if ('name' in b) { f.name = clean(b.name, 60); if (!f.name) throw new HttpError(400, 'Name is required.'); }
  if ('email' in b) {
    f.email = clean(b.email, 200);
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw new HttpError(400, 'That email does not look right.');
  }
  if ('aliases' in b) f.aliases = String(b.aliases || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
  for (const k of ['is_admin', 'can_collect', 'active']) if (k in b) f[k] = !!b[k];
  return f;
}

// An admin-set PIN is a STARTER PIN: the person must replace it at next sign-in
// (unless the admin is setting their own).
async function setPin(c, id, pin, actorId) {
  if (pin === undefined || pin === null || pin === '') return;
  if (!/^\d{4,8}$/.test(String(pin))) throw new HttpError(400, 'PIN must be 4 to 8 digits.');
  await c.query('UPDATE person SET pin_hash = $2, must_change_pin = $3, failed_pins = 0, locked_until = NULL WHERE id = $1',
    [id, await bcrypt.hash(String(pin), 10), id !== actorId]);
  await c.query('DELETE FROM session WHERE person_id = $1', [id]);
}

app.post('/api/admin/people', requireAdmin, express.json(), wrap(async (req, res) => {
  const f = readPerson(req.body);
  if (!f.name) throw new HttpError(400, 'Name is required.');
  const id = await tx(async (c) => {
    const cols = Object.keys(f);
    const r = await c.query(`INSERT INTO person (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
      cols.map((k) => f[k])).catch((e) => { if (e.code === '23505') throw new HttpError(409, 'Someone already has that name.'); throw e; });
    await setPin(c, r.rows[0].id, req.body.pin, req.user.id);
    return r.rows[0].id;
  });
  res.status(201).json({ id });
}));

app.patch('/api/admin/people/:id(\\d+)', requireAdmin, express.json(), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const f = readPerson(req.body);
  if (id === req.user.id && (f.is_admin === false || f.active === false)) throw new HttpError(400, 'You cannot remove your own admin access.');
  await tx(async (c) => {
    const keys = Object.keys(f);
    if (keys.length) {
      await c.query(`UPDATE person SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => f[k])])
        .catch((e) => { if (e.code === '23505') throw new HttpError(409, 'Someone already has that name.'); throw e; });
    }
    if (req.body.clear_pin) {
      await c.query('UPDATE person SET pin_hash = NULL WHERE id = $1', [id]);
      await c.query('DELETE FROM session WHERE person_id = $1', [id]);
    }
    await setPin(c, id, req.body.pin, req.user.id);
    if (f.active === false) await c.query('DELETE FROM session WHERE person_id = $1', [id]);
  });
  res.json({ ok: true });
}));

app.get('/api/admin/tokens', requireAdmin, wrap(async (req, res) => {
  const r = await pool.query('SELECT id, label, created_at, last_used, revoked_at FROM service_token ORDER BY id DESC');
  res.json(r.rows);
}));
app.post('/api/admin/tokens', requireAdmin, express.json(), wrap(async (req, res) => {
  const label = clean(req.body.label, 80) || 'email scan';
  const tok = 'pkt_' + crypto.randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO service_token (label, token_hash) VALUES ($1,$2)', [label, sha256(tok)]);
  res.status(201).json({ token: tok, note: 'Shown once. Store it now.' });
}));
app.post('/api/admin/tokens/:id(\\d+)/revoke', requireAdmin, wrap(async (req, res) => {
  await pool.query('UPDATE service_token SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [Number(req.params.id)]);
  res.json({ ok: true });
}));
app.post('/api/admin/digest', requireAdmin, wrap(async (req, res) => {
  res.json(await sendDigest({ force: true }));
}));

// ---------- email-scan import (machine) ----------
// Each item: { source_ref (required, stable per shipment), vendor, carrier, tracking,
//   order_number, description, label_name, expected_date, carrier_status, delivered_at, email_link }
// Upserts by source_ref; falls back to attaching to an open MANUAL entry with the
// same tracking / order number so a hand-entered package is not duplicated.
// Never moves a package's office status: only the office can say it arrived.
const CARRIER_STATUSES = ['ordered', 'shipped', 'in_transit', 'delayed', 'out_for_delivery', 'delivered', 'exception', 'cancelled'];

async function matchRecipient(c, labelName) {
  if (!labelName) return null;
  const n = labelName.toLowerCase().trim();
  const first = n.split(/\s+/)[0];
  const r = await c.query(
    `SELECT id FROM person WHERE active AND (lower(name) = $1 OR lower(split_part(name,' ',1)) = $2
        OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = $1 OR lower(a) = $2))
      ORDER BY (lower(name) = $1) DESC LIMIT 2`, [n, first]);
  return r.rows.length === 1 ? r.rows[0].id : null;
}

app.post('/api/import', requireService, express.json({ limit: '1mb' }), wrap(async (req, res) => {
  const items = Array.isArray(req.body.packages) ? req.body.packages : null;
  if (!items) throw new HttpError(400, 'Body must be { packages: [...] }.');
  if (items.length > 200) throw new HttpError(400, 'At most 200 per call.');
  const results = [];
  for (const raw of items) {
    try {
      results.push(await importOne(raw, req.service));
    } catch (e) {
      results.push({ source_ref: raw && raw.source_ref, result: 'error', error: e.status ? e.message : 'server error' });
      if (!e.status) console.error('import', e);
    }
  }
  const summary = results.reduce((a, r) => { a[r.result] = (a[r.result] || 0) + 1; return a; }, {});
  res.json({ summary, results });
}));

async function importOne(raw, service) {
  const ref = clean(raw.source_ref, 200);
  if (!ref) throw new HttpError(400, 'source_ref is required.');
  const desc = clean(raw.description, 300);
  const expected = clean(raw.expected_date, 10);
  if (expected && !isDate(expected)) throw new HttpError(400, 'expected_date must be YYYY-MM-DD.');
  let cstat = clean(raw.carrier_status, 30);
  if (cstat) cstat = cstat.toLowerCase().replace(/[\s-]+/g, '_');
  if (cstat && !CARRIER_STATUSES.includes(cstat)) throw new HttpError(400, `carrier_status must be one of ${CARRIER_STATUSES.join(', ')}.`);
  let deliveredAt = null;
  if (cstat === 'delivered') {
    deliveredAt = raw.delivered_at && !isNaN(Date.parse(raw.delivered_at)) ? new Date(raw.delivered_at) : new Date();
  }
  const f = {
    vendor: clean(raw.vendor, 100), carrier: clean(raw.carrier, 60), tracking: clean(raw.tracking, 100),
    order_number: clean(raw.order_number, 100), label_name: clean(raw.label_name, 100), email_link: clean(raw.email_link, 1000),
  };
  const actor = `email scan (${service.label})`;

  return tx(async (c) => {
    let cur = (await c.query('SELECT * FROM package WHERE source_ref = $1 FOR UPDATE', [ref])).rows[0];
    let attached = false;
    if (!cur && (f.tracking || f.order_number)) {
      const m = await c.query(
        `SELECT * FROM package WHERE source_ref IS NULL AND status IN ('expected','arrived')
           AND ((tracking IS NOT NULL AND lower(tracking) = lower($1)) OR (tracking IS NULL AND order_number IS NOT NULL AND order_number = $2))
         ORDER BY id LIMIT 2 FOR UPDATE`, [f.tracking || '', f.order_number || '']);
      if (m.rows.length === 1) { cur = m.rows[0]; attached = true; }
    }

    if (!cur) {
      if (!desc) throw new HttpError(400, 'description is required for a new package.');
      if (cstat === 'cancelled') return { source_ref: ref, result: 'skipped', reason: 'cancelled before it was tracked' };
      const recipientId = await matchRecipient(c, f.label_name);
      const r = await c.query(
        `INSERT INTO package (description, vendor, carrier, tracking, order_number, label_name, email_link, expected_date,
            recipient_id, source, source_ref, carrier_status, carrier_delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'email',$10,$11,$12) RETURNING id`,
        [desc, f.vendor, f.carrier, f.tracking, f.order_number, f.label_name, f.email_link, expected, recipientId, ref, cstat, deliveredAt]);
      await logEvent(c, r.rows[0].id, null, 'imported', { ...f, description: desc, expected_date: expected, carrier_status: cstat }, actor);
      return { source_ref: ref, result: 'created', id: r.rows[0].id };
    }

    // Update: fill blanks, refresh the moving parts (date, carrier status). Office status untouched.
    const changed = {};
    const set = (k, v) => { if (v !== null && v !== undefined && String(cur[k] ?? '') !== String(v)) { changed[k] = { from: cur[k], to: v }; cur[k] = v; } };
    for (const k of ['vendor', 'carrier', 'tracking', 'order_number', 'label_name', 'email_link']) if (!cur[k]) set(k, f[k]);
    if (!cur.description) set('description', desc);
    if (expected && cur.status === 'expected') set('expected_date', expected);
    if (cstat && cstat !== cur.carrier_status) set('carrier_status', cstat);
    if (deliveredAt && !cur.carrier_delivered_at) set('carrier_delivered_at', deliveredAt.toISOString());
    if (attached) set('source_ref', ref);
    if (cstat === 'cancelled' && cur.status === 'expected') set('status', 'cancelled');
    if (!Object.keys(changed).length) return { source_ref: ref, result: 'unchanged', id: cur.id };
    const keys = Object.keys(changed);
    await c.query(`UPDATE package SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [cur.id, ...keys.map((k) => cur[k])]);
    await logEvent(c, cur.id, null, attached ? 'matched email' : 'email update', changed, actor);
    return { source_ref: ref, result: attached ? 'attached' : 'updated', id: cur.id };
  });
}

// Open packages, so the scan can see what it already knows about.
app.get('/api/import/open', requireService, wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT id, status, source_ref, description, vendor, tracking, order_number, expected_date, carrier_status
       FROM package WHERE status IN ('expected','arrived','missing') ORDER BY id`);
  res.json(r.rows);
}));

// ---------- alerts ----------
async function adminEmails() {
  const r = await pool.query('SELECT email FROM person WHERE active AND is_admin AND email IS NOT NULL');
  const extra = (process.env.DIGEST_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...r.rows.map((x) => x.email), ...extra])];
}

async function sendArrivalAlert(p) {
  let to = [];
  if (p.recipient_id) {
    const r = await pool.query('SELECT email FROM person WHERE id = $1 AND active AND email IS NOT NULL', [p.recipient_id]);
    if (r.rows[0]) to = [r.rows[0].email];
  }
  if (!to.length) to = await adminEmails();
  const text = [
    `A package arrived at the Alexandria office.`, ``,
    `What:     ${p.description}${p.vendor ? ` (${p.vendor})` : ''}`,
    `For:      ${p.recipient_name || p.label_name || 'not set'}`,
    `Where:    ${p.location}`,
    `Logged by ${p.arrived_by_name}`, ``,
    `Photo and details: ${APP_URL}/#/p/${p.id}`,
  ].join('\n');
  const r = await mail.send({ to, subject: `Package arrived: ${p.description}`.slice(0, 120), text });
  if (r.ok || r.logged) await pool.query('UPDATE package SET arrival_alert_sent_at = now() WHERE id = $1', [p.id]);
}

async function buildDigest() {
  const today = todayET();
  const q = (sql) => pool.query(sql, [today]).then((r) => r.rows);
  const carrierDelivered = await q(`${LIST_SQL} WHERE pk.status = 'expected' AND pk.carrier_delivered_at IS NOT NULL ORDER BY pk.carrier_delivered_at`);
  const overdue = await q(`${LIST_SQL} WHERE pk.status = 'expected' AND pk.carrier_delivered_at IS NULL AND pk.expected_date < $1::date - 1 ORDER BY pk.expected_date`);
  const waiting = await q(`${LIST_SQL} WHERE pk.status = 'arrived' AND pk.arrived_at < now() - interval '7 days' ORDER BY pk.arrived_at`);
  return { carrierDelivered, overdue, waiting };
}

function digestText(d) {
  const line = (p, extra) => `  • ${p.description}${p.vendor ? ` (${p.vendor})` : ''}${p.recipient_name ? ` for ${p.recipient_name}` : ''} — ${extra}\n    ${APP_URL}/#/p/${p.id}`;
  const fmt = (ts) => new Date(ts).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
  const parts = [];
  if (d.carrierDelivered.length) parts.push(`CARRIER SAYS DELIVERED, NOT LOGGED AT THE OFFICE (${d.carrierDelivered.length})\n` +
    d.carrierDelivered.map((p) => line(p, `delivered ${fmt(p.carrier_delivered_at)}${p.tracking ? `, tracking ${p.tracking}` : ''}`)).join('\n'));
  if (d.overdue.length) parts.push(`EXPECTED BUT NOT ARRIVED (${d.overdue.length})\n` +
    d.overdue.map((p) => line(p, `was due ${p.expected_date}`)).join('\n'));
  if (d.waiting.length) parts.push(`SITTING IN THE OFFICE 7+ DAYS (${d.waiting.length})\n` +
    d.waiting.map((p) => line(p, `${p.days_waiting} days, at ${p.location}`)).join('\n'));
  return parts.join('\n\n');
}

async function sendDigest({ force } = {}) {
  const d = await buildDigest();
  const n = d.carrierDelivered.length + d.overdue.length + d.waiting.length;
  if (!n && !force) return { sent: false, reason: 'nothing to report' };
  const body = n ? digestText(d) : 'Nothing needs attention.';
  const to = await adminEmails();
  const r = await mail.send({ to, subject: `Office packages: ${n} need${n === 1 ? 's' : ''} attention`, text: `${body}\n\nOpen the tracker: ${APP_URL}` });
  return { sent: !!(r.ok || r.logged), count: n, to, error: r.error };
}

// Weekday mornings 8:00 ET, once per day, from inside the app.
async function digestTick() {
  try {
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hour12: false })
      .formatToParts(now).map((p) => [p.type, p.value]));
    if (['Sat', 'Sun'].includes(parts.weekday) || Number(parts.hour) < 8) return;
    const today = todayET();
    const claim = await pool.query(
      `INSERT INTO app_setting (key, value) VALUES ('digest_last', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE app_setting.value IS DISTINCT FROM EXCLUDED.value
       RETURNING key`, [today]);
    if (!claim.rowCount) return; // already sent today
    const r = await sendDigest();
    console.log('[digest]', today, JSON.stringify(r));
  } catch (e) { console.error('[digest] failed', e); }
}

// ---------- static + errors ----------
app.get('/healthz', wrap(async (req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => { if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache'); },
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That photo is too large.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Try again.' });
});

if (require.main === module) {
  migrate().then(() => {
    app.listen(PORT, '127.0.0.1', () => console.log(`office-packages on 127.0.0.1:${PORT} (${storage.mode} photos)`));
    setInterval(digestTick, 10 * 60 * 1000);
    setTimeout(digestTick, 30 * 1000);
  }).catch((e) => { console.error('startup failed', e); process.exit(1); });
}

module.exports = { app, sendDigest, buildDigest };
