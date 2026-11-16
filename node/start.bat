@echo off
cd /d "%~dp0"

REM ==========================================================
REM  Upstream proxy (for unstable direct connections)
REM  Change the address below to your own proxy.
REM  Delete these lines if you do not need a proxy.
REM ==========================================================
set "HTTPS_PROXY=http://127.0.0.1:11223"
set "HTTP_PROXY=http://127.0.0.1:11223"
set "NO_PROXY=127.0.0.1,localhost"

REM ==========================================================
REM  Upstream base URL (default: official API)
REM  Uncomment and edit to use a relay.
REM ==========================================================
REM set "MISTRAL_BASE_URL=https://api.mistral.ai"

REM  Debug mode: print per-chunk transform details
REM set "DEBUG=1"

REM  Listen port (default 8787)
REM set "PORT=8787"

echo ==========================================
echo   Mistral -^> OpenAI transform proxy
echo ==========================================
echo.
echo   Client base URL: http://127.0.0.1:8787/v1
echo   API Key: your Mistral key
echo.
echo   Press Ctrl+C to stop
echo ==========================================
echo.
node mistral-proxy.mjs
pause
