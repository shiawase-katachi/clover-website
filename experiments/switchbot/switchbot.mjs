#!/usr/bin/env node
// SwitchBot API v1.1 を直接叩いて、CLOVER. の入室用ワンタイム暗証番号を発行する実験用スクリプト。
// 依存パッケージなし（Node 18 以上）。TSURU. 本体には触らず、API の挙動だけを確認する。
//
//   node switchbot.mjs devices                   デバイス一覧（ロック／キーパッドを強調、登録済みキー一覧も表示）
//   node switchbot.mjs status <deviceId>          デバイスの状態
//   node switchbot.mjs create [options]           キーパッドに期間限定の暗証番号を発行し、反映されるまで監視
//   node switchbot.mjs delete <keyId> [--keypad ID]  暗証番号を削除
//   node switchbot.mjs unlock | lock [--lock ID]  ロックを解錠／施錠（動作確認用）
//   node switchbot.mjs webhook                    登録済み Webhook URL を表示
//   node switchbot.mjs webhook <url>              Webhook URL を登録（createKey の非同期結果を受け取る）
//   node switchbot.mjs webhook --delete <url>     Webhook URL を削除
//
// create のオプション
//   --minutes N        今から N 分間有効（既定 30）
//   --booking HH:MM    予約開始時刻を指定。TSURU. の既定（前 5 分〜後 19 分）で有効期間を組む
//   --before N / --after N   --booking と併用。前後の分数を変える（既定 5 / 19）
//   --code 123456      暗証番号を指定（6〜12 桁）。省略時は 6 桁をランダム生成
//   --name NAME        キー名（同じキーパッド内で重複不可）。省略時は TSURU-test-HHMM
//   --type timeLimit|disposable   既定 timeLimit（期間内なら何度でも）。disposable は 1 回限り
//   --keypad ID        キーパッドの deviceId。省略時は一覧から自動検出（1 台のときのみ）
//   --no-wait          発行後の反映監視をしない
//
// 認証情報は環境変数 SWITCHBOT_TOKEN / SWITCHBOT_SECRET、または同じフォルダの .env から読む。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SWITCHBOT_BASE ?? "https://api.switch-bot.com/v1.1"; // SWITCHBOT_BASE はモックテスト用
const JST = "Asia/Tokyo";

// ---------- 認証情報 ----------
function loadEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.join(here, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const token = process.env.SWITCHBOT_TOKEN;
  const secret = process.env.SWITCHBOT_SECRET;
  if (!token || !secret) {
    die(
      "SWITCHBOT_TOKEN と SWITCHBOT_SECRET が未設定です。\n" +
        "SwitchBot アプリ → プロフィール → 設定 → アプリバージョンを10回タップ → 開発者向けオプション で取得し、\n" +
        `${envPath} に書くか、環境変数で渡してください（.env.example 参照）。`
    );
  }
  return { token, secret };
}

// ---------- 署名付きリクエスト ----------
function authHeaders({ token, secret }) {
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const sign = crypto
    .createHmac("sha256", secret)
    .update(token + t + nonce)
    .digest("base64")
    .toUpperCase();
  return { Authorization: token, sign, t, nonce, "Content-Type": "application/json; charset=utf8" };
}

async function api(creds, method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: authHeaders(creds),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    die(`HTTP ${res.status} ${method} ${p}\n${text}`);
  }
  if (res.status !== 200 || json.statusCode !== 100) {
    const hint = STATUS_HINTS[json.statusCode] ?? "";
    die(`API error ${method} ${p}\nHTTP ${res.status} statusCode=${json.statusCode} message=${json.message} ${hint}\n${JSON.stringify(json, null, 2)}`);
  }
  return json.body;
}

const STATUS_HINTS = {
  151: "(device type error: このデバイスはそのコマンドに対応していない)",
  152: "(device not found: deviceId を確認)",
  160: "(command not supported)",
  161: "(device offline: ハブ経由でクラウドに繋がっているか確認)",
  171: "(hub offline)",
  190: "(internal error / パラメータ不正: 暗証番号の桁数・時刻・名前の重複を確認)",
  401: "(認証失敗: token/secret、端末の時刻ずれを確認)",
};

// ---------- 表示ユーティリティ ----------
function die(msg) {
  console.error("\n✖ " + msg);
  process.exit(1);
}
function jst(unixSec) {
  return new Date(unixSec * 1000).toLocaleString("ja-JP", { timeZone: JST, hour12: false });
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? "");
  if (!m) die(`時刻は HH:MM 形式で指定してください: ${s}`);
  // 今日の JST でその時刻の Unix 秒を求める
  const now = new Date();
  const ymd = now.toLocaleDateString("en-CA", { timeZone: JST }); // YYYY-MM-DD
  return Math.floor(new Date(`${ymd}T${m[1].padStart(2, "0")}:${m[2]}:00+09:00`).getTime() / 1000);
}
function isLock(d) {
  return /lock/i.test(d.deviceType ?? "");
}
function isKeypad(d) {
  return /keypad/i.test(d.deviceType ?? "");
}
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else opts[key] = true;
    } else opts._.push(a);
  }
  return opts;
}

// ---------- デバイス ----------
async function listDevices(creds) {
  const body = await api(creds, "GET", "/devices");
  return body.deviceList ?? [];
}

async function pickDevice(creds, opts, kind) {
  const explicit = opts[kind];
  if (explicit) return { deviceId: explicit, deviceType: kind, deviceName: "(指定)" };
  const devices = await listDevices(creds);
  const matches = devices.filter(kind === "keypad" ? isKeypad : isLock);
  if (matches.length === 0) die(`${kind} が見つかりません。'devices' で一覧を確認し --${kind} <deviceId> で指定してください。`);
  if (matches.length > 1)
    die(`${kind} が複数あります。--${kind} <deviceId> で指定してください:\n` + matches.map((d) => `  ${d.deviceId}  ${d.deviceType}  ${d.deviceName}`).join("\n"));
  return matches[0];
}

// ---------- コマンド実装 ----------
async function cmdDevices(creds) {
  const devices = await listDevices(creds);
  if (devices.length === 0) {
    console.log("デバイスがありません（アプリ側でクラウドサービスが ON になっているか確認）");
    return;
  }
  console.log(`デバイス ${devices.length} 台\n`);
  for (const d of devices) {
    const mark = isLock(d) ? "🔒" : isKeypad(d) ? "🔢" : "  ";
    console.log(`${mark} ${d.deviceId}  ${d.deviceType.padEnd(18)} ${d.deviceName}  cloud=${d.enableCloudService} hub=${d.hubDeviceId ?? "-"}`);
    if (isKeypad(d)) {
      if (d.lockDeviceId) console.log(`     └ 紐付くロック: ${d.lockDeviceId}`);
      const keys = d.keyList ?? [];
      console.log(`     └ 登録済みキー ${keys.length} 件`);
      for (const k of keys) {
        console.log(`        id=${k.id}  ${String(k.type).padEnd(10)} status=${k.status}  name=${k.name}  created=${k.createTime ? jst(Math.floor(k.createTime / 1000)) : "-"}`);
      }
    }
  }
  console.log("\n次: node switchbot.mjs create --minutes 30   （キーパッドにテスト用の暗証番号を発行）");
}

async function cmdStatus(creds, opts) {
  const id = opts._[1];
  if (!id) die("使い方: status <deviceId>");
  const body = await api(creds, "GET", `/devices/${id}/status`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdCreate(creds, opts) {
  const keypad = await pickDevice(creds, opts, "keypad");

  // 有効期間
  const before = Number(opts.before ?? 5);
  const after = Number(opts.after ?? 19);
  let start, end, label;
  if (opts.booking) {
    const at = parseHHMM(opts.booking);
    start = at - before * 60;
    end = at + after * 60;
    label = `予約 ${opts.booking} の ${before} 分前〜 ${after} 分後`;
  } else {
    const minutes = Number(opts.minutes ?? 30);
    start = nowSec() - 60; // 端末との時計ずれを吸収するため 1 分前から
    end = nowSec() + minutes * 60;
    label = `今から ${minutes} 分間`;
  }
  if (end <= nowSec()) die("有効期間がすでに終わっています（--booking の時刻を確認）");

  // 暗証番号・名前・種別
  const code = String(opts.code ?? String(Math.floor(100000 + Math.random() * 900000)));
  if (!/^\d{6,12}$/.test(code)) die("暗証番号は 6〜12 桁の数字で指定してください");
  const hhmm = new Date().toLocaleTimeString("ja-JP", { timeZone: JST, hour12: false, hour: "2-digit", minute: "2-digit" }).replace(":", "");
  const name = String(opts.name ?? `TSURU-test-${hhmm}`);
  const type = String(opts.type ?? "timeLimit");
  if (!["timeLimit", "disposable"].includes(type)) die("--type は timeLimit か disposable");

  console.log("── 発行内容 ──────────────────────────");
  console.log(`キーパッド : ${keypad.deviceId} (${keypad.deviceType} ${keypad.deviceName})`);
  console.log(`キー名     : ${name}`);
  console.log(`種別       : ${type}`);
  console.log(`暗証番号   : ${code}`);
  console.log(`有効期間   : ${jst(start)} 〜 ${jst(end)}  (${label})`);
  console.log("──────────────────────────────────────");

  const t0 = Date.now();
  const body = await api(creds, "POST", `/devices/${keypad.deviceId}/commands`, {
    commandType: "command",
    command: "createKey",
    parameter: { name, type, password: code, startTime: start, endTime: end },
  });
  const commandId = body?.commandId ?? "(なし)";
  console.log(`\n✔ createKey 受付  commandId=${commandId}  (${Date.now() - t0}ms)`);
  console.log("  ※ createKey は非同期。この時点ではまだキーパッドに書き込まれていない。");
  console.log("    結果は Webhook（eventName=createKey, result=success|failed|timeout）で届く。");
  console.log("    Webhook を登録していない場合は、下の監視でデバイス一覧の keyList に出るのを待つ。");

  if (opts["no-wait"]) return;

  // 反映監視: keyList に name が現れるまでポーリング（最大 90 秒）
  console.log("\n⏳ キーパッドへの反映を監視中（最大 90 秒）…");
  const deadline = Date.now() + 90_000;
  let found;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const devices = await listDevices(creds);
    const kp = devices.find((d) => d.deviceId === keypad.deviceId);
    found = (kp?.keyList ?? []).find((k) => k.name === name);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (found) {
      console.log(`✔ ${elapsed} 秒で反映: keyId=${found.id} status=${found.status} type=${found.type}`);
      break;
    }
    console.log(`  … ${elapsed} 秒経過、まだ keyList に出ていない`);
  }
  if (!found) {
    console.log("✖ 90 秒以内に keyList に現れませんでした。Webhook の結果（failed/timeout）か、ハブ⇄キーパッドの BLE 到達性を確認してください。");
    return;
  }
  console.log(`\n▶ 店の外に出て、キーパッドに「${code}」＋確定（✓/🔓）を入力 → 解錠されるか確認。`);
  console.log(`▶ 終わったら:  node switchbot.mjs delete ${found.id}`);
}

async function cmdDelete(creds, opts) {
  const id = Number(opts._[1]);
  if (!Number.isInteger(id)) die("使い方: delete <keyId>（devices で表示される keyList の id）");
  const keypad = await pickDevice(creds, opts, "keypad");
  const body = await api(creds, "POST", `/devices/${keypad.deviceId}/commands`, {
    commandType: "command",
    command: "deleteKey",
    parameter: { id },
  });
  console.log(`✔ deleteKey 受付 commandId=${body?.commandId ?? "(なし)"}（非同期。少し待って devices で消えたか確認）`);
}

async function cmdLockUnlock(creds, opts, command) {
  const lock = await pickDevice(creds, opts, "lock");
  const body = await api(creds, "POST", `/devices/${lock.deviceId}/commands`, {
    commandType: "command",
    command,
    parameter: "default",
  });
  console.log(`✔ ${command} 送信 → ${lock.deviceId} (${lock.deviceName})  commandId=${body?.commandId ?? "(なし)"}`);
}

async function cmdWebhook(creds, opts) {
  if (opts.delete) {
    const url = typeof opts.delete === "string" ? opts.delete : opts._[1];
    if (!url) die("使い方: webhook --delete <url>");
    await api(creds, "POST", "/webhook/deleteWebhook", { action: "deleteWebhook", url });
    console.log(`✔ Webhook 削除: ${url}`);
    return;
  }
  const url = opts._[1];
  if (url) {
    await api(creds, "POST", "/webhook/setupWebhook", { action: "setupWebhook", url, deviceList: "ALL" });
    console.log(`✔ Webhook 登録: ${url}`);
    console.log("  ※ SwitchBot の Webhook URL はアカウントに 1 本だけ。TSURU. 本番の URL を登録する前に、この実験用 URL は削除すること。");
  }
  const q = await api(creds, "POST", "/webhook/queryWebhook", { action: "queryUrl" });
  const urls = q?.urls ?? [];
  console.log(`登録済み Webhook URL ${urls.length} 件`);
  for (const u of urls) console.log("  " + u);
  if (urls.length) {
    const d = await api(creds, "POST", "/webhook/queryWebhook", { action: "queryDetails", urls });
    console.log(JSON.stringify(d, null, 2));
  }
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (!cmd || opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    return;
  }
  const creds = loadEnv();
  switch (cmd) {
    case "devices":
      return cmdDevices(creds);
    case "status":
      return cmdStatus(creds, opts);
    case "create":
      return cmdCreate(creds, opts);
    case "delete":
      return cmdDelete(creds, opts);
    case "unlock":
    case "lock":
      return cmdLockUnlock(creds, opts, cmd);
    case "webhook":
      return cmdWebhook(creds, opts);
    default:
      die(`不明なコマンド: ${cmd}（--help で使い方）`);
  }
}

main().catch((e) => die(e?.stack ?? String(e)));
