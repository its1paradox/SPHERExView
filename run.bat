@echo off
REM SPHEREx Wiseview launcher. All the logic lives in run.py (plain,
REM readable Python) -- this file only starts it.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
    echo Python was not found. Please install Python 3.10+ from
    echo https://www.python.org/downloads/ and tick "Add python.exe to PATH",
    echo then double-click run.bat again.
    pause
    exit /b 1
)
python run.py
pause
