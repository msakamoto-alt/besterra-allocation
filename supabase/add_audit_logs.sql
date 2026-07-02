-- 監査ログ（編集履歴）の追加。
--
-- 目的：誰が・いつ・どのデータを・どう編集したかをDB側トリガーで自動記録する。
--   - クライアント（js）側の実装漏れ・改変に依存しない（DBトリガー＝経路によらず必ず記録）
--   - 閲覧は admin のみ（RLSでサーバー強制）。クライアントからの書込・改竄は一切不可
--
-- 記録対象＝編集系8テーブル（画面から手で編集するもの）：
--   assignment_overrides   配置（現場人員配置の編集）
--   prospects              見込み案件
--   project_status_overrides 案件の修正（完成/管轄事務所の付替え）
--   employee_tiers         階層・稼働形態
--   employee_absences      不在予定
--   management_reports     経営レポート（アップロード/差替/削除）
--   quiz_questions         安全学習の問題管理
--   learning_goals         学習目標
-- 対象外＝参照系（同期ボタンでSheetsから全置換する organization/salesforce_imports/
--   g_work_logs/employee_quals：全置換のたび大量ログになるため）・quiz_answers（学習回答＝
--   編集ではない）・user_pets（個人のペット設定）。
--
-- 使い方：Supabase ダッシュボード → SQL Editor に貼り付け → Run（冪等・再実行可）。
-- 前提：phaseE1a_roles.sql 実行済み（app_role() が存在）。
-- 注意：ポリシー更新は drop→create をワンセットで実行（dropだけ通ると閲覧不能になる教訓）。

-- 1) ログテーブル
create table if not exists public.audit_logs (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid,                 -- 操作者（auth.uid()）
  user_email  text,                 -- 操作者メール（JWTから）
  user_role   text,                 -- 操作時のロール（app_role()）
  table_name  text not null,        -- 対象テーブル
  op          text not null,        -- INSERT / UPDATE / DELETE
  row_key     text,                 -- 対象行の人間可読キー（工事番号・社員番号等）
  changes     jsonb                 -- 変更内容 {列: {old, new}}（変更列のみ・値は200字で切詰め）
);

create index if not exists audit_logs_at_idx    on public.audit_logs (id desc);
create index if not exists audit_logs_table_idx on public.audit_logs (table_name, id desc);

-- 2) 汎用トリガー関数
--    security definer＝関数所有者権限で実行（クライアントに audit_logs の書込権を与えない）
create or replace function public.log_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old     jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new     jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_row     jsonb;
  v_changes jsonb := '{}'::jsonb;
  k         text;
begin
  v_row := coalesce(v_new, v_old);

  if tg_op = 'UPDATE' then
    -- 変更のあった列だけを {old, new} で記録（updated_at 等の自動更新列はノイズなので除外）
    for k in select jsonb_object_keys(v_new) loop
      if k in ('updated_at', 'created_at', 'uploaded_at') then continue; end if;
      if (v_old -> k) is distinct from (v_new -> k) then
        v_changes := v_changes || jsonb_build_object(k, jsonb_build_object(
          'old', left(coalesce(v_old ->> k, ''), 200),
          'new', left(coalesce(v_new ->> k, ''), 200)));
      end if;
    end loop;
    -- 実質無変更の upsert（同値上書き）は記録しない
    if v_changes = '{}'::jsonb then return null; end if;
  elsif tg_op = 'INSERT' then
    for k in select jsonb_object_keys(v_new) loop
      if coalesce(v_new ->> k, '') = '' then continue; end if;
      v_changes := v_changes || jsonb_build_object(k, jsonb_build_object(
        'new', left(v_new ->> k, 200)));
    end loop;
  else -- DELETE
    for k in select jsonb_object_keys(v_old) loop
      if coalesce(v_old ->> k, '') = '' then continue; end if;
      v_changes := v_changes || jsonb_build_object(k, jsonb_build_object(
        'old', left(v_old ->> k, 200)));
    end loop;
  end if;

  insert into public.audit_logs (user_id, user_email, user_role, table_name, op, row_key, changes)
  values (
    auth.uid(),
    coalesce(auth.jwt() ->> 'email', ''),
    coalesce(public.app_role(), ''),
    tg_table_name,
    tg_op,
    -- 行の人間可読キー（テーブルごとの主要キー）
    case tg_table_name
      when 'assignment_overrides'     then v_row ->> 'override_key'
      when 'prospects'                then coalesce(v_row ->> 'project_name', '') || '（' || coalesce(v_row ->> 'prospect_id', '') || '）'
      when 'project_status_overrides' then v_row ->> 'project_id'
      when 'employee_tiers'           then v_row ->> 'emp_no'
      when 'employee_absences'        then v_row ->> 'emp_no'
      when 'management_reports'       then coalesce(v_row ->> 'report_type', '') || ' ' || coalesce(v_row ->> 'year_month', '')
      when 'quiz_questions'           then v_row ->> 'qid'
      when 'learning_goals'           then v_row ->> 'user_id'
      else v_row ->> 'id'
    end,
    v_changes
  );
  return null;  -- AFTERトリガーの戻り値は無視される
end;
$$;

-- 3) 編集系8テーブルへトリガー装着（AFTER＝本体の書込には一切影響しない）
drop trigger if exists audit_assignment_overrides on public.assignment_overrides;
create trigger audit_assignment_overrides
  after insert or update or delete on public.assignment_overrides
  for each row execute function public.log_audit();

drop trigger if exists audit_prospects on public.prospects;
create trigger audit_prospects
  after insert or update or delete on public.prospects
  for each row execute function public.log_audit();

drop trigger if exists audit_project_status_overrides on public.project_status_overrides;
create trigger audit_project_status_overrides
  after insert or update or delete on public.project_status_overrides
  for each row execute function public.log_audit();

drop trigger if exists audit_employee_tiers on public.employee_tiers;
create trigger audit_employee_tiers
  after insert or update or delete on public.employee_tiers
  for each row execute function public.log_audit();

drop trigger if exists audit_employee_absences on public.employee_absences;
create trigger audit_employee_absences
  after insert or update or delete on public.employee_absences
  for each row execute function public.log_audit();

drop trigger if exists audit_management_reports on public.management_reports;
create trigger audit_management_reports
  after insert or update or delete on public.management_reports
  for each row execute function public.log_audit();

drop trigger if exists audit_quiz_questions on public.quiz_questions;
create trigger audit_quiz_questions
  after insert or update or delete on public.quiz_questions
  for each row execute function public.log_audit();

drop trigger if exists audit_learning_goals on public.learning_goals;
create trigger audit_learning_goals
  after insert or update or delete on public.learning_goals
  for each row execute function public.log_audit();

-- 4) RLS：閲覧は admin のみ。書込ポリシーは作らない（＝クライアントからは一切書けない・
--    記録は security definer のトリガーだけが行う）
alter table public.audit_logs enable row level security;

drop policy if exists read_audit on public.audit_logs;
create policy read_audit on public.audit_logs
  for select to authenticated
  using (public.app_role() = 'admin');

-- 動作確認（任意）：
--   1. 画面から何か編集（例＝見込み案件のメモ変更）
--   2. select * from public.audit_logs order by id desc limit 5;
--      → user_email / table_name / changes に記録が入っていればOK
