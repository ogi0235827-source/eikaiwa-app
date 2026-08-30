#!/usr/bin/env sh
# Install this repo's vendored skills into ~/.claude so they are available
# in every Claude Code project, not just this one.
#
#   sh .claude/install-skills.sh           # install, skipping anything already there
#   sh .claude/install-skills.sh --force   # overwrite existing installs
#
# Sources: mattpocock/skills @ 6654f6b, anthropics/skills @ 3b3fad9,
#          pbakaus/impeccable @ b0594c7.

set -eu

SKILLS="grill-me grilling grill-with-docs domain-modeling frontend-design impeccable"
AGENTS="impeccable-asset-producer impeccable-documenter impeccable-finish-reviewer impeccable-manual-edit-applier"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

[ -d "$SRC/skills" ] || { echo "error: $SRC/skills not found" >&2; exit 1; }

mkdir -p "$DEST/skills" "$DEST/agents"

for s in $SKILLS; do
  if [ ! -d "$SRC/skills/$s" ]; then
    echo "skip    $s (not in repo)"
  elif [ -e "$DEST/skills/$s" ] && [ "$FORCE" -eq 0 ]; then
    echo "exists  $s (use --force to overwrite)"
  else
    rm -rf "$DEST/skills/$s"
    cp -R "$SRC/skills/$s" "$DEST/skills/$s"
    echo "installed $s"
  fi
done

for a in $AGENTS; do
  if [ ! -f "$SRC/agents/$a.md" ]; then
    echo "skip    $a (not in repo)"
  elif [ -e "$DEST/agents/$a.md" ] && [ "$FORCE" -eq 0 ]; then
    echo "exists  $a (use --force to overwrite)"
  else
    cp "$SRC/agents/$a.md" "$DEST/agents/$a.md"
    echo "installed $a"
  fi
done

echo
echo "Done. Restart Claude Code to pick them up."
echo "The impeccable detector hook is NOT installed; run '/impeccable hooks on' per project to opt in."
