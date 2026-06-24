-- 経理ロール（accounting）の追加。権限＝経営レポート〜見込み案件の「閲覧のみ」（編集なし）。
--
-- 既存の本番DBに対する移行（冪等・再実行可）。実行内容は2つ：
--   1) user_roles.role の CHECK 制約に 'accounting' を許可
--   2) management_reports の SELECT(read_mgmt) を admin/executive に加え accounting も許可
--      （経営レポートは RLS で閲覧ロールをサーバー強制しているため、ここを開けないと経理は読めない）
--
-- ※ その他のテーブル（organization/projects/assignment_overrides/prospects 等）は
--   E1b で「authenticated は SELECT 可」になっているため、経理は追加設定なしで閲覧できる。
-- ※ 編集権は付与しない（運用系の書込ポリシーは admin/editor のまま・accounting は含めない）。
--
-- 使い方：Supabase ダッシュボード → SQL Editor に貼り付け → Run。
-- 前提：phaseE1a_roles.sql / phaseE3_management_reports.sql 実行済み。

-- 1) user_roles の role CHECK に accounting を追加
alter table public.user_roles drop constraint if exists user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check
  check (role in ('admin','editor','executive','manager','viewer','accounting'));

-- 2) 経営レポートの閲覧ロールに accounting を追加（書込は admin のまま）
drop policy if exists read_mgmt on public.management_reports;
create policy read_mgmt on public.management_reports
  for select to authenticated
  using (app_role() in ('admin', 'executive', 'accounting'));
