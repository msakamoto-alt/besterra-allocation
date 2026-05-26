-- 段階E1b：カットオーバー（anon遮断＋ロール強制）
--
-- ⚠️ このファイルは「新ログインコード(login-first版)を main にマージするのと同時」に
--    1回だけ実行する。単一DBを本番と共有しているため、これを先に実行すると
--    現行本番(anon読取前提)が即座に壊れる。順序厳守。
--
-- 実行前の必須条件：
--   - phaseE1a_roles.sql 実行済み（user_roles / app_role() が存在）。
--   - これからログインする全ユーザーが user_roles に登録済み（未登録=何も読めない）。
--   - localhost で login-first コードの動作確認済み。
--
-- 変更内容：
--   1. 全テーブルの SELECT を anon+authenticated → authenticated 限定に張り替え（anon遮断）。
--      ※ ログイン済みなら全ロールが既存ops/参照データを読める。タブ単位の可視制御は
--        クライアント側(E2)で行う。経営機密データは別テーブルで E3 に追加し、そこで
--        SELECT を admin/executive 限定にする（本ファイルの対象外）。
--   2. 書込をロール強制：
--      - 運用系(prospects/assignment_overrides/project_status_overrides) = admin + editor
--      - employee_tiers(組織図の階層判定)                                = admin
--      - 参照系(organization/employee_quals/salesforce_imports/g_work_logs・同期で全置換) = admin
--
-- ロールバック：phaseB_rls.sql + phaseC_reference_write.sql + phaseD_schema.sql の
--   該当 policy 部分を再適用すれば段階C/D状態(anon読取可)に戻る。
--
-- 使い方：Supabase ダッシュボード → SQL Editor に貼り付け → Run。

-- ============================================================
-- 1. 読み取り：anon を外し authenticated 限定へ張り替え
-- ============================================================
drop policy if exists read_org           on public.organization;
drop policy if exists read_tiers         on public.employee_tiers;
drop policy if exists read_quals         on public.employee_quals;
drop policy if exists read_all_salesforce on public.salesforce_imports;
drop policy if exists read_all_prospects on public.prospects;
drop policy if exists read_all_overrides on public.assignment_overrides;
drop policy if exists read_all_glogs     on public.g_work_logs;
drop policy if exists read_all_status    on public.project_status_overrides;

create policy read_org    on public.organization            for select to authenticated using (true);
create policy read_tiers  on public.employee_tiers          for select to authenticated using (true);
create policy read_quals  on public.employee_quals          for select to authenticated using (true);
create policy read_sf     on public.salesforce_imports      for select to authenticated using (true);
create policy read_pros   on public.prospects               for select to authenticated using (true);
create policy read_ov     on public.assignment_overrides    for select to authenticated using (true);
create policy read_gw     on public.g_work_logs             for select to authenticated using (true);
create policy read_status on public.project_status_overrides for select to authenticated using (true);

-- ============================================================
-- 2. 書き込み：ロール強制へ張り替え
-- ============================================================

-- ---- 運用系3表：admin + editor ----
-- prospects
drop policy if exists write_prospects_ins on public.prospects;
drop policy if exists write_prospects_upd on public.prospects;
drop policy if exists write_prospects_del on public.prospects;
create policy write_prospects_ins on public.prospects for insert to authenticated with check (app_role() in ('admin','editor'));
create policy write_prospects_upd on public.prospects for update to authenticated using (app_role() in ('admin','editor')) with check (app_role() in ('admin','editor'));
create policy write_prospects_del on public.prospects for delete to authenticated using (app_role() in ('admin','editor'));

-- assignment_overrides
drop policy if exists write_overrides_ins on public.assignment_overrides;
drop policy if exists write_overrides_upd on public.assignment_overrides;
drop policy if exists write_overrides_del on public.assignment_overrides;
create policy write_overrides_ins on public.assignment_overrides for insert to authenticated with check (app_role() in ('admin','editor'));
create policy write_overrides_upd on public.assignment_overrides for update to authenticated using (app_role() in ('admin','editor')) with check (app_role() in ('admin','editor'));
create policy write_overrides_del on public.assignment_overrides for delete to authenticated using (app_role() in ('admin','editor'));

-- project_status_overrides
drop policy if exists write_status_ins on public.project_status_overrides;
drop policy if exists write_status_upd on public.project_status_overrides;
drop policy if exists write_status_del on public.project_status_overrides;
create policy write_status_ins on public.project_status_overrides for insert to authenticated with check (app_role() in ('admin','editor'));
create policy write_status_upd on public.project_status_overrides for update to authenticated using (app_role() in ('admin','editor')) with check (app_role() in ('admin','editor'));
create policy write_status_del on public.project_status_overrides for delete to authenticated using (app_role() in ('admin','editor'));

-- ---- employee_tiers（組織図の階層判定）：admin のみ ----
drop policy if exists w_tiers_ins on public.employee_tiers;
drop policy if exists w_tiers_upd on public.employee_tiers;
drop policy if exists w_tiers_del on public.employee_tiers;
create policy w_tiers_ins on public.employee_tiers for insert to authenticated with check (app_role() = 'admin');
create policy w_tiers_upd on public.employee_tiers for update to authenticated using (app_role() = 'admin') with check (app_role() = 'admin');
create policy w_tiers_del on public.employee_tiers for delete to authenticated using (app_role() = 'admin');

-- ---- 参照系4表（同期で全置換 = insert + delete）：admin のみ ----
-- organization
drop policy if exists w_org_ins on public.organization;
drop policy if exists w_org_del on public.organization;
create policy w_org_ins on public.organization for insert to authenticated with check (app_role() = 'admin');
create policy w_org_del on public.organization for delete to authenticated using (app_role() = 'admin');

-- employee_quals
drop policy if exists w_quals_ins on public.employee_quals;
drop policy if exists w_quals_del on public.employee_quals;
create policy w_quals_ins on public.employee_quals for insert to authenticated with check (app_role() = 'admin');
create policy w_quals_del on public.employee_quals for delete to authenticated using (app_role() = 'admin');

-- salesforce_imports
drop policy if exists write_sf_ins on public.salesforce_imports;
drop policy if exists write_sf_del on public.salesforce_imports;
create policy write_sf_ins on public.salesforce_imports for insert to authenticated with check (app_role() = 'admin');
create policy write_sf_del on public.salesforce_imports for delete to authenticated using (app_role() = 'admin');

-- g_work_logs
drop policy if exists write_glogs_ins on public.g_work_logs;
drop policy if exists write_glogs_del on public.g_work_logs;
create policy write_glogs_ins on public.g_work_logs for insert to authenticated with check (app_role() = 'admin');
create policy write_glogs_del on public.g_work_logs for delete to authenticated using (app_role() = 'admin');
