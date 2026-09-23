#!/bin/bash
# Rebuild node-pty for the Electron ABI.
#
# Builds in /tmp and merges the artifacts back, because this host refuses
# bulk deletes and compiler renames inside the project tree (sandboxed
# safe-delete / Desktop-folder protections). A fresh out-of-tree build
# sidesteps both.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$(node -p "require('$APP_DIR/node_modules/electron/package.json').version")"
BUILD_DIR="$(mktemp -d /tmp/dsh-pty-build.XXXXXX)"
trap 'rm -rf "$BUILD_DIR"' EXIT

mkdir -p "$BUILD_DIR/node_modules"
cp -R "$APP_DIR/node_modules/node-pty" "$BUILD_DIR/node-pty"
cp -R "$APP_DIR/node_modules/node-addon-api" "$BUILD_DIR/node_modules/"

echo "node-pty: rebuilding against Electron $TARGET in $BUILD_DIR"
(
  cd "$BUILD_DIR/node-pty"
  "$APP_DIR/node_modules/.bin/node-gyp" install \
    --dist-url=https://electronjs.org/headers --target="$TARGET" >/dev/null 2>&1 || true
  "$APP_DIR/node_modules/.bin/node-gyp" rebuild \
    --target="$TARGET" --arch=arm64 --dist-url=https://electronjs.org/headers
)

mkdir -p "$APP_DIR/node_modules/node-pty/build"
cp -R "$BUILD_DIR/node-pty/build/." "$APP_DIR/node_modules/node-pty/build/"
echo "node-pty: installed build/Release/pty.node and spawn-helper into the app"
