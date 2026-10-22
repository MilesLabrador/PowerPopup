#!/usr/bin/env bash
# Packages PowerPopup for the Chrome Web Store (.zip) and Firefox AMO (.xpi).
#
# Usage:
#   ./build.sh            # builds both
#   ./build.sh chrome      # builds dist/PowerPopup-chrome.zip only
#   ./build.sh firefox     # builds dist/PowerPopup-firefox.xpi only
#
# Each target gets its own staging directory so the right manifest
# (manifest.chrome.json uses a service worker + optional_host_permissions;
# manifest.firefox.json uses browser_specific_settings.gecko + a background
# script array) ends up renamed to manifest.json at the archive root, and
# COPYFILE_DISABLE avoids macOS's AppleDouble (__MACOSX/, ._*) files leaking
# into the package — that's what tripped the AMO validator last time.

set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Usage: ./build.sh [chrome|firefox|all] [-h|--help]

  (no arg)  builds both dist/PowerPopup-chrome.zip and dist/PowerPopup-firefox.xpi
  chrome    builds dist/PowerPopup-chrome.zip only
  firefox   builds dist/PowerPopup-firefox.xpi only
  -h, --help  show this help message
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

TARGET="${1:-all}"
DIST="dist"
SOURCES=(background.js content icons lib options popup)

rm -rf "$DIST"
mkdir -p "$DIST"

# Zips the current directory to $1. Git Bash on Windows ships no `zip`, so
# fall back to Python's zipfile — it writes the same forward-slash entry names
# the browsers require, and skipping dotfiles keeps the archive as clean as
# the `zip -x ".*"` path does.
make_archive() {
  local out="$1"

  if command -v zip >/dev/null 2>&1; then
    COPYFILE_DISABLE=1 zip -r -X "$out" . -x ".*"
    return
  fi

  local py
  py="$(command -v python3 || command -v python)" || {
    echo "Packaging needs either 'zip' or Python on PATH." >&2
    exit 1
  }
  # Native Windows Python can't read /c/... paths that Git Bash hands out.
  command -v cygpath >/dev/null 2>&1 && out="$(cygpath -w "$out")"

  "$py" - "$out" <<'PY'
import os, sys, zipfile

with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk("."):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(files):
            if name.startswith("."):
                continue
            path = os.path.join(root, name)
            z.write(path, os.path.relpath(path, ".").replace(os.sep, "/"))
PY
}

build_target() {
  local name="$1" manifest="$2" outfile="$3"
  local stage
  stage="$(mktemp -d)"

  cp -r "${SOURCES[@]}" "$stage/"
  cp "$manifest" "$stage/manifest.json"

  rm -f "$DIST/$outfile"
  (
    cd "$stage"
    make_archive "$OLDPWD/$DIST/$outfile"
  )
  rm -rf "$stage"
  echo "Built $DIST/$outfile"
}

case "$TARGET" in
  chrome)
    build_target chrome manifest.chrome.json PowerPopup-chrome.zip
    ;;
  firefox)
    build_target firefox manifest.firefox.json PowerPopup-firefox.xpi
    ;;
  all)
    build_target chrome manifest.chrome.json PowerPopup-chrome.zip
    build_target firefox manifest.firefox.json PowerPopup-firefox.xpi
    ;;
  *)
    echo "Unknown target: $TARGET (expected chrome, firefox, or all)" >&2
    exit 1
    ;;
esac
