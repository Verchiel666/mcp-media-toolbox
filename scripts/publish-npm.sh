#!/system/bin/sh
# 发布到 npm：token 从文件读，写临时 .npmrc，发布完立即删除
set -e
TOKEN_FILE="${1:-/sdcard/Download/npm_token.txt}"
PKG_DIR="${2:-$(dirname $0)/..}"
NODE_BIN=/data/user/0/io.github.jackwener.dsh/files/bin/node
NPM="$NODE_BIN /data/user/0/io.github.jackwener.dsh/files/home/tools/npm/bin/npm-cli.js"

[ -f "$TOKEN_FILE" ] || { echo "找不到 token 文件: $TOKEN_FILE"; exit 2; }
TOKEN=$(tr -d ' \r\n' < "$TOKEN_FILE")
[ -n "$TOKEN" ] || { echo "token 文件是空的"; exit 2; }

NPMRC="$PKG_DIR/.npmrc.publish"
printf '//registry.npmjs.org/:_authToken=%s\nregistry=https://registry.npmjs.org/\n' "$TOKEN" > "$NPMRC"
chmod 600 "$NPMRC"
cd "$PKG_DIR"
echo "-- 身份校验 --"
$NPM whoami --userconfig "$NPMRC" 2>&1 | head -2
echo "-- 发布（dry-run 先看） --"
$NPM publish --userconfig "$NPMRC" --dry-run 2>&1 | tail -6
echo "-- 正式发布 --"
$NPM publish --userconfig "$NPMRC" 2>&1 | tail -8
rm -f "$NPMRC"
echo "-- 完成，临时 .npmrc 已删除 --"
