#!/bin/sh
# Build and sign the app bundle that owns an instance's background services.
# Its only executable is the service launcher, named after the app, so the
# bundle shows no UI and starts nothing by itself.
#
# Usage: build.sh NAME BUNDLE_ID SIGNING_IDENTITY OUTPUT.app
# SIGNING_IDENTITY "-" signs ad hoc (tests and CI); it is never a default.
# An existing OUTPUT built from the same source and inputs is left untouched.
set -eu

fail() {
  printf 'service-app: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 4 ] || {
  printf '%s\n' "Usage: $0 NAME BUNDLE_ID SIGNING_IDENTITY OUTPUT.app" >&2
  exit 2
}
NAME=$1
BUNDLE_ID=$2
IDENTITY=$3
OUTPUT=$4
case "$NAME" in ''|*/*|.*) fail "invalid app name: $NAME" ;; esac
[ -n "$BUNDLE_ID" ] || fail "bundle identifier is required"
[ -n "$IDENTITY" ] || fail "signing identity is required (use - for ad hoc)"
case "$OUTPUT" in /*.app) ;; *) fail "output must be an absolute path ending in .app: $OUTPUT" ;; esac

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DIGEST=$({ cat "$HERE/launcher.c" "$HERE/build.sh"; printf '%s\n' "$NAME" "$BUNDLE_ID" "$IDENTITY"; } | /usr/bin/shasum -a 256 | /usr/bin/awk '{ print $1 }')

if [ -d "$OUTPUT" ] \
  && [ "$(/usr/bin/plutil -extract HumanwareSourceDigest raw -o - "$OUTPUT/Contents/Info.plist" 2>/dev/null)" = "$DIGEST" ] \
  && /usr/bin/codesign --verify --strict "$OUTPUT" 2>/dev/null; then
  printf 'service-app: up to date %s\n' "$OUTPUT"
  exit 0
fi

PARENT=$(dirname -- "$OUTPUT")
mkdir -p "$PARENT"
WORK=$(mktemp -d "$PARENT/.$(basename -- "$OUTPUT").build.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
APP="$WORK/$(basename -- "$OUTPUT")"
mkdir -p "$APP/Contents/MacOS"
cc -O2 -Wall -Wextra -Werror -mmacosx-version-min=13.0 -o "$APP/Contents/MacOS/$NAME" "$HERE/launcher.c"

INFO="$APP/Contents/Info.plist"
printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' '<plist version="1.0"><dict/></plist>' > "$INFO"
for pair in \
  "CFBundleInfoDictionaryVersion=6.0" \
  "CFBundlePackageType=APPL" \
  "CFBundleExecutable=$NAME" \
  "CFBundleIdentifier=$BUNDLE_ID" \
  "CFBundleName=$NAME" \
  "CFBundleDisplayName=$NAME" \
  "CFBundleShortVersionString=1.0" \
  "CFBundleVersion=1" \
  "LSMinimumSystemVersion=13.0" \
  "HumanwareSourceDigest=$DIGEST"
do
  /usr/bin/plutil -insert "${pair%%=*}" -string "${pair#*=}" "$INFO"
done
/usr/bin/plutil -insert LSBackgroundOnly -bool true "$INFO"
/usr/bin/plutil -lint "$INFO" >/dev/null

# The mini runs with a restrictive umask; ship conventional modes.
chmod -R a+rX "$APP"
if [ "$IDENTITY" = "-" ]; then
  /usr/bin/codesign --force --sign - --options runtime --timestamp=none "$APP"
else
  /usr/bin/codesign --force --sign "$IDENTITY" --options runtime --timestamp "$APP"
  /usr/bin/codesign -dvv "$APP" 2>&1 | grep -Fqx "Authority=$IDENTITY" || fail "signature authority is not $IDENTITY"
fi
chmod -R a+rX "$APP"
/usr/bin/codesign --verify --strict --verbose=2 "$APP"

# Swap in by rename; a running launcher keeps its open executable.
[ ! -e "$OUTPUT" ] || mv "$OUTPUT" "$WORK/previous.app"
mv "$APP" "$OUTPUT"
printf 'service-app: built %s\n' "$OUTPUT"
