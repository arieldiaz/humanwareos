#!/bin/sh
# Build and stage a signed Sparkle update in the public HumanwareOS Pages repo.
# The EdDSA seed is injected by Doppler and passed to Sparkle over stdin; it is
# never written to disk. The app is Developer ID signed, notarized, and stapled
# before the public Sparkle archive and appcast are generated.
set -eu

if [ "$#" -ne 2 ]; then
    echo "usage: $0 <marketing-version> <build-number>" >&2
    exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
SITE_REPO="${HUMANWAREOS_SITE_REPO:?set HUMANWAREOS_SITE_REPO}"
VERSION="$1"
BUILD="$2"
INFO="$HERE/Info.plist"
RELEASES="$SITE_REPO/releases"
ARCHIVE="$RELEASES/HumanwareOS-$VERSION.zip"
SPARKLE_BIN="$HERE/.build/artifacts/sparkle/Sparkle/bin"
SIGN_IDENTITY="${HUMANWAREOS_CODESIGN_IDENTITY:?set HUMANWAREOS_CODESIGN_IDENTITY}"
TEAM_ID="${HUMANWAREOS_APPLE_TEAM_ID:?set HUMANWAREOS_APPLE_TEAM_ID}"
DOPPLER_PROJECT="${HUMANWAREOS_DOPPLER_PROJECT:?set HUMANWAREOS_DOPPLER_PROJECT}"
DOPPLER_CONFIG="${HUMANWAREOS_DOPPLER_CONFIG:-prd}"
NOTARY_ZIP="$(mktemp /tmp/HumanwareOS-notary.XXXXXX.zip)"
trap 'rm -f "$NOTARY_ZIP"' EXIT

test -d "$SITE_REPO/.git"
test -x "$SPARKLE_BIN/generate_appcast"
security find-identity -v -p codesigning | grep -Fq "$SIGN_IDENTITY"

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$INFO"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$INFO"
HUMANWAREOS_CODESIGN_IDENTITY="$SIGN_IDENTITY" "$HERE/build-app.sh" release

/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$HERE/HumanwareOS.app" "$NOTARY_ZIP"
doppler run --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" -- sh -c '
    test -n "$HUMANWAREOS_APPLE_ID"
    test -n "$HUMANWAREOS_APP_SPECIFIC_PASSWORD"
    xcrun notarytool submit "$1" \
        --apple-id "$HUMANWAREOS_APPLE_ID" \
        --password "$HUMANWAREOS_APP_SPECIFIC_PASSWORD" \
        --team-id "$2" \
        --wait
' sh "$NOTARY_ZIP" "$TEAM_ID"
xcrun stapler staple "$HERE/HumanwareOS.app"
xcrun stapler validate "$HERE/HumanwareOS.app"
spctl --assess --type execute --verbose=2 "$HERE/HumanwareOS.app"

mkdir -p "$RELEASES"
rm -f "$ARCHIVE"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$HERE/HumanwareOS.app" "$ARCHIVE"
unzip -tq "$ARCHIVE"

doppler run --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" -- sh -c '
    printf "%s" "$HUMANWAREOS_SPARKLE_PRIVATE_KEY" |
    "$1" --ed-key-file - \
        --download-url-prefix "https://updates.humanwareos.com/releases/" \
        --link "https://www.humanwareos.com/" \
        --maximum-versions 5 \
        -o "$2" "$3"
' sh "$SPARKLE_BIN/generate_appcast" "$SITE_REPO/appcast.xml" "$RELEASES"

echo "Staged HumanwareOS $VERSION ($BUILD)"
echo "Archive: $ARCHIVE"
echo "Feed: $SITE_REPO/appcast.xml"
