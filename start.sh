#!/usr/bin/env bash
# macOS / Linux 用の起動スクリプト（Windows は start.bat）
set -u

cd "$(dirname "$0")" || exit 1

# ダブルクリックで開いた端末は終了と同時に閉じる設定のことがあるので、止まった理由を読めるように待つ
pause() {
    if [ -t 0 ]; then
        printf '%s' "Enter キーを押すと閉じます..."
        read -r _
    fi
}

if [ ! -f .env ]; then
    echo ".env がありません。.env.example をコピーして .env を作り、値を入れてください。"
    pause
    exit 1
fi

# ダブルクリックで開いた端末は nvm などの設定を読み込まないことがあり、そこだけ node が見つからない
if ! command -v node >/dev/null 2>&1; then
    echo "node が見つかりません。Node.js 20.6 以上を入れるか、ターミナルで bash start.sh を実行してください。"
    pause
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "依存パッケージを入れます..."
    if ! npm install; then
        pause
        exit 1
    fi
fi

if ! npm run build; then
    pause
    exit 1
fi

# Ctrl+C は node も受け取って終了処理をする。bash はその完了を待ってからこの trap を実行するので、
# 記録を保存し終えてから再起動せずに抜けられる
trap 'echo; exit 0' INT

while true; do
    node --env-file=.env dist/index.js
    status=$?
    if [ "$status" -eq 0 ]; then
        break
    fi
    echo "想定外のエラーで止まりました（終了コード ${status}）。10 秒後に再起動します。止めるには Ctrl+C を押してください。"
    sleep 10
done

pause
