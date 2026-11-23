// Email via SES using the box's own AWS CLI credentials (no SDK = no extra RAM).
// MAIL_MODE=log prints instead of sending (local testing).
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FROM = process.env.MAIL_FROM || 'Office Packages <noreply@bluefieldsvillas.com>';
const AWS = process.env.AWS_CLI || '/snap/bin/aws';
const sent = []; // for tests in log mode

function send({ to, subject, text, html }) {
  const list = [].concat(to).filter(Boolean);
  if (!list.length) return Promise.resolve({ skipped: 'no recipients' });
  if ((process.env.MAIL_MODE || 'log') === 'log') {
    sent.push({ to: list, subject, text });
    console.log(`[mail] to=${list.join(',')} subject=${subject}`);
    return Promise.resolve({ logged: true });
  }
  const content = { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } };
  if (html) content.Simple.Body.Html = { Data: html, Charset: 'UTF-8' };
  const file = path.join(os.tmpdir(), `pkgmail-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(content));
  return new Promise((resolve) => {
    execFile(AWS, ['sesv2', 'send-email', '--region', 'us-east-1',
      '--from-email-address', FROM,
      '--destination', JSON.stringify({ ToAddresses: list }),
      '--content', `file://${file}`], { timeout: 30000 }, (err, stdout, stderr) => {
      fs.unlink(file, () => {});
      if (err) { console.error('[mail] failed', subject, stderr || err.message); return resolve({ error: stderr || err.message }); }
      resolve({ ok: true, out: stdout });
    });
  });
}

module.exports = { send, sent };
