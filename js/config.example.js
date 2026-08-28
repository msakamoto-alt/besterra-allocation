/**
 * config.example.js - 連携設定のテンプレート
 *
 * このファイルを js/config.js にコピーして実値を設定する。
 * - SHEET_ID: Google Sheets の ID（管理者「同期」ボタンの取込元）
 *   URL: https://docs.google.com/spreadsheets/d/【ここがSHEET_ID】/edit
 * - SUPABASE_URL / SUPABASE_ANON_KEY: Supabaseプロジェクトの接続情報
 *   （Dashboard → Project Settings → API。anonキーはRLS前提で公開可）
 * - USE_SUPABASE: true でデータ読み書きをSupabaseに向ける（本番はtrue）
 * - ADMIN_FN: アカウント管理 Edge Function の実デプロイ名
 *
 * ※旧GAS(Apps Script)書込口 OVERRIDE_API_URL / OVERRIDE_TOKEN は
 *   2026-07 刷新で廃止（書込はSupabaseに完全移行済み）。
 */

Sync.SHEET_ID = 'YOUR_SHEET_ID_HERE';

Sync.SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
Sync.SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
Sync.USE_SUPABASE = true;

Sync.ADMIN_FN = 'admin-users';

// ===== 開発用の上書きは js/config.local.js（.gitignore済み）へ =====
// 例: 取引先管理タブだけ別のSupabaseプロジェクトに向ける（開発・検証用）
//   Sync.TORIHIKISAKI_DB = { url: 'https://YOUR_DEV_PROJECT.supabase.co', anonKey: 'YOUR_DEV_ANON_KEY' };
// 未設定なら本体と同じSupabaseを使う＝本番の形。
// 🔴 RLSを外した検証用DBのキーは config.js（追跡ファイル）に書かないこと。
