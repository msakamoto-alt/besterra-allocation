-- Point2: アカウント（user_roles）に社員番号 emp_no を追加
--
-- 目的：工事監督アカウントを社員（organization の emp_no）に紐付け、ログイン時に
--       本人の監督ダッシュボードへ着地させるためのキー。
-- 権限：本人は ur_read_self ポリシーで自分の行（emp_no 含む）を読める。
--       書込は Edge Function admin-users（service_role・admin検証あり）経由のみ。
-- 使い方：Supabase SQL Editor に貼り付け → Run（admin で）。冪等。
--       実行後、Edge Function「admin-users」を再デプロイ（emp_no 対応版）。

alter table public.user_roles add column if not exists emp_no text;
