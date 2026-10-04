@echo off
setlocal
rem CMD bootstrap; PowerShell owns installation and forwards its exit status.
if exist "%~dp0install.ps1" goto local_installer
set "CLIO_CODER_BOOTSTRAP_FILE=%TEMP%\clio-coder-install-%RANDOM%-%RANDOM%.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing 'https://github.com/iowarp/clio-coder/releases/latest/download/install.ps1' -OutFile $env:CLIO_CODER_BOOTSTRAP_FILE"
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CLIO_CODER_BOOTSTRAP_FILE%" %*
set "CLIO_CODER_BOOTSTRAP_EXIT=%errorlevel%"
del /q "%CLIO_CODER_BOOTSTRAP_FILE%"
exit /b %CLIO_CODER_BOOTSTRAP_EXIT%

:local_installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %errorlevel%
