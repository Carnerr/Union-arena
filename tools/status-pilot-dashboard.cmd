@echo off
cd /d "%~dp0.."
node tools\pilot-dashboard-service.mjs status
if errorlevel 1 pause
