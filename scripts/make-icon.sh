#!/bin/zsh
# Renders scripts/icon.svg into an .icns file: make-icon.sh OUT.icns  (needs ImageMagick: brew install imagemagick)
set -eu
DIR="${0:A:h}"
OUT="$1"
TMP="$(mktemp -d)"
SET="$TMP/icon.iconset"
mkdir -p "$SET"
magick -background none -density 400 "$DIR/icon.svg" -resize 1024x1024 "$TMP/icon_1024.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon_1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$TMP/icon_1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$OUT"
rm -rf "$TMP"
