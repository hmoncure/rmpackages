// Photo storage. STORAGE=s3 in production (private bucket, streamed through the
// app so every view is behind sign-in); STORAGE=disk for local testing.
const fs = require('fs');
const path = require('path');

const mode = process.env.STORAGE || 'disk';

let s3, S3;
if (mode === 's3') {
  S3 = require('@aws-sdk/client-s3');
  s3 = new S3.S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
}
const bucket = process.env.S3_BUCKET;
const diskRoot = process.env.PHOTO_DIR || path.join(__dirname, '..', 'data', 'photos');

async function put(key, buf, contentType) {
  if (mode === 's3') {
    await s3.send(new S3.PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: contentType }));
    return;
  }
  const file = path.join(diskRoot, key);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, buf);
}

// Returns { stream, contentType } or null.
async function get(key) {
  if (mode === 's3') {
    try {
      const r = await s3.send(new S3.GetObjectCommand({ Bucket: bucket, Key: key }));
      return { stream: r.Body, contentType: r.ContentType || 'image/jpeg' };
    } catch (e) {
      if (e.name === 'NoSuchKey') return null;
      throw e;
    }
  }
  const file = path.join(diskRoot, key);
  if (!file.startsWith(diskRoot) || !fs.existsSync(file)) return null;
  return { stream: fs.createReadStream(file), contentType: 'image/jpeg' };
}

module.exports = { put, get, mode };
