-- 段階B: RLS（行レベルセキュリティ）有効化 + ポリシー
--
-- 方針：
--   - 読み取り(SELECT)は anon(閲覧者・ログイン不要) と authenticated(編集者) の両方に許可
--   - 書き込み(INSERT/UPDATE/DELETE)は authenticated(編集ログイン済み) のみ許可
--     → JSを改ざんして編集ボタンを出しても、ログインしていなければ書込はDBで拒否される
--   - employees / salesforce_imports / g_work_logs はアプリから書かない（読取専用・書込ポリシー無し）
--     ※ これらのデータ更新は管理者がローカルで service_role キーを使って実行（段階C）
--
-- 使い方：SQL Editor に貼り付け → Run。段階A の phaseA_rls_off.sql を上書きする位置づけ。

-- ===== 1. RLS 有効化 =====
alter table public.employees                enable row level security;
alter table public.salesforce_imports       enable row level security;
alter table public.prospects                enable row level security;
alter table public.assignment_overrides     enable row level security;
alter table public.g_work_logs              enable row level security;
alter table public.project_status_overrides enable row level security;

-- ===== 2. 読み取り：全テーブル anon + authenticated に SELECT 許可 =====
drop policy if exists read_all_employees  on public.employees;
drop policy if exists read_all_salesforce on public.salesforce_imports;
drop policy if exists read_all_prospects  on public.prospects;
drop policy if exists read_all_overrides  on public.assignment_overrides;
drop policy if exists read_all_glogs      on public.g_work_logs;
drop policy if exists read_all_status     on public.project_status_overrides;

create policy read_all_employees  on public.employees                for select to anon, authenticated using (true);
create policy read_all_salesforce on public.salesforce_imports       for select to anon, authenticated using (true);
create policy read_all_prospects  on public.prospects                for select to anon, authenticated using (true);
create policy read_all_overrides  on public.assignment_overrides     for select to anon, authenticated using (true);
create policy read_all_glogs      on public.g_work_logs              for select to anon, authenticated using (true);
create policy read_all_status     on public.project_status_overrides for select to anon, authenticated using (true);

-- ===== 3. 書き込み：編集対象3テーブルのみ authenticated に INSERT/UPDATE/DELETE 許可 =====
-- prospects
drop policy if exists write_prospects_ins on public.prospects;
drop policy if exists write_prospects_upd on public.prospects;
drop policy if exists write_prospects_del on public.prospects;
create policy write_prospects_ins on public.prospects for insert to authenticated with check (true);
create policy write_prospects_upd on public.prospects for update to authenticated using (true) with check (true);
create policy write_prospects_del on public.prospects for delete to authenticated using (true);

-- assignment_overrides
drop policy if exists write_overrides_ins on public.assignment_overrides;
drop policy if exists write_overrides_upd on public.assignment_overrides;
drop policy if exists write_overrides_del on public.assignment_overrides;
create policy write_overrides_ins on public.assignment_overrides for insert to authenticated with check (true);
create policy write_overrides_upd on public.assignment_overrides for update to authenticated using (true) with check (true);
create policy write_overrides_del on public.assignment_overrides for delete to authenticated using (true);

-- project_status_overrides
drop policy if exists write_status_ins on public.project_status_overrides;
drop policy if exists write_status_upd on public.project_status_overrides;
drop policy if exists write_status_del on public.project_status_overrides;
create policy write_status_ins on public.project_status_overrides for insert to authenticated with check (true);
create policy write_status_upd on public.project_status_overrides for update to authenticated using (true) with check (true);
create policy write_status_del on public.project_status_overrides for delete to authenticated using (true);
