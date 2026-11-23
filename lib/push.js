// Browser push (Web Push / VAPID). Works in Chrome/Edge on Windows & Android, and on
// iPhone once the site is added to the Home Screen. PUSH_MODE=log prints instead.
const webpush = require('web-push');
const { pool } = require('./db');

const enabled = !!(process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE);
if (enabled) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:noreply@bluefieldsvillas.com',
    process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
}
const sent = []; // test capture in log mode

async function sendToPeople(personIds, payload) {
  if (!personIds.length) return { sent: 0 };
  const subs = (await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE person_id = ANY($1)', [personIds])).rows;
  let ok = 0;
  for (const s of subs) {
    if (process.env.PUSH_MODE === 'log' || !enabled) {
      sent.push({ endpoint: s.endpoint, payload }); ok++; continue;
    }
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload), { TTL: 3 * 86400, urgency: 'normal' });
      await pool.query('UPDATE push_subscription SET last_ok = now(), failures = 0 WHERE id = $1', [s.id]);
      ok++;
    } catch (e) {
      // 404/410 = the browser dropped this subscription: forget it.
      if (e.statusCode === 404 || e.statusCode === 410) {
        await pool.query('DELETE FROM push_subscription WHERE id = $1', [s.id]);
      } else {
        await pool.query('UPDATE push_subscription SET failures = failures + 1 WHERE id = $1', [s.id]);
        console.error('[push] failed', e.statusCode, e.body || e.message);
      }
    }
  }
  return { sent: ok, devices: subs.length };
}

async function sendToAdmins(payload) {
  const ids = (await pool.query('SELECT id FROM person WHERE active AND is_admin')).rows.map((r) => r.id);
  return sendToPeople(ids, payload);
}

module.exports = { enabled, publicKey: process.env.VAPID_PUBLIC || null, sendToPeople, sendToAdmins, sent };
