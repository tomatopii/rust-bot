#!/usr/bin/env bash
# macOS の Finder からダブルクリックで起動するためのラッパ（中身は start.sh）
cd "$(dirname "$0")" || exit 1
exec ./start.sh
