#!/usr/bin/env bash
# Rebuild the Ali Binokor model and copy it into the web viewer.
#
#   tools/ab/py tools/ab/extract_plan.py   # (only when the plan PDFs change) -> blender/ab/plans.json
#   tools/ab/py tools/ab/site_map.py       # (only when the genplan changes)  -> build/site_raw.json
#   blender/export_ab.sh                   # -> public/models/ali_binokor.glb, src/model/complex.json, plans.json
set -euo pipefail
cd "$(dirname "$0")/.."
BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
export PATH="$HOME/.local/opt/node/bin:$PATH"
OUT=build/ab
mkdir -p build public/models src/model
PYTHONPATH=.pylib-blender "$BLENDER" -b --factory-startup --python-use-system-env -P blender/build_ab.py -- --out "$OUT" "$@"
GT=(npx --yes @gltf-transform/cli@4.1.1)
"${GT[@]}" dedup "$OUT.glb" "$OUT.dedup.glb"
"${GT[@]}" weld "$OUT.dedup.glb" "$OUT.weld.glb"
"${GT[@]}" meshopt "$OUT.weld.glb" public/models/ali_binokor.glb
rm -f "$OUT.dedup.glb" "$OUT.weld.glb"
cp "$OUT.json" src/model/complex.json
cp "$OUT.plans.json" src/model/plans.json
ls -la public/models/ali_binokor.glb src/model/complex.json src/model/plans.json
