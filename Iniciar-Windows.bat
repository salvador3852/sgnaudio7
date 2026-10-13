@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Necesitas instalar Node.js LTS desde https://nodejs.org y volver a abrir este archivo. & start https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
call npm start
