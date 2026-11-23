#!/usr/bin/env bash
#
# Add the Office Packages site block to the shared Caddyfile — safely.
#
# This box serves eleven other hostnames for five other applications. A broken
# Caddyfile takes ALL of them down, so this script never writes to the live
# file until a candidate copy has passed validation.
#
#   backup -> build candidate -> validate candidate -> install -> reload -> verify
#
# Idempotent: refuses to add a second copy of the block.
#
set -euo pipefail

CADDYFILE="/etc/caddy/Caddyfile"
SNIPPET="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/Caddyfile.snippet"
BACKUP_DIR="/home/ubuntu/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${BACKUP_DIR}/Caddyfile.${STAMP}"
CANDIDATE="$(mktemp /tmp/Caddyfile.candidate.XXXXXX)"
trap 'rm -f "$CANDIDATE"' EXIT

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[31m    x %s\033[0m\n' "$*" >&2; exit 1; }

say "Preflight"
[ -f "$SNIPPET" ]   || die "snippet not found at $SNIPPET"
[ -f "$CADDYFILE" ] || die "$CADDYFILE not found"

if grep -q '^package.rossmoncure.com' "$CADDYFILE"; then
    die "package.rossmoncure.com is ALREADY in $CADDYFILE — nothing to do, refusing to duplicate"
fi

BEFORE_SITES="$(grep -cE '^[^[:space:]#].*\{[[:space:]]*$' "$CADDYFILE")"
echo "    ${BEFORE_SITES} site blocks currently defined"

say "Backing up the live file"
sudo mkdir -p "$BACKUP_DIR"
sudo cp -p "$CADDYFILE" "$BACKUP"
sudo test -s "$BACKUP" || die "backup is empty — stopping before any change"
echo "    $BACKUP  ($(sudo stat -c%s "$BACKUP") bytes)"

say "Building a candidate (the live file is still untouched)"
sudo cat "$CADDYFILE" > "$CANDIDATE"
printf '\n' >> "$CANDIDATE"
cat "$SNIPPET" >> "$CANDIDATE"

AFTER_SITES="$(grep -cE '^[^[:space:]#].*\{[[:space:]]*$' "$CANDIDATE")"
[ "$AFTER_SITES" -eq "$((BEFORE_SITES + 1))" ] \
    || die "expected exactly one new site block, got $((AFTER_SITES - BEFORE_SITES))"
echo "    ${BEFORE_SITES} -> ${AFTER_SITES} site blocks"

say "Validating the candidate"
sudo caddy validate --config "$CANDIDATE" --adapter caddyfile 2>&1 | tail -3
echo "    candidate is valid"

say "Installing and reloading"
sudo install -m 644 -o root -g root "$CANDIDATE" "$CADDYFILE"

if ! sudo systemctl reload caddy; then
    echo "    reload FAILED — restoring the backup"
    sudo cp -p "$BACKUP" "$CADDYFILE"
    sudo systemctl reload caddy || sudo systemctl restart caddy
    die "rolled back to $BACKUP"
fi

sleep 3
sudo systemctl is-active --quiet caddy || {
    echo "    caddy is not active — restoring the backup"
    sudo cp -p "$BACKUP" "$CADDYFILE"
    sudo systemctl restart caddy
    die "rolled back to $BACKUP"
}

say "Done"
echo "    caddy: $(systemctl is-active caddy)"
echo "    backup kept at $BACKUP"
echo "    to undo:  sudo cp -p $BACKUP $CADDYFILE && sudo systemctl reload caddy"
