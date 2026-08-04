#!/bin/sh
# Turn the built preview site into the file list cfdeploy.py expects.
# Usage: sh worker/make-preview-spec.sh > worker/_preview-spec.json
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
SITE="$DIR/_preview-site"
printf '{"files":['
first=1
for f in "$SITE"/*; do
  name=$(basename "$f")
  case "$name" in
    *.html) ct="text/html" ;;
    *.css)  ct="text/css" ;;
    *.js)   ct="text/javascript" ;;
    *)      ct="application/octet-stream" ;;
  esac
  [ $first -eq 1 ] || printf ','
  first=0
  printf '{"path":"/%s","local":"%s","ctype":"%s"}' "$name" "$f" "$ct"
done
printf ']}'
