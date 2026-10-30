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
cp index.html setup.html about.html sw.js config.js manifest.webmanifest .nojekyll "$OUT/"
cp assets/*.js assets/*.css assets/*.svg assets/*.png "$OUT/assets/"
cp -r assets/fonts "$OUT/assets/"

# HTML: <script src="assets/x.js"> and <link href="assets/style.css">
sed -i -E "s#(src|href)=\"(assets/[^\"?]+\.(js|css))\"#\1=\"\2?v=$VER\"#g" "$OUT"/*.html
# JS: import ... from "./x.js" / "../config.js"
sed -i -E "s#(from \"\.{1,2}/[^\"?]+\.js)\"#\1?v=$VER\"#g" "$OUT"/assets/*.js

# Service worker: the version and the list of app files to keep for offline
# use, written exactly as the pages ask for them (scripts/styles with ?v=).
SHELL="\"./\", \"index.html\", \"about.html\", \"manifest.webmanifest\", \"config.js?v=$VER\""
for f in "$OUT"/assets/*.js "$OUT"/assets/*.css; do SHELL="$SHELL, \"assets/$(basename "$f")?v=$VER\""; done
for f in "$OUT"/assets/*.png "$OUT"/assets/*.svg "$OUT"/assets/fonts/*.woff2; do SHELL="$SHELL, \"${f#"$OUT"/}\""; done
sed -i "s#__VERSION__#$VER#; s#/\*__SHELL__\*/#$SHELL#" "$OUT/sw.js"

echo "Built $OUT (version $VER):"
find "$OUT" -type f | sort
