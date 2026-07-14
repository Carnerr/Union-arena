@echo off
cd /d "%~dp0.."
node tools\pilot-dashboard-service.mjs restart
if errorlevel 1 pause
