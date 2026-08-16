#!/bin/sh
# Build the deployable CleverPay workers.
#
# Why this exists: a worker is uploaded through a pipe that caps the whole
# multipart body at 20,000 characters. The readable source passed that a while
# ago, so we ship minified artifacts and keep the source readable. Run this
# after every worker change and deploy the .build.js files, never the source.
#
# There are two workers since 4 Aug. cleverpay-api is the applicant-facing API
# and the front door; cleverpay-admin is the team back office, which it reaches
# over a private binding. They were one script until it reached 21,579
# characters and became undeployable — see the header of cleverpay-admin.js.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
ES="$DIR/../../node_modules/esbuild/bin/esbuild"
for NAME in cleverpay-api cleverpay-admin; do
  "$ES" "$DIR/$NAME.js" \
    --minify --bundle --format=esm --target=es2022 --platform=neutral --charset=utf8 \
    --outfile="$DIR/$NAME.build.js" --allow-overwrite >/dev/null
  SIZE=$(wc -c < "$DIR/$NAME.build.js")
  echo "$NAME: $SIZE chars (upload budget 20000, leave ~400 for the multipart wrapper)"
  # 16 Aug: measured, not guessed. The lean multipart envelope is 220 bytes,
  # so the artifact ceiling is 19,780. 19,500 was a guess that refused a
  # build which actually fitted, and the refusal is what left the live back
  # office ten days stale.
  [ "$SIZE" -le 19780 ] || { echo "TOO BIG by $((SIZE-19780)) — split $NAME before deploying"; exit 1; }
done
