# CLOVER. 入室実験 — SwitchBot にワンタイム暗証番号を発行する

TSURU. から SwitchBot（ロック＋キーパッド）に、予約ごとの暗証番号を発行して入室してもらう仕組みの **API 実験**。
TSURU. 本体には触らず、`switchbot.mjs` で SwitchBot API v1.1 を直接叩いて「発行 → キーパッドに反映 → 解錠できる → 削除」までを店舗で確かめる。

過去に一度失敗した原因は「`createKey` の結果が **Webhook で非同期に返る** のを見落としていた」可能性が高い（2026-04-23 のログ）。
このスクリプトは、その非同期性を前提に **発行後に keyList を監視して反映を確認する** ようにしてある。

## 0. 必要なもの（店舗で）

- SwitchBot ロック（Lock / Pro / Ultra）とキーパッド（Keypad / Touch / Vision）が SwitchBot アプリに登録済みで、**ハブ経由でクラウド接続**できていること（アプリで「クラウドサービス」ON）
- SwitchBot の API トークンとシークレット
  - SwitchBot アプリ → プロフィール → 設定 → **アプリバージョンを 10 回タップ** → 開発者向けオプション → トークン／クライアントシークレット
- Node.js 18 以上が入った Mac（追加パッケージ不要）

## 1. 準備（1 分）

```sh
cd experiments/switchbot
cp .env.example .env
# .env に SWITCHBOT_TOKEN と SWITCHBOT_SECRET を貼る
```

## 2. 実験手順

### ① デバイスが見えるか

```sh
node switchbot.mjs devices
```

🔒 がロック、🔢 がキーパッド。キーパッドの行に「紐付くロック」と「登録済みキー」が出る。
ここで出ない場合は、アプリ側のクラウドサービス設定かハブの接続を確認（API 到達性の問題であって、TSURU. の問題ではない）。

**記録すること**: ロックの `deviceId`、キーパッドの `deviceId` と `deviceType`。
TSURU. の `access_control_settings`（lock_device_id / keypad_device_id / keypad_device_type）に入れる値そのもの。

### ② 「今から 30 分」の暗証番号を発行

```sh
node switchbot.mjs create --minutes 30
```

6 桁のコードを自動生成して `createKey` を送り、`commandId` を表示。その後 **最大 90 秒、キーパッドの keyList に反映されるまで監視** する。

**記録すること**: 反映までの秒数（TSURU. 側で「発行してから LINE で送るまでの待ち時間」の設計根拠になる）。

### ③ 実際に解錠する

店の外に出て、キーパッドにコード＋確定キー（✓ または 🔓）を入力。解錠されれば成功。

### ④ 予約時刻を模した有効期間で発行

TSURU. の既定は **予約の 5 分前〜19 分後**（`before_min=5`, `after_min=19`）。同じ窓で試す:

```sh
node switchbot.mjs create --booking 14:00            # 13:55〜14:19 有効
node switchbot.mjs create --booking 14:00 --before 10 --after 30
node switchbot.mjs create --type disposable --minutes 15   # 1回だけ使えるコード
```

**確かめたいこと**
- 有効期間 **前** にコードを入れても開かないか
- 有効期間 **後** に開かないか（終了時刻を 2〜3 分後にして待つと早い）
- `disposable` は 2 回目で開かないか

### ⑤ 削除

```sh
node switchbot.mjs devices          # keyList の id を見る
node switchbot.mjs delete <id>
```

`deleteKey` も非同期。数秒後に `devices` で消えていれば OK。**実験で作ったコードは必ず消す。**

### ⑥（任意）Webhook で非同期結果を受け取ってみる

[webhook.site](https://webhook.site) などで一時 URL を作り:

```sh
node switchbot.mjs webhook https://webhook.site/xxxxxxxx
node switchbot.mjs create --minutes 10
# → webhook.site に eventName=createKey, result=success|failed|timeout, commandId=... が届く
node switchbot.mjs webhook --delete https://webhook.site/xxxxxxxx
```

⚠️ SwitchBot の Webhook URL は **アカウントに 1 本**。実験用 URL を残したままだと、後で TSURU. 本番の Webhook が登録できない／上書きになる。**必ず削除して終わる。**

## 3. その他のコマンド

```sh
node switchbot.mjs status <deviceId>     # ロックなら lockState / doorState / battery / calibrate
node switchbot.mjs unlock                # ロックを直接解錠（API 疎通の確認用）
node switchbot.mjs lock
node switchbot.mjs --help
```

## 4. 分かっていること（TSURU. 側の現状）

tsuru-prod の Supabase を見た結果（2026-10-06 時点）:

- 入退室用のテーブルは **2026-09-25 に本番適用済み**（マイグレーション `access_control`）
  - `access_control_settings` … テナントごとに SwitchBot の api_token / api_secret、lock_device_id、keypad_device_id、keypad_device_type、enabled、before_min(5)、after_min(19)、webhook_path_token、webhook_registered_at、fallback_message
  - `access_passcodes` … booking_id / customer_id / code / key_name / switchbot_key_id / status（既定 `creating`）/ is_test / valid_from / valid_to / command_id / error / notified_at / unlocked_at / deleted_at
  - `access_events` … Webhook 受信ログ（device_type / device_mac / event_name / result / lock_state / command_id / payload）
  - `box_devices` … 「店舗Box」が 1 台登録済み（last_seen_at は空＝未稼働）
- **CLOVER. テナントの `access_control_settings` は 0 行**。つまり設計と実装は入っているが、CLOVER. ではまだ設定も試験もされていない。
- CLOVER. テナント ID: `70b9149d-fa56-4e64-97c2-eda7cbe5087c`

この実験で取れる **deviceId と反映秒数** が、TSURU. 側の設定投入（管理画面の入退室設定、なければ `access_control_settings` への 1 行）に直結する。

## 5. 実験後のメモ欄

| 項目 | 値 |
|---|---|
| ロック deviceId / deviceType | |
| キーパッド deviceId / deviceType | |
| createKey → keyList 反映までの秒数（3 回） | |
| 有効期間前に開かない | |
| 有効期間後に開かない | |
| disposable が 2 回目で開かない | |
| Webhook の result と到着までの秒数 | |

## 6. 実験結果（2026-10-06 12:40 JST ごろ、ゆうじのMacから）

| 項目 | 値 |
|---|---|
| ロック | `B0E9FE90C96E` CLOVER.玄関（上） / Smart Lock Ultra / ハブ 玄関ハブミニ `EE433668E974` |
| キーパッド | `EB4833E1F997` 指紋認証パッド 97 / **Keypad Touch** / ハブ ルーム1 `F3BA87807709` / lockDeviceId = 上のロック |
| 既存キー | 会員の permanent コード 17 件（id 11〜31） |
| createKey 応答 | `{"statusCode":100,"body":{},"message":"success"}` — **commandId が返らなかった**（公式ドキュメントの例と違う） |
| 反映 | 直後の devices 取得で `id=14 timeLimit normal TSURU-test-1` が既に出ていた（体感 10 秒以内） |
| 実機解錠 | 未確認（店舗不在のため）。次回店舗で同じ手順を再実行して確認 |
| deleteKey | `{"id":14}` で `statusCode:100`、直後の devices で TSURU-test-1 が消えていた（こちらも数秒で反映、commandId なし） |

**TSURU. 実装への示唆**
- `access_passcodes.command_id` は null になり得る。Webhook の結果と突き合わせるキーは **key_name（一意な名前）** にすべき。
- 反映は速い。発行 → 数秒待って devices で keyList を確認 → 出ていれば LINE 送信、で十分。Webhook は保険。
- 同じ SwitchBot アカウントに別拠点（玄関ロック＋顔認証パッド、クラウド OFF）もあるため、deviceId は必ず固定で持つ（自動検出しない）。
