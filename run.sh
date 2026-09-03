#!/usr/bin/env bash
# SPHEREx Wiseview launcher (macOS / Linux). All the logic lives in
# run.py (plain, readable Python) -- this file only starts it.
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
    echo "Python was not found. Please install Python 3.10+ from"
    echo "https://www.python.org/downloads/ and run this again."
    exit 1
fi

exec python3 run.py
