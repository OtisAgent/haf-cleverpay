#!/bin/sh
# Build the deployable CleverPay worker.
#
# Why this exists: the worker is uploaded through a pipe that caps the whole
# multipart body at 20,000 characters. The readable source passed that a while
# ago, so we ship a minified artifact and keep the source readable. Run this
# after every worker change and deploy the .build.js, never the source.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
"$DIR/../../node_modules/esbuild/bin/esbuild" "$DIR/cleverpay-api.js" \
  --minify --format=esm --target=es2022 --platform=neutral \
  --outfile="$DIR/cleverpay-api.build.js" --allow-overwrite
SIZE=$(wc -c < "$DIR/cleverpay-api.build.js")
echo "built: $SIZE chars (upload budget 20000, leave ~400 for the multipart wrapper)"
[ "$SIZE" -lt 19500 ] || { echo "TOO BIG — split the worker before deploying"; exit 1; }
