-- employee_tiers の書込を admin+editor に緩和（稼働形態を編集者も設定できるように）
--
-- 経緯：
--   phaseE1b_cutover_rls.sql で employee_tiers の書込を admin 限定にした
--   （「階層判定は admin の仕事」という整理）。その後 add_work_mode_to_tiers.sql で
--   稼働形態（work_mode）を同じテーブルに後付けし、監督ダッシュボードのプルダウンを
--   admin/editor 両方に開放した。結果、editor が稼働形態を保存すると RLS 違反で失敗していた
--   （new row violates row-level security policy for table "employee_tiers"）。
--
-- 方針（2026-06-16 ユーザー決定）：稼働形態は運用情報なので editor も設定可とする。
--   - INSERT / UPDATE … admin + editor（稼働形態の upsert に必要）
--   - DELETE          … admin のみ据置（= 手動階層のリセット相当。editor の運用フローでは不要）
--
-- 注意（副作用）：これにより editor は API 経由で employee_tiers の tier 列（階層判定）も
--   書き換え可能になる。ただし階層編集UI（組織図タブ）は admin 限定のままで、editor には
--   稼働形態のプルダウンしか露出しない。tier は経営機密ではないため許容と判断。
--
-- 前提：app_role()（phaseE1a_roles.sql）。

alter table public.employee_tiers enable row level security;

drop policy if exists w_tiers_ins on public.employee_tiers;
drop policy if exists w_tiers_upd on public.employee_tiers;
drop policy if exists w_tiers_del on public.employee_tiers;

create policy w_tiers_ins on public.employee_tiers
  for insert to authenticated
  with check (app_role() in ('admin','editor'));

create policy w_tiers_upd on public.employee_tiers
  for update to authenticated
  using (app_role() in ('admin','editor'))
  with check (app_role() in ('admin','editor'));

create policy w_tiers_del on public.employee_tiers
  for delete to authenticated
  using (app_role() = 'admin');
