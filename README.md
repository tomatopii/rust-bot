# rust-bot

Rust+ のスマートアラーム通知を Discord に転送する小さなボットです。

> Forwards Rust+ smart alarm push notifications to a Discord webhook. The setup guide below is in Japanese.

## できること

- ゲーム内のスマートアラームが発報したら、Discord のチャンネルに投稿する（アラームの題名・本文・サーバー名・時刻）
- アラームの題名ごとに「Discord に投稿 / ログだけ / 無視」を選べる。メンションも題名ごとに変えられる
- ログ・通知履歴・設定を、同じ PC のブラウザから見られる（[Web 画面](#web-画面)）
- 任意で、オフライン中に倒された通知とチームメイトのログイン通知も転送する
- Discord の Bot を作る必要がない（チャンネルの Webhook だけ）。チャンネルやロールを勝手に作らない
- Windows・macOS・Linux で同じように動く

## 仕組み

Rust+ アプリがスマホで受け取るプッシュ通知（FCM）を、PC 上でそのまま受信して Discord に流します。
1 人分の Rust+ 認証情報で動き、その人（とそのチーム）に届く通知が転送されます。

## 必要なもの

- Windows・macOS・Linux のいずれか
- Node.js 20.6 以上（`node -v` で確認）
- Google Chrome（手順 2 で認証情報を取るときだけ使います。Windows で Chrome が無い場合は Edge で代用できます）
- PC 版 Rust と Steam アカウント。Rust+ が有効なサーバー
- 投稿先の Discord サーバーで Webhook を作れる権限

## セットアップ

### 1. Discord の Webhook URL を作る

投稿したいチャンネルの `チャンネルの編集` → `連携サービス` → `ウェブフック` → `新しいウェブフック` → `ウェブフック URL をコピー`。
名前とアイコンはここで自由に決められます。

### 2. Rust+ の認証情報を取る

Rust+ の通知を受け取るには、この PC を「もう 1 台のスマホ」として Rust+ に登録します。自分の PC だけで完結する方法（推奨）と、Web ページを使う方法があります。

**方法 A（推奨）: 自分の PC で登録する**

[rustplus.js](https://github.com/liamcottle/rustplus.js) の `fcm-register` を使います。Google Chrome が必要です（Windows で Chrome が無い場合は、環境変数 `CHROME_PATH` に Edge の `msedge.exe` のパスを入れると動きます）。

1. 空のフォルダでターミナル（Windows は PowerShell）を開き、`npx --yes @liamcottle/rustplus.js fcm-register` を実行する
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

初回は依存パッケージのインストールとビルドが走ります。

| OS | 起動のしかた |
| --- | --- |
| Windows | `start.bat` をダブルクリック |
| macOS | `start.command` をダブルクリック |
| Linux | ターミナルで `./start.sh` |

macOS で「開発元を確認できないため開けません」と出たら、「システム設定」→「プライバシーとセキュリティ」を開き、画面の下の方に出る `start.command` の行で「このまま開く」を選びます（macOS 15 以降は右クリックの「開く」では回避できません）。

ターミナルからなら次の 1 行で起動できます。ZIP でダウンロードして実行権限やダウンロードの印（quarantine）が付いた状態でも、この形なら止められません。

```sh
bash start.sh
```

`start.command` のダブルクリックで使いたい場合は、先に次を実行して実行権限とダウンロードの印を直します。

```sh
chmod +x start.sh start.command
xattr -dr com.apple.quarantine .
```

どの OS でも、コマンドから直接動かすこともできます。

```sh
npm install
npm run build
npm start
```

`FCM に接続しました。通知を待っています` と出れば準備完了です。
`Web 画面: http://127.0.0.1:3080/` も出るので、ブラウザで開くとログや設定を見られます（[Web 画面](#web-画面)）。

### 5. ゲーム内でペアリングする

1. Rust を起動し、`ESC` → `Rust+` からサーバーとペアリングする。ログに `サーバーとペアリングされました` と出る
2. スマートアラームを設置し、`E` 長押し → `Pair` でペアリングする。ログに `デバイスとペアリングされました` と出る
3. アラームに電源を入れて発報させ、Discord に投稿されれば完了

発報テストがうまくいかないときは、次の 3 点を確認してください。いずれもゲーム側の仕様で、ボットの設定では変えられません。

- **アラームは自分の TC の範囲内に置き、その TC に認証されていること。** アラームの位置を支配する TC に認証されていないプレイヤーは、発報のたびに通知の対象から外されます（外れたら再ペアリングが必要）。TC の無い場所ならこの制限はありません
- **発報のあと、次の通知まで間隔を空けること。** 最低 15 秒、サーバーの設定によっては数分です。届かないときは電源を切り、数分待ってから入れ直してください
- **1 回で判定しないこと。** Rust+ のプッシュ通知は稀に届かないので、間隔を空けて 2〜3 回試してください

通知の題名と本文は、ゲーム内でアラームに近づいて設定します（Rust+ アプリからは変えられません）。複数のアラームを Discord で見分けたいときは、それぞれ別の題名を付けてください。

## Web 画面

ボットを起動したら、同じ PC のブラウザで <http://127.0.0.1:3080/> を開きます（ポートは `WEB_PORT` で変えられます。`0` にすると画面ごと無効になります）。

できること:

- FCM の接続状態・最後に通知を受けた時刻・起動時刻・転送の設定を見る
- 「Discord にテスト投稿」で Webhook が生きているか確かめる
- アラームの題名ごとの振り分けとメンションを変える
- ペアリング済みのスマートアラームの一覧を見る
- 通知の履歴とログをそのまま流れてくる形で見る

画面は `127.0.0.1` だけで待ち受けるので、開けるのはボットを動かしている PC からだけです（同じ LAN の別の端末や外部からは開けません）。そのためログイン機能はありません。画面と `settings.json` に Webhook URL や認証情報は出ません。

### アラームの振り分け（`settings.json`）

発報の通知にはアラームの ID が入らないので、**題名**で見分けます。ゲーム内でアラームごとに別の題名を付けてください。

画面の「保存」を押すと `settings.json` に書かれ、再起動しなくてもすぐ効きます。中身は次の形です（直接編集する場合はボットを止めてから）。

```json
{
    "version": 1,
    "unknownAlarmMode": "discord",
    "alarms": {
        "玄関": { "mode": "discord", "mention": "<@&123456789012345678>" },
        "採掘場": { "mode": "log" }
    }
}
```

- `mode` は `discord`（Discord に投稿）・`log`（ログだけ）・`mute`（無視）のどれか
- `mention` は投稿に付けるメンション。空なら `.env` の `ALARM_MENTION` を使う
- 設定に無い題名は `unknownAlarmMode`（既定 `discord`）で扱い、初めて発報したときに一覧へ自動で追加されます

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
| `SETTINGS_FILE` | 任意 | アラームの振り分け設定の置き場（既定 `settings.json`。空にすると既定値） |
| `WEB_PORT` | 任意 | Web 画面のポート（既定 `3080`。`0` にすると Web 画面を無効にする） |

## 知っておいてほしいこと

- 通知は Rust+ アプリ（スマホ）にも今までどおり届きます
- スマホの Rust+ でアラームごとの通知を OFF にすると、サーバーがその通知を送らなくなるので、このボットにも届かなくなります。アプリ全体や端末の通知設定は影響しません
- 認証情報には有効期限があります。通知が届かなくなったら手順 2 をやり直し、`.env` の 2 つの値を差し替えてください
- Rust+ のプッシュ通知は稀に届かないことがあると、参考にした rustPlusPlus の作者が注記しています。取りこぼしが気になる場合に備えて、Rust サーバーへ直接接続してアラームの状態変化を拾う方式（Phase 2）を検討しています
- `state.json` に保存するのは、受信済み通知の ID、ペアリングしたサーバーのアドレス（IP:ポート）と名前、ペアリングしたデバイス（ID・種類・名前・時刻）、アラームの題名ごとの発報回数と最終発報時刻だけです。認証情報（`GCM_ANDROID_ID` / `GCM_SECURITY_TOKEN`）と Webhook URL は保存しません。サーバーのアドレスが入るので、中身をそのまま他人に渡さないでください（`.gitignore` で除外済みです）
- ボットが想定外のエラーで止まった場合、`start.bat` / `start.sh` は 10 秒後に自動で再起動します。Ctrl+C で止めたときは再起動しません

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
