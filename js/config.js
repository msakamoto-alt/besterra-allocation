/**
 * config.js - 連携設定
 *
 * SHEET_ID: Google Sheets の ID。読取は Supabase に移行済みだが、
 *   管理者の「同期」ボタン（syncReferenceFromSheets）が Sheets からの取込に使用する。
 *   共有設定が「リンクを知っている全員 - 閲覧者」のためコミット許容
 *   （書込・編集は Supabase Auth + RLS で保護）。
 *
 * ※旧GAS(Apps Script)書込口 OVERRIDE_API_URL / OVERRIDE_TOKEN は
 *   2026-07 刷新で削除（書込は Supabase に完全移行済み）。
 */

Sync.SHEET_ID = '1f1OBRkX4UG1BQqBCf196dTuoiGKin-WPcXOpHrE0rhA';

// ===== Supabase =====
// 読み込み・書き込みとも Supabase（RLS 有効・書込は authenticated のみ）。
Sync.SUPABASE_URL = 'https://pajmsowweswaxowrbiwr.supabase.co';
Sync.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBham1zb3d3ZXN3YXhvd3JiaXdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNTYxMDksImV4cCI6MjA5NDgzMjEwOX0.I9yFO1GXwUR8i4ScnZdduk812LulAVAtOcy2n_lOpz8';
Sync.USE_SUPABASE = true;

// アカウント管理 Edge Function の実デプロイ名（ダッシュボードが付けた名前に合わせる）
Sync.ADMIN_FN = 'admin-users';
