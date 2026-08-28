#!/bin/sh
# Build HumanwareOS.app (a menu bar accessory bundle) from the SPM executable.
# Output: apps/menubar/HumanwareOS/HumanwareOS.app
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${1:-release}"

swift build -c "$CONFIG" --package-path "$HERE"
BIN="$(swift build -c "$CONFIG" --package-path "$HERE" --show-bin-path)/HumanwareOS"

APP="$HERE/HumanwareOS.app"
ENTITLEMENTS="$HERE/HumanwareOS.entitlements"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$BIN" "$APP/Contents/MacOS/HumanwareOS"
cp -R "$HERE/.build/$CONFIG/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
# SwiftPM's artifact cache may carry owner-only executable modes. Normalize
# readable/executable bits before signing so Sparkle can validate archives and
# generate compact delta updates between releases.
chmod -R a+rX "$APP/Contents/Frameworks/Sparkle.framework"
install_name_tool -add_rpath @executable_path/../Frameworks "$APP/Contents/MacOS/HumanwareOS"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
[ -f "$HERE/AppIcon.icns" ] && cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# The mini runs with a restrictive umask. Normalize the completed bundle to
# standard distributable modes before signing: readable files, searchable
# directories, and executable bits retained where already present.
chmod -R a+rX "$APP"

# Release builds use the Developer ID identity supplied by the release helper.
# Local builds retain the ad-hoc fallback so contributors do not need a release
# certificate. The nested Sparkle framework is signed with the same identity
# before the outer app bundle.
SIGN_IDENTITY="${HUMANWAREOS_CODESIGN_IDENTITY:--}"
if [ "$SIGN_IDENTITY" = "-" ]; then
    codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$APP"
else
    codesign --force --deep --timestamp --options runtime --sign "$SIGN_IDENTITY" --entitlements "$ENTITLEMENTS" "$APP"
    codesign --verify --deep --strict --verbose=2 "$APP"
fi

# codesign creates CodeResources with the process umask, and ditto preserves
# symlink modes. Normalize once more after signing; modes are not part of the
# code signature, while Sparkle requires conventional 0644/0755 archive modes.
chmod -R a+rX "$APP"
find "$APP" -type l -exec chmod -h 755 {} +
codesign --verify --deep --strict --verbose=2 "$APP"

echo "Built $APP"
