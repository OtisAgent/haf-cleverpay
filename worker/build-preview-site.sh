#!/bin/sh
# Build a preview copy of the CleverPay portal that talks to a PREVIEW of the API
# instead of the live one.
#
# The only difference from what is in git is the one line in api.js that says
# which API to call. Everything else is copied byte for byte, so what Brent
# clicks is the real portal — not a mock-up of it, and not a second copy that
# can drift away from the thing we would actually put live.
#
# Usage: sh worker/build-preview-site.sh <preview-api-url>
set -e
API="$1"
[ -n "$API" ] || { echo "usage: build-preview-site.sh <preview-api-url>"; exit 1; }
DIR=$(cd "$(dirname "$0")/.." && pwd)
OUT="$DIR/worker/_preview-site"
rm -rf "$OUT"; mkdir -p "$OUT"

for f in index.html index.css index.js team.html team.css team.js team-add.js \
         team-edit.js team-config.js api.js docs.html docs.css status.html \
         status.css confirm.html; do
  cp "$DIR/$f" "$OUT/$f"
done

LIVE="https://cleverpay-api.orange-tree-fae7.workers.dev"
# The live address must not survive anywhere in the preview, or one page quietly
# writes to production while the rest are pointed at the preview.
sed -i "s|$LIVE|$API|g" "$OUT"/*.js "$OUT"/*.html
if grep -l "$LIVE" "$OUT"/* 2>/dev/null; then
  echo "REFUSING: the live API address is still present above"; exit 1
fi
echo "preview site built in $OUT, pointed at $API"
grep -h "const CP_API" "$OUT/api.js"
