@echo off
echo.
echo Modbus Manager Agent Installer
echo ======================================
echo.

REM Check for administrator privileges
net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo This installer should be run as Administrator for service installation.
    echo Right-click and select "Run as administrator"
    echo.
    echo Press any key to continue with manual installation only...
    pause >nul
    set SKIP_SERVICE=1
)

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

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Installation failed
    pause
    exit /b 1
)

echo.
echo Installation complete!
echo.

if defined SKIP_SERVICE (
    echo To start the agent manually, run:
    echo    node agent.js --token=YOUR_REGISTRATION_TOKEN
    echo.
    echo Get your registration token from the Agents page in Modbus Manager
    pause
    exit /b 0
)

REM Ask about service installation
set /p INSTALL_SERVICE="Do you want to install the agent as a Windows Service? (Y/N): "
if /I not "%INSTALL_SERVICE%"=="Y" (
    echo.
    echo To start the agent manually, run:
    echo    node agent.js --token=YOUR_REGISTRATION_TOKEN
    echo.
    echo Get your registration token from the Agents page in Modbus Manager
    pause
    exit /b 0
)

REM Get registration token
set /p TOKEN="Enter your registration token: "
if "%TOKEN%"=="" (
    echo Registration token is required
    pause
    exit /b 1
)

REM Check if NSSM is installed
where nssm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo NSSM (Non-Sucking Service Manager) is required to install as a service.
    echo.
    echo Downloading NSSM...
    
    REM Create temp directory
    if not exist "%TEMP%\nssm" mkdir "%TEMP%\nssm"
    
    REM Download NSSM using PowerShell
    powershell -Command "& {Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile '%TEMP%\nssm\nssm.zip'}"
    
    if %ERRORLEVEL% NEQ 0 (
        echo Failed to download NSSM
        echo Please download manually from https://nssm.cc/download
        pause
        exit /b 1
    )
    
    REM Extract NSSM
    powershell -Command "& {Expand-Archive -Path '%TEMP%\nssm\nssm.zip' -DestinationPath '%TEMP%\nssm' -Force}"
    
    REM Copy appropriate version to system32
    if "%PROCESSOR_ARCHITECTURE%"=="AMD64" (
        copy /Y "%TEMP%\nssm\nssm-2.24\win64\nssm.exe" "%WINDIR%\System32\nssm.exe"
    ) else (
        copy /Y "%TEMP%\nssm\nssm-2.24\win32\nssm.exe" "%WINDIR%\System32\nssm.exe"
    )
    
    echo NSSM installed successfully
)

REM Get current directory and Node.js path
set AGENT_DIR=%CD%
for /f "delims=" %%i in ('where node') do set NODE_PATH=%%i

echo.
echo Installing Windows Service...

REM Remove existing service if it exists
nssm stop ModbusAgent >nul 2>&1
nssm remove ModbusAgent confirm >nul 2>&1

REM Install the service
nssm install ModbusAgent "%NODE_PATH%" "%AGENT_DIR%\agent.js" --token=%TOKEN%
nssm set ModbusAgent AppDirectory "%AGENT_DIR%"
nssm set ModbusAgent DisplayName "Modbus Manager Agent"
nssm set ModbusAgent Description "Local polling engine for Modbus Manager cloud platform"
nssm set ModbusAgent Start SERVICE_AUTO_START

REM Configure failure recovery
nssm set ModbusAgent AppStdout "%AGENT_DIR%\logs\service.log"
nssm set ModbusAgent AppStderr "%AGENT_DIR%\logs\service-error.log"
nssm set ModbusAgent AppRotateFiles 1
nssm set ModbusAgent AppRotateBytes 1048576

REM Set restart on failure
nssm set ModbusAgent AppExit Default Restart
nssm set ModbusAgent AppRestartDelay 10000

REM Create logs directory
if not exist "%AGENT_DIR%\logs" mkdir "%AGENT_DIR%\logs"

REM Start the service
nssm start ModbusAgent

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Service installed and started successfully!
    echo.
    echo Service commands:
    echo    nssm status ModbusAgent    - Check status
    echo    nssm stop ModbusAgent      - Stop service
    echo    nssm start ModbusAgent     - Start service
    echo    nssm restart ModbusAgent   - Restart service
    echo    nssm edit ModbusAgent      - Edit service settings
    echo    nssm remove ModbusAgent    - Remove service
    echo.
    echo Logs are stored in: %AGENT_DIR%\logs
) else (
    echo.
    echo Failed to start service
    echo Check logs in: %AGENT_DIR%\logs
)

pause
