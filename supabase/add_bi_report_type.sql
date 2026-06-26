-- 経営レポート格納テーブル management_reports に「経営分析BI(bi)」種別を追加。
--
-- 新タブ「経営分析」で PowerBI移行ダッシュボード（自己完結HTML）を iframe 表示するため、
-- report_type='bi' を許可する。これが無いと BIダッシュボードのアップロード(upsert)が
-- CHECK 制約で弾かれる。
--
-- 閲覧RLS(read_mgmt)は既に admin/executive/accounting（add_accounting_role.sql）。
-- 書込は admin のみ（既存ポリシーのまま）。よって本ファイルは CHECK 制約のみ更新。
--
-- 使い方：Supabase SQL Editor に全文貼り付け → Run（admin で）。冪等（drop→add）。
-- 前提：phaseE3_management_reports.sql / phaseE3b_annual_report_type.sql 実行済み。

alter table public.management_reports drop constraint if exists management_reports_report_type_check;
alter table public.management_reports add constraint management_reports_report_type_check
  check (report_type in ('annual', 'analysis', 'rf', 'bi'));

-- 確認：制約定義に 'bi' が含まれていればOK
select conname, pg_get_constraintdef(oid) as def
from pg_constraint
where conrelid = 'public.management_reports'::regclass and contype = 'c';
