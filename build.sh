#!/usr/bin/env bash
# ============================================================
# MarkPrompt 构建脚本
#
# 产物:
#   build/                 可直接在 chrome://extensions 加载的压缩版
#   markprompt-vX.Y.Z.zip  可直接上传 Chrome Web Store 的压缩包
#
# 说明:JS/CSS 使用 esbuild 压缩(去注释空白 + 变量名 mangle)。
# 注意:Chrome Web Store 禁止真正的"混淆"(字符串加密/控制流扁平化等),
# 只允许 minify,本脚本遵守该政策。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./manifest.json').version")
echo "==> 构建 MarkPrompt v${VERSION}"

rm -rf build
mkdir -p build/icons

echo "==> 压缩 JS / CSS"
npx -y esbuild background.js --minify --charset=utf8 --outfile=build/background.js
npx -y esbuild content.js    --minify --charset=utf8 --outfile=build/content.js
npx -y esbuild content.css   --minify --charset=utf8 --outfile=build/content.css

echo "==> 复制静态资源"
cp manifest.json build/
cp icons/icon16.png icons/icon48.png icons/icon128.png build/icons/

echo "==> 语法校验"
node --check build/background.js
node --check build/content.js

ZIP="markprompt-v${VERSION}.zip"
rm -f "${ZIP}"
(cd build && zip -qr "../${ZIP}" .)

echo "==> 完成"
echo "    目录: build/  (chrome://extensions 加载已解压的扩展)"
echo "    压缩包: ${ZIP}  (上传 Chrome Web Store)"
du -sh build "${ZIP}"
