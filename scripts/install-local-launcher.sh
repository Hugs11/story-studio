#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

python3 - "$project_dir" "$applications_dir" <<'PY'
from pathlib import Path
import sys

project, applications = map(Path, sys.argv[1:])

def value(text):
    return str(text).replace('\\', '\\\\').replace('\n', '\\n').replace('\r', '\\r')

def executable(path):
    # Exec uses desktop-entry escaping followed by command-line unquoting.
    text = str(path).replace('%', '%%')
    for character in ('\\', '"', '`', '$'):
        text = text.replace(character, '\\' + character)
    return value('"' + text + '"')

applications.mkdir(parents=True, exist_ok=True)
target = applications / 'story-studio-local.desktop'
launch = executable(project / 'start.sh')
target.write_text('\n'.join([
    '[Desktop Entry]',
    'Type=Application',
    'Name=Story Studio',
    'Comment=Start Story Studio from the local development checkout',
    'Exec=' + launch,
    'Path=' + value(project),
    'Icon=' + value(project / 'src-tauri/icons/128x128.png'),
    'Terminal=false',
    'Categories=AudioVideo;Audio;',
    'Keywords=Story;Studio;Lunii;FLAM;',
    'StartupWMClass=story-studio',
    '',
]), encoding='utf-8')
print('Installed launcher: ' + str(target))
PY

if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$applications_dir"
fi
printf 'Search for Story Studio in the app launcher.\n'
