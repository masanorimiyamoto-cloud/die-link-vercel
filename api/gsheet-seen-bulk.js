// api/gsheet-seen-bulk.js  (ESM)
import { google } from "googleapis";
import fs from "node:fs";

const GOOGLE_SA_FILE = process.env.GOOGLE_SA_FILE || "";
const GOOGLE_SA_JSON = process.env.GOOGLE_SA_JSON || "";
const GS_SPREADSHEET_NAME = process.env.GS_SPREADSHEET_NAME || "AirtableTest129";
const GS_WORKSHEET_NAME   = process.env.GS_WORKSHEET_NAME   || "wsTableCD";

// ---- SA 認証（GOOGLE_SA_JSON 優先、無ければ GOOGLE_SA_FILE）
function getServiceAccount() {
  if (GOOGLE_SA_JSON) return JSON.parse(GOOGLE_SA_JSON);
  if (GOOGLE_SA_FILE) {
    const raw = fs.readFileSync(GOOGLE_SA_FILE, "utf8");
    return JSON.parse(raw);
  }
  throw new Error("Missing GOOGLE_SA_JSON / GOOGLE_SA_FILE");
}

async function getSheetsClient() {
  const sa = getServiceAccount();
  const scopes = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
  ];
  const auth = new google.auth.JWT(sa.client_email, null, sa.private_key, scopes);
  await auth.authorize();
  const sheets = google.sheets({ version: "v4", auth });
  const drive  = google.drive({ version: "v3", auth });
  return { sheets, drive };
}

async function findSpreadsheetIdByName(drive, name) {
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
  const { data } = await drive.files.list({ q, fields: "files(id,name)", pageSize: 10 });
  if (!data.files?.length) throw new Error(`Spreadsheet not found: ${name}`);
  return data.files[0].id; // 同名が複数あれば先頭
}

function key(wc, book) {
  return `${String(wc || "").trim()}||${String(book || "").trim()}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "no items" });

    const { sheets, drive } = await getSheetsClient();
    const spreadsheetId = await findSpreadsheetIdByName(drive, GS_SPREADSHEET_NAME);

    // 既存データ取得：A〜I を読み取り（A:WorkCord, B:WorkName, C:BookName, H:Location, I:LastSeen）
    const getResp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${GS_WORKSHEET_NAME}!A2:I`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = getResp.data.values || [];

    // index: key(A,C) -> row number（ヘッダー込みの実行行番号）
    const idx = new Map();
    rows.forEach((r, i) => {
      const wc = r[0] ?? "";  // A
      const bn = r[2] ?? "";  // C
      idx.set(key(wc, bn), i + 2); // +2: 1行目ヘッダー、配列0始まり
    });

    // 仕分け
    const updates = []; // { range, values: [[...]] }  // B/H/I を個別に更新
    const appends = []; // [[A..I]]

    for (const it of items) {
      const book = String(it.book || "").trim();       // BookName -> C列
      const wc   = String(it.wc   || "").trim();       // WorkCord -> A列
      const wn   = String(it.wn   || "").trim();       // WorkName -> B列（無ければ既存保持）
      const loc  = String(it.loc  || "").trim();       // Location -> H列
      const seen = String(it.captured_at || new Date().toISOString()); // LastSeen -> I列

      if (!book || !wc) continue; // キー不足はスキップ

      const k = key(wc, book);
      const rowNum = idx.get(k);

      if (rowNum) {
        // 既存行：B(WorkName)は来ていれば更新、H(Location)/I(LastSeen)は更新
        if (wn) {
          updates.push({ range: `${GS_WORKSHEET_NAME}!B${rowNum}:B${rowNum}`, values: [[wn]] });
        }
        updates.push({ range: `${GS_WORKSHEET_NAME}!I${rowNum}:I${rowNum}`, values: [[loc]] });
        updates.push({ range: `${GS_WORKSHEET_NAME}!J${rowNum}:J${rowNum}`, values: [[seen]] });
      } else {
        // 追加行：A,B,C, (D,E,F,G 空白), I,J
        appends.push([ wc, wn, book, "", "", "", "", loc, seen ]);
      }
    }

    // 反映
    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "RAW", data: updates },
      });
    }
    if (appends.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${GS_WORKSHEET_NAME}!A:I`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: appends },
      });
    }

    return res.status(200).json({ ok: true, updatedCells: updates.length, appendedRows: appends.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "server-error" });
  }
}
