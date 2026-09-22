# rust-bot

Rust+ のスマートアラーム通知を Discord に転送する小さなボットです。

> Forwards Rust+ smart alarm push notifications to a Discord webhook. The setup guide below is in Japanese.

## できること

- ゲーム内のスマートアラームが発報したら、Discord のチャンネルに投稿する（アラームの題名・本文・サーバー名・時刻）
- 任意で、オフライン中に倒された通知とチームメイトのログイン通知も転送する
- Discord の Bot を作る必要がない（チャンネルの Webhook だけ）。チャンネルやロールを勝手に作らない

## 仕組み

Rust+ アプリがスマホで受け取るプッシュ通知（FCM）を、PC 上でそのまま受信して Discord に流します。
1 人分の Rust+ 認証情報で動き、その人（とそのチーム）に届く通知が転送されます。

## 必要なもの

- Node.js 20.6 以上（`node -v` で確認）
- PC 版 Rust と Steam アカウント。Rust+ が有効なサーバー
- 投稿先の Discord サーバーで Webhook を作れる権限

## セットアップ

### 1. Discord の Webhook URL を作る

投稿したいチャンネルの `チャンネルの編集` → `連携サービス` → `ウェブフック` → `新しいウェブフック` → `ウェブフック URL をコピー`。
名前とアイコンはここで自由に決められます。

### 2. Rust+ の認証情報を取る

Rust+ の通知を受け取るには、この PC を「もう 1 台のスマホ」として Rust+ に登録します。自分の PC だけで完結する方法（推奨）と、Web ページを使う方法があります。

**方法 A（推奨）: 自分の PC で登録する**

[rustplus.js](https://github.com/liamcottle/rustplus.js) の `fcm-register` を使います。Google Chrome が必要です（無い場合は環境変数 `CHROME_PATH` に Edge の `msedge.exe` のパスを入れると動きます）。

1. 空のフォルダで PowerShell を開き、`npx --yes @liamcottle/rustplus.js fcm-register` を実行する
2. 登録専用の Chrome が開くので、Rust+ のログイン画面から Steam でログインする
3. `Successfully registered with Rust Companion API` と出たら、同じフォルダにできた `rustplus.config.json` を開き、`fcm_credentials.gcm.androidId` を `GCM_ANDROID_ID`、`fcm_credentials.gcm.securityToken` を `GCM_SECURITY_TOKEN` として控える
4. `rustplus.config.json` は認証情報そのものなので、控えたら削除する

この方法では、ログインの情報は Facepunch・Steam・Google・Expo（通知の配送に必要な相手）にしか渡りません。開いた Chrome は登録専用の設定で起動するので、他のサイトは開かず、終わったら閉じてください。

**方法 B: Web ページで登録する**

rustPlusPlus の作者が公開している <https://rustplusplus-credentials.netlify.app/> とブラウザ拡張を使います。手軽ですが、Rust+ のログイントークンが作者のサーバーを経由します（Facepunch や Steam の公式ではありません）。

1. ページを開き、`Install Extension` で拡張を入れてページを再読み込みする
2. `Log In` で Steam にログインする
3. `/credentials add gcm_android_id:XXXX gcm_security_token:YYYY ...` と表示される。`XXXX` と `YYYY` を控える

どちらの方法でも、この 2 つの値は自分の Rust+ 通知を読めるものなので、他人に見せないでください。

### 3. `.env` を作る

`.env.example` を `.env` という名前でコピーし、3 つの値を入れます。

```dotenv
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
GCM_ANDROID_ID=XXXX
GCM_SECURITY_TOKEN=YYYY
```

### 4. 起動する

`start.bat` をダブルクリックします（初回は依存パッケージのインストールとビルドが走ります）。
コマンドで動かす場合は次のとおりです。

```sh
npm install
npm run build
npm start
```

`FCM に接続しました。通知を待っています` と出れば準備完了です。

### 5. ゲーム内でペアリングする

1. Rust を起動し、`ESC` → `Rust+` からサーバーとペアリングする。ログに `サーバーとペアリングされました` と出る
2. スマートアラームを設置し、`E` 長押し → `Pair` でペアリングする。ログに `デバイスとペアリングされました` と出る
3. アラームに電源を入れて発報させ、Discord に投稿されれば完了

## 設定（`.env`）

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | 必須 | 投稿先チャンネルの Webhook URL |
| `GCM_ANDROID_ID` | 必須 | 手順 2 の `gcm_android_id` |
| `GCM_SECURITY_TOKEN` | 必須 | 手順 2 の `gcm_security_token` |
| `ALARM_MENTION` | 任意 | アラーム投稿に付けるメンション。`@here`、`<@&ロールID>`、`<@ユーザーID>` など |
| `FORWARD_DEATH` | 任意 | `true` でオフライン中に倒された通知も転送する（既定 `false`） |
| `FORWARD_TEAM_LOGIN` | 任意 | `true` でチームメイトのログイン通知も転送する（既定 `false`） |
| `STATE_FILE` | 任意 | 受信済み通知とサーバー情報（アドレスと名前）の記録先（既定 `state.json`。空にすると既定値）。既定以外の場所にすると `.gitignore` の対象外になるので注意 |

## 知っておいてほしいこと

- 通知は Rust+ アプリ（スマホ）にも今までどおり届きます
- 認証情報には有効期限があります。通知が届かなくなったら手順 2 をやり直し、`.env` の 2 つの値を差し替えてください
- Rust+ のプッシュ通知は稀に届かないことがあると、参考にした rustPlusPlus の作者が注記しています。取りこぼしが気になる場合に備えて、Rust サーバーへ直接接続してアラームの状態変化を拾う方式（Phase 2）を検討しています
- `state.json` に保存するのは、受信済み通知の ID と、ペアリングしたサーバーのアドレス（IP:ポート）と名前だけです。認証情報（`GCM_ANDROID_ID` / `GCM_SECURITY_TOKEN`）と Webhook URL は保存しません。サーバーのアドレスが入るので、中身をそのまま他人に渡さないでください（`.gitignore` で除外済みです）
- ボットが想定外のエラーで止まった場合、`start.bat` は 10 秒後に自動で再起動します。Ctrl+C で止めたときは再起動しません

## 開発

```sh
npm run dev       # ビルドせずに起動
npm run verify    # 型チェック・lint・テスト
```

## ライセンス

MIT

## 参考にしたもの

- [rustPlusPlus](https://github.com/alexemanuelol/rustplusplus)（通知の受け取り方の参考にしました）
- [@liamcottle/push-receiver](https://github.com/liamcottle/push-receiver)（FCM の受信）
