#!/usr/bin/env python3
"""One-click launcher for SPHERExView.

Run this file with Python 3.10+ (double-click run.bat on Windows, or
./run.sh on macOS/Linux). It will:

  1. create a private Python environment in .venv/  (first run only)
  2. install the required packages                  (first run only)
  3. start the server and open the app in your browser

Everything is plain, readable Python on purpose -- no hidden shell
commands -- so antivirus tools have nothing to object to.
"""

import os
import socket
import subprocess
import sys
import threading
import time
import venv
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
VENV_DIR = os.path.join(ROOT, ".venv")
PORT = int(os.environ.get("PORT", "8000"))


def venv_python() -> str:
    if os.name == "nt":
        return os.path.join(VENV_DIR, "Scripts", "python.exe")
    return os.path.join(VENV_DIR, "bin", "python")


def open_browser_when_ready() -> None:
    """Open the app in the default browser once the server answers."""
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=1):
                break
        except OSError:
            time.sleep(0.5)
    else:
        return  # server never came up; the console will show why
    webbrowser.open(f"http://localhost:{PORT}")


def main() -> None:
    if sys.version_info < (3, 10):
        sys.exit(
            f"Python 3.10+ is required (you have "
            f"{sys.version_info.major}.{sys.version_info.minor}). "
            "Please install it from https://www.python.org/downloads/"
        )
    os.chdir(ROOT)

    if not os.path.exists(venv_python()):
        print("First run: creating a private Python environment (.venv)...")
        venv.create(VENV_DIR, with_pip=True)

    print("Checking Python packages (fast after the first run)...")
    result = subprocess.run(
        [
            venv_python(), "-m", "pip", "install",
            "--quiet", "--disable-pip-version-check",
            "-r", os.path.join("backend", "requirements.txt"),
        ]
    )
    if result.returncode != 0:
        sys.exit("Package installation failed. Check your internet connection.")

    threading.Thread(target=open_browser_when_ready, daemon=True).start()

    print()
    print(f"Starting SPHERExView at http://localhost:{PORT}")
    print("Close this window (or press Ctrl+C) to stop the app.")
    print()
    try:
        subprocess.run(
            [venv_python(), "-m", "uvicorn", "backend.app.main:app",
             "--port", str(PORT)]
        )
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
