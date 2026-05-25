/**
 * config.js - 連携設定
 *
 * Sheets共有設定が「リンクを知っている全員 - 閲覧者」のため、
 * SHEET_IDをコミットしても閲覧は許容される（HTML側パスワードで二重保護）。
 *
 * OVERRIDE_API_URL / OVERRIDE_TOKEN は配属期間の書き込み口（Apps Script）。
 * - URLとトークンは推測困難なランダム文字列で構成（実質的にこの2つが書込み認証）
 * - HTML側パスワードログイン後でないと UI からは送信できない
 * - Phase 2a で長谷部氏方式のクライアント暗号化に置換予定
 */

Sync.SHEET_ID = '1f1OBRkX4UG1BQqBCf196dTuoiGKin-WPcXOpHrE0rhA';

// Apps Script Web App（配属期間の overrides 書き込み口）
Sync.OVERRIDE_API_URL = 'https://script.google.com/macros/s/AKfycbzOQHyBWIN6BsA1aVWKWY6uJfjxhMsJ0A-CkNDRtBZNl39prXJBCz8Fa6NpqARlyfsO/exec';
Sync.OVERRIDE_TOKEN = 'oyh0oYNq5w7jaK7ssaIiTbXFhAJQ6Scb';

// ===== Supabase（段階A: 読み込み移行）=====
// USE_SUPABASE=true のとき、読み込みは gviz/Sheets ではなく Supabase から行う。
// 書き込み（編集・見込みCRUD等）は段階Bまで従来どおり Apps Script 経由のまま。
// ※ 段階A中は RLS 無効。RLS有効化（段階B）が済むまで GitHub に push しない。
Sync.SUPABASE_URL = 'https://pajmsowweswaxowrbiwr.supabase.co';
Sync.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBham1zb3d3ZXN3YXhvd3JiaXdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNTYxMDksImV4cCI6MjA5NDgzMjEwOX0.I9yFO1GXwUR8i4ScnZdduk812LulAVAtOcy2n_lOpz8';
Sync.USE_SUPABASE = true;
