/**
 * config.example.js - 設定値テンプレート
 *
 * このファイルをコピーして config.js を作成し、各値を設定してください。
 *
 * - SHEET_ID: Google Sheets の ID。閲覧用（読み取り）
 *   URL: https://docs.google.com/spreadsheets/d/【ここがSHEET_ID】/edit
 *
 * - OVERRIDE_API_URL: Apps Script Web App の URL（配属期間 overrides 書込口）
 *   Apps Script からデプロイ後の URL（https://script.google.com/macros/s/.../exec）を貼る
 *
 * - OVERRIDE_TOKEN: Apps Script の SHARED_TOKEN と一致させる（書込み認証）
 */

Sync.SHEET_ID = 'YOUR_SHEET_ID_HERE';

Sync.OVERRIDE_API_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';
Sync.OVERRIDE_TOKEN = 'YOUR_SHARED_TOKEN_32CHARS';
