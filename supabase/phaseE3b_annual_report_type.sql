-- 経営レポートに「年度経営分析(annual)」種別を追加するための制約更新
--
-- 既存：report_type は ('analysis','rf') のみ許可 → 'annual' を追加。
-- これが無いと 年度レポートのアップロード(insert/upsert)が CHECK 制約で弾かれる。
-- 使い方：Supabase SQL Editor に「全文」貼り付け → Run（admin で）。冪等（drop→add）。

alter table public.management_reports drop constraint if exists management_reports_report_type_check;
alter table public.management_reports add constraint management_reports_report_type_check
  check (report_type in ('annual', 'analysis', 'rf'));

-- 確認：制約定義に 'annual' が含まれていればOK
select conname, pg_get_constraintdef(oid) as def
from pg_constraint
where conrelid = 'public.management_reports'::regclass and contype = 'c';
