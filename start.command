#!/usr/bin/env bash
# macOS の Finder からダブルクリックで起動するためのラッパ（中身は start.sh）
cd "$(dirname "$0")" || exit 1
# start.sh の実行権限が落ちていても（ZIP 展開など）動くよう、bash に読ませる
exec bash ./start.sh
