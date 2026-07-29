#!/bin/sh

set -eu

FRAMEWORK_REPO="https://github.com/arieldiaz/Humanware-OS.git"

usage() {
  printf '%s\n' \
    "Install Humanware OS as a private, upstream-connected instance." \
    "" \
    "Usage:" \
    "  ./install.sh <directory> [--repo OWNER/REPO]" \
    "" \
    "Examples:" \
    "  ./install.sh my-humanware" \
    "  ./install.sh my-humanware --repo you/my-humanware"
}

die() {
  printf 'humanware: %s\n' "$1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is required"

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

[ "$#" -ge 1 ] || {
  usage >&2
  exit 1
}

TARGET_DIR=$1
shift
PRIVATE_REPO=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$#" -ge 2 ] || die "--repo requires OWNER/REPO"
      PRIVATE_REPO=$2
      shift 2
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[ ! -e "$TARGET_DIR" ] || die "$TARGET_DIR already exists"

git clone "$FRAMEWORK_REPO" "$TARGET_DIR"
git -C "$TARGET_DIR" remote rename origin upstream

if [ -n "$PRIVATE_REPO" ]; then
  command -v gh >/dev/null 2>&1 || die "GitHub CLI (gh) is required with --repo"
  gh auth status >/dev/null 2>&1 || die "authenticate GitHub CLI with: gh auth login"

  if gh repo view "$PRIVATE_REPO" >/dev/null 2>&1; then
    die "GitHub repo $PRIVATE_REPO already exists; add it manually as origin"
  fi

  gh repo create "$PRIVATE_REPO" --private
  git -C "$TARGET_DIR" remote add origin "https://github.com/$PRIVATE_REPO.git"
  git -C "$TARGET_DIR" push -u origin main
fi

printf '\nHumanware OS is ready in %s.\n' "$TARGET_DIR"
printf 'Framework updates: git fetch upstream && git merge upstream/main\n'

if [ -z "$PRIVATE_REPO" ]; then
  printf 'Next: create a private repo, add it as origin, and push main.\n'
fi
