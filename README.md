# Office Packages — package.rossmoncure.com

Tracks every package addressed to **726 N Washington St, Alexandria VA 22314**:

1. **Expected** — added by hand (Add package) or by the Mon/Wed/Fri Claude email scan (`POST /api/import`).
2. **Arrived** — office staff tap the package, photograph where they put it, and name the spot. Photo is required. A package that shows up without being expected is logged with *Arrived but not on the list* (label photo + spot photo).
3. **Collected** — staff pick who left with it (anyone flagged *Can take packages*: Houston, Rachel, Kate, Debbie, Forrest). Who recorded the hand-out is kept too.

Every step is in the package's append-only history. Packages can be marked *missing* or *cancelled* with a reason; admins can undo a step.

**Alerts:** the recipient gets an email on arrival (admins if no recipient email). Weekdays 08:00 ET admins get a digest of: carrier says delivered but not logged (the loss signal), expected but overdue, and in the office 7+ days.

## Run
Node 20, Postgres, S3 (private bucket; photos are streamed through the app behind sign-in), SES via the box's `aws` CLI.

```
cp .env.example .env   # fill in
ADMIN_PIN=123456 ADMIN_EMAIL=you@example.com node scripts/migrate.js   # schema + seed on an empty DB
node server.js
```
Production: `/home/ubuntu/office-packages` on Lightsail-Apps, PM2 `office-packages`, port 3020, Caddy block in `deploy/Caddyfile.snippet` (added with `deploy/caddy-add.sh`). DB `office_packages`, role `office_packages_app` (created by `deploy/create-db.js`). Bucket `office-packages-photos-rossmoncure`.

Never `npm install` on the box — install elsewhere and ship `node_modules`.

## Email-scan API
`Authorization: Bearer <token>` (Admin → Email-scan tokens).
- `GET /api/import/open` — open packages.
- `POST /api/import` `{ "packages": [ { source_ref, vendor, carrier, tracking, order_number, description, label_name, expected_date, carrier_status, delivered_at, email_link } ] }` — upsert by `source_ref`; attaches to a hand-entered package with the same tracking/order number instead of duplicating; never changes the office status.

The scan instructions are in `deploy/email-scan-prompt.md`.
