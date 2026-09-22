@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env" (
    echo .env がありません。.env.example をコピーして .env を作り、値を入れてください。
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo 依存パッケージを入れます...
    call npm install || (pause & exit /b 1)
)

call npm run build || (pause & exit /b 1)

:run
node --env-file=.env dist\index.js
if %errorlevel%==0 goto end
echo 想定外のエラーで止まりました（終了コード %errorlevel%）。10 秒後に再起動します。止めるには Ctrl+C を押してください。
timeout /t 10 /nobreak >nul
goto run

:end
pause
