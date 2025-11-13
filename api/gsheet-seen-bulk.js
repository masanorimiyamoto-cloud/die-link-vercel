// api/gsheet-seen-bulk.js  (ESM, Node Serverless 用)
// Google Sheets に Location / LastSeen をまとめて書き込む
// - 既存行: B(WorkName 任意)、I(Location), J(LastSeen) を更新
// - 新規行: A..J までまとめて追加
//
// 依存:
//   - 環境変数:
//       GS_SPREADSHEET_ID   : 対象スプレッドシートID  (/d/xxxxx/edit の xxxxx 部分)
//       GS_WORKSHEET_NAME   : ワークシート名 (例: wsTableCD)
//       GOOGLE_SA_JSON      : サービスアカウント JSON 全文
//
//   - Node v18+ (fetch, crypto 利用)

import crypto from "node:crypto";

const GS_SPREADSHEET_ID = process.env.GS_SPREADSHEET_ID || "";
const GS_WORKSHEET_NAME = process.env.GS_WORKSHEET_NAME || "wsTableCD";
const SA_JSON            = process.env.GOOGLE_SA_JSON || "";

if (!GS_SPREADSHEET_ID) {
  console.warn("[gsheet-seen-bulk] ⚠ GS_SPREADSHEET_ID が未設定です");
}
if (!SA_JSON) {
  console.warn("[gsheet-seen-bulk] ⚠ GOOGLE_SA_JSON が未設定です");
}

// ---- key 作成用ユーティリティ（base64url） ----
function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function utf8ToBase64Url(str) {
  return base64UrlEncode(Buffer.from(str, "utf8"));
}

// ---- サービスアカウント読み込み ----
function getServiceAccount() {
  if (!SA_JSON) {
    throw new Error("GOOGLE_SA_JSON が未設定です");
  }
  let sa;
  try {
    sa = JSON.parse(SA_JSON);
  } catch (e) {
    console.error("[gsheet-seen-bulk] GOOGLE_SA_JSON parse error:", e);
    throw new Error("GOOGLE_SA_JSON が不正な JSON です");
  }
  if (!sa.client_email || !sa.private_key) {
    console.error("[gsheet-seen-bulk] SA keys:", Object.keys(sa));
    throw new Error(
      "サービスアカウント JSON に client_email / private_key が含まれていません"
    );
  }
  return sa;
}

// ---- サービスアカウントで Google OAuth トークン取得 ----
async function getGoogleAccessToken() {
  const svc = getServiceAccount();

  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: svc.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = utf8ToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payloadB64 = utf8ToBase64Url(JSON.stringify(claim));
  const unsigned = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  sign.end();
  const signature = sign.sign(svc.private_key);
  const sigB64 = base64UrlEncode(signature);

  const jwt = `${unsigned}.${sigB64}`;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(
      `Google token error ${r.status} ${text.slice(0, 300)}`
    );
  }
  const j = await r.json();
  return j.access_token;
}

// ---- Sheets API ラッパ ----
async function sheetsValuesGet(rangeA1) {
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GS_SPREADSHEET_ID}/values/${encodeURIComponent(
    rangeA1
  )}?valueRenderOption=UNFORMATTED_VALUE`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(
      `Sheets values.get error ${r.status} ${t.slice(0, 300)}`
    );
  }
  return r.json();
}

async function sheetsValuesBatchUpdate(data) {
  if (!data.length) return;
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GS_SPREADSHEET_ID}/values:batchUpdate`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "RAW",
      data,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(
      `Sheets batchUpdate error ${r.status} ${t.slice(0, 300)}`
    );
  }
  return r.json();
}

async function sheetsValuesAppend(values) {
  if (!values.length) return;
  const token = await getGoogleAccessToken();
  const range = `${GS_WORKSHEET_NAME}!A:J`; // A〜J まで追加

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GS_SPREADSHEET_ID}/values/${encodeURIComponent(
    range
  )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ values }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(
      `Sheets append error ${r.status} ${t.slice(0, 300)}`
    );
  }
  return r.json();
}

// ---- ユーティリティ ----
function key(wc, book) {
  return `${String(wc || "").trim()}||${String(book || "").trim()}`;
}

// ========================
// メインハンドラ
// ========================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: "no items" });
    }
    if (!GS_SPREADSHEET_ID) {
      return res
        .status(500)
        .json({ error: "GS_SPREADSHEET_ID not set in env" });
    }

    // 1) 現在のシート内容を取得 (A2:J…)
    const getResp = await sheetsValuesGet(
      `${GS_WORKSHEET_NAME}!A2:J`
    );
    const rows = getResp.values || [];

    // index: key(A,C) -> row number（ヘッダー込みの行番号）
    const idx = new Map();
    rows.forEach((r, i) => {
      const wc = r[0] ?? ""; // A: WorkCord
      const bn = r[2] ?? ""; // C: BookName
      idx.set(key(wc, bn), i + 2); // 1行目ヘッダー + 配列0始まり
    });

    const updates = []; // { range, values: [[...]] }
    const appends = []; // [[A..J]]

    const now = new Date();
    const captured_date = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    for (const it of items) {
      const book = String(it.book || "").trim(); // C
      const wc = String(it.wc || "").trim(); // A
      const wn = String(it.wn || "").trim(); // B
      const loc = String(it.loc || "").trim(); // I
      const seen = String(it.captured_at || captured_date); // J

      if (!book || !wc) continue;

      const k = key(wc, book);
      const rowNum = idx.get(k);

      if (rowNum) {
        // 既存行更新
        if (wn) {
          updates.push({
            range: `${GS_WORKSHEET_NAME}!B${rowNum}:B${rowNum}`,
            values: [[wn]],
          });
        }
        // I: Location
        updates.push({
          range: `${GS_WORKSHEET_NAME}!I${rowNum}:I${rowNum}`,
          values: [[loc]],
        });
        // J: LastSeen
        updates.push({
          range: `${GS_WORKSHEET_NAME}!J${rowNum}:J${rowNum}`,
          values: [[seen]],
        });
      } else {
        // 新規行 A..J
        // [A:wc, B:wn, C:book, D,E,F,G,H:空, I:loc, J:seen]
        appends.push([wc, wn, book, "", "", "", "", "", loc, seen]);
      }
    }

    // 2) 反映
    if (updates.length) {
      await sheetsValuesBatchUpdate(updates);
    }
    if (appends.length) {
      await sheetsValuesAppend(appends);
    }

    return res.status(200).json({
      ok: true,
      updatedCells: updates.length,
      appendedRows: appends.length,
    });
  } catch (e) {
    console.error("[gsheet-seen-bulk] ERROR:", e);
    return res
      .status(500)
      .json({ error: e.message || "server-error" });
  }
}
