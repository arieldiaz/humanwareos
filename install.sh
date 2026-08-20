#!/bin/sh
set -eu

FRAMEWORK_REPO="https://github.com/arieldiaz/humanwareos.git"

usage() {
  printf '%s\n' \
    "Install a private Humanware OS instance beside a pinned framework checkout." \
    "" \
    "Usage:" \
    "  ./install.sh INSTANCE_DIR [options]" \
    "" \
    "Options:" \
    "  --framework-dir DIR   Existing or new public framework checkout" \
    "  --data-root DIR       External mutable data plane" \
    "  --runtime-root DIR    Generated immutable runtime root" \
    "  --worktree-root DIR   Isolated worktrees for mutating work" \
    "  --instance-id ID      Lowercase machine id (default: directory name)" \
    "  --name NAME           Human-readable instance name" \
    "  --repo OWNER/REPO     Create and push the private instance repository"
}

die() {
  printf 'humanware: %s\n' "$1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

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
FRAMEWORK_DIR=""
DATA_ROOT=""
RUNTIME_ROOT=""
WORKTREE_ROOT=""
INSTANCE_ID=""
INSTANCE_NAME=""
PRIVATE_REPO=""
FRAMEWORK_DIR_SET=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --framework-dir|--data-root|--runtime-root|--worktree-root|--instance-id|--name|--repo)
      [ "$#" -ge 2 ] || die "$1 requires a value"
      case "$1" in
        --framework-dir) FRAMEWORK_DIR=$2; FRAMEWORK_DIR_SET=1 ;;
        --data-root) DATA_ROOT=$2 ;;
        --runtime-root) RUNTIME_ROOT=$2 ;;
        --worktree-root) WORKTREE_ROOT=$2 ;;
        --instance-id) INSTANCE_ID=$2 ;;
        --name) INSTANCE_NAME=$2 ;;
        --repo) PRIVATE_REPO=$2 ;;
      esac
      shift 2
      ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$TARGET_DIR" in
  /*) ;;
  *) TARGET_DIR="$(pwd)/$TARGET_DIR" ;;
esac
TARGET_PARENT=$(CDPATH= cd -- "$(dirname -- "$TARGET_DIR")" && pwd)
TARGET_BASE=$(basename -- "$TARGET_DIR")

[ ! -e "$TARGET_DIR" ] || die "$TARGET_DIR already exists"

[ -n "$INSTANCE_ID" ] || INSTANCE_ID=$(printf '%s' "$TARGET_BASE" | tr '[:upper:]_' '[:lower:]-')
printf '%s' "$INSTANCE_ID" | /usr/bin/grep -Eq '^[a-z][a-z0-9-]*$' || die "instance id must match ^[a-z][a-z0-9-]*$"
[ -n "$INSTANCE_NAME" ] || INSTANCE_NAME=$TARGET_BASE
[ -n "$FRAMEWORK_DIR" ] || FRAMEWORK_DIR="$TARGET_PARENT/humanwareos-framework"
[ -n "$DATA_ROOT" ] || DATA_ROOT="$TARGET_PARENT/$INSTANCE_ID-data"
[ -n "$RUNTIME_ROOT" ] || RUNTIME_ROOT="$TARGET_PARENT/$INSTANCE_ID-runtime"
[ -n "$WORKTREE_ROOT" ] || WORKTREE_ROOT="$TARGET_PARENT/$INSTANCE_ID-worktrees"

for absolute_path in "$FRAMEWORK_DIR" "$DATA_ROOT" "$RUNTIME_ROOT" "$WORKTREE_ROOT"; do
  case "$absolute_path" in
    /*) ;;
    *) die "all configured paths must be absolute: $absolute_path" ;;
  esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
if [ "$FRAMEWORK_DIR_SET" -eq 0 ] && [ -f "$SCRIPT_DIR/templates/instance/humanware.instance.json" ] && git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  FRAMEWORK_DIR=$SCRIPT_DIR
fi

if [ ! -d "$FRAMEWORK_DIR/.git" ] && ! git -C "$FRAMEWORK_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  [ ! -e "$FRAMEWORK_DIR" ] || die "$FRAMEWORK_DIR exists but is not a Git checkout"
  git clone "$FRAMEWORK_REPO" "$FRAMEWORK_DIR"
fi

TEMPLATE_DIR="$FRAMEWORK_DIR/templates/instance"
[ -f "$TEMPLATE_DIR/humanware.instance.json" ] || die "framework checkout does not contain instance templates"
FRAMEWORK_REVISION=$(git -C "$FRAMEWORK_DIR" rev-parse HEAD)

mkdir -p "$TARGET_DIR"
cp -R "$TEMPLATE_DIR/." "$TARGET_DIR/"

escape_replacement() {
  printf '%s' "$1" | sed 's/[|&]/\\&/g'
}

replace_tokens() {
  file=$1
  temporary="$file.tmp.$$"
  sed \
    -e "s|__INSTANCE_ID__|$(escape_replacement "$INSTANCE_ID")|g" \
    -e "s|__INSTANCE_NAME__|$(escape_replacement "$INSTANCE_NAME")|g" \
    -e "s|__DATA_ROOT__|$(escape_replacement "$DATA_ROOT")|g" \
    -e "s|__RUNTIME_ROOT__|$(escape_replacement "$RUNTIME_ROOT")|g" \
    -e "s|__WORKTREE_ROOT__|$(escape_replacement "$WORKTREE_ROOT")|g" \
    -e "s|__FRAMEWORK_REVISION__|$(escape_replacement "$FRAMEWORK_REVISION")|g" \
    "$file" > "$temporary"
  mv "$temporary" "$file"
}

find "$TARGET_DIR" -type f -print | while IFS= read -r file; do
  replace_tokens "$file"
done

"$FRAMEWORK_DIR/scripts/init-data-plane.sh" "$DATA_ROOT"
mkdir -p "$RUNTIME_ROOT" "$WORKTREE_ROOT"

git -C "$TARGET_DIR" init -b main
HUMANWARE_ALLOW_DIRTY_SOURCE=1 "$FRAMEWORK_DIR/scripts/validate-instance.sh" "$FRAMEWORK_DIR" "$TARGET_DIR"
HUMANWARE_ALLOW_DIRTY_SOURCE=1 "$FRAMEWORK_DIR/scripts/build-runtime.sh" "$FRAMEWORK_DIR" "$TARGET_DIR" --activate

if [ -n "$PRIVATE_REPO" ]; then
  command -v gh >/dev/null 2>&1 || die "GitHub CLI (gh) is required with --repo"
  gh auth status >/dev/null 2>&1 || die "authenticate GitHub CLI with: gh auth login"
  if gh repo view "$PRIVATE_REPO" >/dev/null 2>&1; then
    die "GitHub repo $PRIVATE_REPO already exists"
  fi
  git -C "$TARGET_DIR" add AGENTS-instance.md README.md agents channels humanware.instance.json humanware.lock.json runtime surfaces .gitignore
  git -C "$TARGET_DIR" commit -m "Initialize Humanware OS instance"
  gh repo create "$PRIVATE_REPO" --private
  git -C "$TARGET_DIR" remote add origin "https://github.com/$PRIVATE_REPO.git"
  git -C "$TARGET_DIR" push -u origin main
fi

printf '\nHumanware OS instance: %s\n' "$TARGET_DIR"
printf 'Pinned framework: %s at %s\n' "$FRAMEWORK_DIR" "$FRAMEWORK_REVISION"
printf 'Mutable data plane: %s\n' "$DATA_ROOT"
printf 'Active generated runtime: %s/current\n' "$RUNTIME_ROOT"
printf 'Mutating worktrees: %s\n' "$WORKTREE_ROOT"

if [ -z "$PRIVATE_REPO" ]; then
  printf 'The instance repository is local-only. Create a private origin before storing private configuration.\n'
fi
