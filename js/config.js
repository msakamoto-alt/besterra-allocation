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
Sync.OVERRIDE_API_URL = 'https://script.google.com/macros/s/AKfycbxrvwMi6UAYX-xqXrU--gdg-ocJGHaXwpOX-ZlAg0KhQ-zPOoQ3VZLCVOfYOPYA_RyErg/exec';
Sync.OVERRIDE_TOKEN = 'oyh0oYNq5w7jaK7ssaIiTbXFhAJQ6Scb';
