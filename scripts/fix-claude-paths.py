#!/usr/bin/env python3
"""
fix-claude-paths.py

Fixes Windows-style paths that were copied into ~/.claude on a Linux machine.
Replaces all occurrences of the Windows .claude base path with the Linux equivalent
across every JSON file in the ~/.claude directory.

Usage:
  python3 fix-claude-paths.py [--dry-run]
"""

import json
import os
import sys
import re
from pathlib import Path

DRY_RUN = '--dry-run' in sys.argv
CLAUDE_DIR = Path.home() / '.claude'

# Detect the Windows base path from installed_plugins.json or known_marketplaces.json.
# In JSON files backslashes are escaped, so C:\Users\jhh\.claude appears in the raw
# file text as C:\\Users\\jhh\\.claude — match both variants.
def find_windows_base(claude_dir):
    candidates = [
        claude_dir / 'plugins' / 'installed_plugins.json',
        claude_dir / 'plugins' / 'known_marketplaces.json',
    ]
    # Match single-backslash form (C:\Users\jhh\.claude) and
    # double-backslash JSON-escaped form (C:\\Users\\jhh\\.claude)
    pattern = re.compile(r'([A-Za-z]:\\{1,2}Users\\{1,2}[^\\]+\\{1,2}\.claude)', re.IGNORECASE)
    for path in candidates:
        if path.exists():
            text = path.read_text(encoding='utf-8')
            m = pattern.search(text)
            if m:
                # Normalise to single backslashes so win_to_linux can derive all variants
                return m.group(1).replace('\\\\', '\\')
    return None

def win_to_linux(text, win_base, linux_base):
    """Replace Windows .claude base path with Linux equivalent, normalising separators."""
    # Replace with forward-slash variant first (JSON may store \\ or /)
    win_fwd = win_base.replace('\\', '/')
    win_back = win_base.replace('/', '\\')
    win_double = win_base.replace('\\', '\\\\')   # JSON-escaped backslashes

    result = text
    result = result.replace(win_double, linux_base)   # JSON \\-escaped first
    result = result.replace(win_back, linux_base)
    result = result.replace(win_fwd, linux_base)
    return result

def process_file(path, win_base, linux_base):
    try:
        original = path.read_text(encoding='utf-8')
    except Exception as e:
        print(f'  SKIP (read error): {e}')
        return False

    updated = win_to_linux(original, win_base, linux_base)
    if updated == original:
        return False  # nothing changed

    # Validate it's still valid JSON (if it was JSON to begin with)
    if path.suffix == '.json':
        try:
            json.loads(updated)
        except json.JSONDecodeError as e:
            print(f'  SKIP (would produce invalid JSON): {e}')
            return False

    print(f'  PATCHING: {path.relative_to(Path.home())}')
    if not DRY_RUN:
        path.write_text(updated, encoding='utf-8')
    return True

def main():
    if not CLAUDE_DIR.exists():
        print(f'Error: {CLAUDE_DIR} does not exist.')
        sys.exit(1)

    win_base = find_windows_base(CLAUDE_DIR)
    if not win_base:
        print('No Windows paths found in plugin config files — nothing to do.')
        sys.exit(0)

    linux_base = str(CLAUDE_DIR)
    print(f'Windows base path detected: {win_base}')
    print(f'Linux base path:            {linux_base}')
    if DRY_RUN:
        print('DRY RUN — no files will be modified.\n')
    else:
        print()

    patched = 0
    for json_file in sorted(CLAUDE_DIR.rglob('*.json')):
        if process_file(json_file, win_base, linux_base):
            patched += 1

    print(f'\n{"Would patch" if DRY_RUN else "Patched"} {patched} file(s).')
    if DRY_RUN and patched:
        print('Re-run without --dry-run to apply changes.')

if __name__ == '__main__':
    main()
