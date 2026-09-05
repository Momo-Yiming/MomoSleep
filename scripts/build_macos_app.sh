#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
OUTPUT_DIR="$PROJECT_ROOT/dist"
LEGACY_APP_PATH="$OUTPUT_DIR/智能闹钟验证版.app"
INSTALL_DIR="$HOME/Applications"
APP_PATH="$INSTALL_DIR/智能睡眠闹钟.app"
BUILD_DIR="$(mktemp -d /tmp/smart-sleep-alarm-build.XXXXXX)"
TEMP_APP="$BUILD_DIR/智能睡眠闹钟.app"
PROJECT_FILE="$PROJECT_ROOT/SmartSleepAlarm.xcodeproj/project.pbxproj"
APP_VERSION="$(awk '/MARKETING_VERSION =/{gsub(/;/, "", $3); print $3; exit}' "$PROJECT_FILE")"
BUILD_VERSION="$(awk '/CURRENT_PROJECT_VERSION =/{gsub(/;/, "", $3); print $3; exit}' "$PROJECT_FILE")"

trap 'rm -rf "$BUILD_DIR"' EXIT

case "$LEGACY_APP_PATH|$APP_PATH" in
    "$PROJECT_ROOT"/dist/*.app\|"$HOME"/Applications/*.app) ;;
    *) print -u2 "拒绝清理非预期输出路径"; exit 1 ;;
esac

mkdir -p "$OUTPUT_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$TEMP_APP/Contents/MacOS"
mkdir -p "$TEMP_APP/Contents/Resources"
cp "$PROJECT_ROOT/macOS/Info.plist" "$TEMP_APP/Contents/Info.plist"
cp "$PROJECT_ROOT/macOS/AppIcon.icns" "$TEMP_APP/Contents/Resources/AppIcon.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$TEMP_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_VERSION" "$TEMP_APP/Contents/Info.plist"

swiftc \
    -swift-version 5 \
    -D VALIDATION_APP \
    -O \
    -target "$(uname -m)-apple-macosx13.0" \
    -module-name SmartSleepAlarm \
    "$PROJECT_ROOT"/SmartSleepAlarm/*.swift \
    -o "$TEMP_APP/Contents/MacOS/SmartSleepAlarm"

xattr -cr "$TEMP_APP"
codesign --force --sign - "$TEMP_APP"

for running_executable in \
    "$LEGACY_APP_PATH/Contents/MacOS/SmartSleepAlarm" \
    "$APP_PATH/Contents/MacOS/SmartSleepAlarm"; do
    pgrep -f -x "$running_executable" 2>/dev/null | while IFS= read -r pid; do
        kill "$pid"
    done || true
done

rm -rf "$LEGACY_APP_PATH"
rm -rf "$APP_PATH"
mv "$TEMP_APP" "$APP_PATH"
xattr -cr "$APP_PATH"
codesign --force --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
ln -s "$APP_PATH" "$LEGACY_APP_PATH"
print "$APP_PATH"
