#!/usr/bin/env bash
# Copies only the files the website needs into an output folder and adds
# ?v=<version> to every script, style and module import. GitHub Pages lets
# browsers cache files for 10 minutes; the version stops a phone from mixing
# old and new files right after a deploy.
#
# Usage: scripts/build-site.sh <out-dir> <version>
set -euo pipefail
OUT="${1:?out dir}"
VER="${2:?version}"

rm -rf "$OUT"
mkdir -p "$OUT/assets"
cp index.html setup.html config.js manifest.webmanifest .nojekyll "$OUT/"
cp assets/*.js assets/*.css assets/*.svg assets/*.png "$OUT/assets/"
cp -r assets/fonts "$OUT/assets/"

# HTML: <script src="assets/x.js"> and <link href="assets/style.css">
sed -i -E "s#(src|href)=\"(assets/[^\"?]+\.(js|css))\"#\1=\"\2?v=$VER\"#g" "$OUT"/*.html
# JS: import ... from "./x.js" / "../config.js"
sed -i -E "s#(from \"\.{1,2}/[^\"?]+\.js)\"#\1?v=$VER\"#g" "$OUT"/assets/*.js

echo "Built $OUT (version $VER):"
find "$OUT" -type f | sort
