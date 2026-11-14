#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_dir"

if [[ ${1:-} == --help ]]; then
  printf 'Usage: ./start.sh\n\nStart Story Studio from this checkout. Build logs stay in the terminal.\n'
  exit 0
fi
if (( $# > 0 )); then
  printf 'Unknown argument: %s\n' "$1" >&2
  exit 1
fi

# Desktop launchers do not load an interactive shell's Rust environment.
if [[ -f "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi

# A second native instance asks the existing app to show and focus its window.
binary="$project_dir/src-tauri/target/debug/story-studio"
if [[ -x "$binary" ]] && command -v pgrep >/dev/null; then
  while IFS= read -r pid; do
    if [[ $(readlink "/proc/$pid/exe" 2>/dev/null || true) == "$binary" ]]; then
      exec "$binary"
    fi
  done < <(pgrep -u "$(id -u)" -x story-studio || true)
fi

for command in npm cargo flock; do
  if ! command -v "$command" >/dev/null; then
    printf 'Missing %s. See CONTRIBUTING.md for setup instructions.\n' "$command" >&2
    exit 1
  fi
done
if [[ ! -x node_modules/.bin/tauri ]]; then
  printf 'Install project dependencies first: npm ci\n' >&2
  exit 1
fi

# Prevent two launcher clicks from starting competing builds and dev servers.
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/story-studio"
mkdir -p -- "$cache_dir"
exec 9>"$cache_dir/start.lock"
if ! flock -n 9; then
  printf 'Story Studio is already starting or running.\n'
  exit 0
fi

printf 'Starting Story Studio. Close the app or press Ctrl+C here to stop.\n'
exec npm run tauri:dev
