-- 段階E4b（学習進捗）: 個人の学習目標 learning_goals
--
-- 個人ダッシュボードの「今日のノルマ / 今週の目標」を保存する。本人だけが読み書き。
-- 進捗の実数（解答数・連続日数・単元別習得度）は quiz_answers から都度集計するため、ここは目標だけ。
--
-- 前提：phaseE1a_roles.sql / phaseE4_elearning.sql 実行済み。
-- 使い方：Supabase ダッシュボード → SQL Editor → 貼り付け → Run。
-- ロールバック：drop table public.learning_goals;

create table if not exists public.learning_goals (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  daily_goal  int not null default 10,
  weekly_goal int not null default 70,
  updated_at  timestamptz default now()
);

alter table public.learning_goals enable row level security;

drop policy if exists g_read on public.learning_goals;
drop policy if exists g_ins  on public.learning_goals;
drop policy if exists g_upd  on public.learning_goals;

-- 本人のみ読み書き（管理職の閲覧は将来E4cで必要なら拡張）。
create policy g_read on public.learning_goals for select to authenticated using (user_id = auth.uid());
create policy g_ins  on public.learning_goals for insert to authenticated with check (user_id = auth.uid());
create policy g_upd  on public.learning_goals for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
