@echo off
echo.
echo Modbus Manager Agent Installer
echo ======================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo X Node.js is not installed
    echo Please install Node.js 18+ from https://nodejs.org
    pause
    exit /b 1
)

echo Node.js found
node --version
echo.

REM Install dependencies
echo Installing dependencies...
call npm install

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Installation complete!
    echo.
    echo To start the agent, run:
    echo    node agent.js --token=YOUR_REGISTRATION_TOKEN
    echo.
    echo Get your registration token from the Agents page in Modbus Manager
) else (
    echo.
    echo Installation failed
    pause
    exit /b 1
)

pause
