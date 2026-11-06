#!/usr/bin/env bash
# 手工打包 APK：aapt2 + javac + d8 + zipalign + apksigner（无需 Gradle）
#
# 依赖（都不在仓库里，需要自己准备）：
#   build/jdk/jdk-17*/             JDK 17
#   build/sdk/build-tools/34.0.0/  Android SDK build-tools
#   build/sdk/platforms/android-34/android.jar
#   build/dl/zxing-core.jar        ZXing core 3.5.x
#
# 签名：keystore 路径默认 build/jieshui.keystore，密码走环境变量
#   KS_PASS / KS_KEY_PASS（不设则现场生成一个仅供本地测试用的）
set -euo pipefail

# 用 Windows 风格的绝对路径（MSYS 的 pwd -W），否则 find 产出的 /d/... 路径
# 会被 Windows 版 javac 当成相对路径，报「找不到文件」
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && { pwd -W 2>/dev/null || pwd; })"
BUILD="$ROOT/build"
JDK="${JAVA_HOME:-$BUILD/jdk/jdk-17.0.21+9}"

SDK="$BUILD/sdk"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
SRC="$ROOT/android"
OUT="$ROOT/apk"
WORK="$BUILD/obj"
ZXING="$BUILD/dl/zxing-core.jar"
LAMBDA_STUBS="$BT/core-lambda-stubs.jar"

# bash 的 PATH 用 ':' 分隔，Windows 盘符不能直接进 PATH
export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$PATH"
JAVAC="$JDK/bin/javac.exe"
JAR="$JDK/bin/jar.exe"
KEYTOOL="$JDK/bin/keytool.exe"

rm -rf "$WORK"
mkdir -p "$WORK/res" "$WORK/gen" "$WORK/classes" "$WORK/dex" "$OUT"

echo "==> aapt2 compile"
"$BT/aapt2.exe" compile --dir "$SRC/res" -o "$WORK/res.zip"

echo "==> aapt2 link"
"$BT/aapt2.exe" link \
  -o "$WORK/base.apk" \
  -I "$PLATFORM" \
  --manifest "$SRC/AndroidManifest.xml" \
  --java "$WORK/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code 1 \
  --version-name 1.0.0 \
  "$WORK/res.zip"

echo "==> javac"
find "$SRC/src" -name '*.java' > "$WORK/sources.txt"
find "$WORK/gen" -name '*.java' >> "$WORK/sources.txt"
"$JAVAC" -source 8 -target 8 -encoding UTF-8 -nowarn \
  -bootclasspath "$PLATFORM" \
  -classpath "$PLATFORM;$ZXING;$LAMBDA_STUBS" \
  -d "$WORK/classes" \
  @"$WORK/sources.txt"

echo "==> d8"
find "$WORK/classes" -name '*.class' > "$WORK/classes.txt"
"$BT/d8.bat" --release --min-api 24 --lib "$PLATFORM" \
  --output "$WORK/dex" \
  @"$WORK/classes.txt" \
  "$ZXING"

echo "==> package"
cp "$WORK/base.apk" "$OUT/unsigned.apk"
python - "$WORK/dex/classes.dex" "$OUT/unsigned.apk" <<'PY'
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(dst, 'a', zipfile.ZIP_DEFLATED)
z.write(src, 'classes.dex')
z.close()
print('  classes.dex ->', dst)
PY

echo "==> zipalign"
"$BT/zipalign.exe" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "==> keystore"
KS="${KS_PATH:-$BUILD/jieshui.keystore}"
KS_PASS="${KS_PASS:-localdev}"
KS_KEY_PASS="${KS_KEY_PASS:-$KS_PASS}"
if [ ! -f "$KS" ]; then
  "$KEYTOOL" -genkeypair -keystore "$KS" -storepass "$KS_PASS" -keypass "$KS_KEY_PASS" \
    -alias jieshui -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=JieShui, OU=Personal, O=Personal, L=CN, ST=CN, C=CN"
fi

echo "==> apksigner"
"$BT/apksigner.bat" sign \
  --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_KEY_PASS" \
  --ks-key-alias jieshui \
  --min-sdk-version 24 --max-sdk-version 34 \
  --out "$OUT/jieshui.apk" "$OUT/aligned.apk"

"$BT/apksigner.bat" verify --print-certs "$OUT/jieshui.apk" | head -6
ls -l "$OUT/jieshui.apk"
echo "OK -> $OUT/jieshui.apk"
