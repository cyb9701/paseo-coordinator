#!/usr/bin/env bash
# Decides the next release from the Conventional Commits since the last vX.Y.Z tag.
#
# Rules (agreed for this repo):
#   - BREAKING CHANGE footer or `type!:` -> major
#   - feat                               -> minor
#   - fix                                -> patch
#   - docs/style/chore/test/... only     -> no release, so the release list
#                                           only holds changes users can notice
#   - no tag yet                         -> v0.1.0, the first public version
#
# Prints nothing when there is nothing to release. Otherwise writes
# `version=vX.Y.Z` and a multi-line `notes` value in GITHUB_OUTPUT format
# to the file named by $GITHUB_OUTPUT (or stdout when run locally).
set -euo pipefail

FIRST_VERSION="v0.1.0"
out="${GITHUB_OUTPUT:-/dev/stdout}"

last_tag="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)"
if [[ -n "$last_tag" ]]; then
  range="${last_tag}..HEAD"
else
  range="HEAD"
fi

# Record separator \x1e between commits, unit separator \x1f between subject and body,
# because commit bodies can contain any printable text and newlines.
log="$(git log --no-merges --format='%s%x1f%b%x1e' "$range")"

bump=""
breaking_notes=""
feat_notes=""
fix_notes=""
header_re='^([a-zA-Z]+)(\([^)]*\))?(!)?:[[:space:]]*(.*)$'

while IFS= read -r -d $'\x1e' entry; do
  entry="${entry#$'\n'}"
  [[ -z "$entry" ]] && continue
  subject="${entry%%$'\x1f'*}"
  body="${entry#*$'\x1f'}"
  [[ "$subject" =~ $header_re ]] || continue
  type="$(tr '[:upper:]' '[:lower:]' <<<"${BASH_REMATCH[1]}")"
  bang="${BASH_REMATCH[3]}"
  desc="${BASH_REMATCH[4]}"

  if [[ -n "$bang" ]] || grep -qE '^BREAKING[ -]CHANGE:' <<<"$body"; then
    bump="major"
    breaking_notes+="- ${subject}"$'\n'
    continue
  fi
  case "$type" in
    feat)
      [[ "$bump" == "major" ]] || bump="minor"
      feat_notes+="- ${desc}"$'\n'
      ;;
    fix)
      [[ -n "$bump" ]] || bump="patch"
      fix_notes+="- ${desc}"$'\n'
      ;;
  esac
done <<<"$log"

[[ -z "$bump" ]] && exit 0

if [[ -z "$last_tag" ]]; then
  next="$FIRST_VERSION"
else
  IFS=. read -r major minor patch <<<"${last_tag#v}"
  case "$bump" in
    major) next="v$((major + 1)).0.0" ;;
    minor) next="v${major}.$((minor + 1)).0" ;;
    patch) next="v${major}.${minor}.$((patch + 1))" ;;
  esac
fi

notes=""
[[ -n "$breaking_notes" ]] && notes+=$'## Breaking changes\n\n'"${breaking_notes}"$'\n'
[[ -n "$feat_notes" ]] && notes+=$'## Features\n\n'"${feat_notes}"$'\n'
[[ -n "$fix_notes" ]] && notes+=$'## Fixes\n\n'"${fix_notes}"$'\n'
if [[ -n "$last_tag" && -n "${GITHUB_REPOSITORY:-}" ]]; then
  notes+="**Full changelog**: https://github.com/${GITHUB_REPOSITORY}/compare/${last_tag}...${next}"$'\n'
fi

delim="EOF_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
{
  echo "version=${next}"
  echo "notes<<${delim}"
  printf '%s' "$notes"
  echo "${delim}"
} >>"$out"
