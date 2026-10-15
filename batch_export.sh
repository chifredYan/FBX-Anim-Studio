#!/usr/bin/env bash
# Batch-export every FBX in the Maria folder as a transparent 1024px PNG sequence.
# Settings match the confirmed Maria Run sample: zoom 0.60x, facing left, centering on.
# Usage: bash batch_export.sh [FBX_DIR]
#   FBX_DIR defaults to the Maria folder below; pass any folder of .fbx files.
shopt -s nocaseglob nullglob          # texture files differ in case from the FBX name

DIR="${1:-D:/Downloads/3D 动作人物模型/Maria}"
WEBAPP="$(cd "$(dirname "$0")" && pwd)"
cd "$WEBAPP" || exit 1

i=0
for f in "$DIR"/*.fbx; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .fbx)
  # (re-export everything, Maria Run included, so all clips share one framing)
  i=$((i + 1))

  outdir="$DIR/$name"
  base=$(echo "$name" | sed 's/[^A-Za-z0-9_-]\+/_/g')
  mkdir -p "$outdir"

  # NOTE: git-bash does not expand [...] globs on Windows-style paths -> list files explicitly
  tex=("$DIR/${name}_0".png "$DIR/${name}_1".png "$DIR/${name}_2".png)

  echo "=== [$i] $name  textures=${#tex[@]}"
  agent-browser open "http://127.0.0.1:8799/?v=b$i" >/dev/null 2>&1
  agent-browser upload "#file-fbx" "$f" >/dev/null 2>&1
  if [ ${#tex[@]} -gt 0 ]; then
    agent-browser upload "#file-tex" "${tex[@]}" >/dev/null 2>&1
  fi
  agent-browser wait 4000 >/dev/null 2>&1
  agent-browser eval "window.__t={dir:'$outdir',base:'$base'}" >/dev/null 2>&1
  agent-browser eval "$(cat ../export_via_receiver.js)" 2>&1
done
echo "=== BATCH DONE ==="
