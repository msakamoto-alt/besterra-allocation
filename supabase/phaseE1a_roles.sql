-- 段階E1a：ロール基盤（追加のみ・本番に無影響）
--
-- 目的：5ロールRBAC（admin/editor/executive/manager/viewer）の土台を作る。
--   - user_roles 表（auth.users と1:1でロールを保持）
--   - app_role() 関数（RLSポリシー内で「今のユーザーのロール」を取得）
--
-- ★このファイルは既存テーブルのRLSポリシーを一切変更しない。
--   実行しても権限は今まで通り（anon読取可・authenticated書込可）のまま。
--   実際の締め付け（anon遮断・ロール強制）は phaseE1b_cutover_rls.sql で、
--   新ログインコードを main にマージするのと同時に実行する。
--
-- 使い方：Supabase ダッシュボード → SQL Editor に貼り付け → Run。

-- ===== 1. user_roles 表 =====
create table if not exists public.user_roles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null check (role in ('admin','editor','executive','manager','viewer')),
  display_name text,
  email        text,
  created_at   timestamptz default now()
);

-- ===== 2. app_role()：現在ログイン中ユーザーのロールを返す =====
-- security definer により user_roles を RLS 無視で読める（ポリシー内から安全に呼べる）。
-- search_path 固定は security definer の定石（注入対策）。
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.user_roles where user_id = auth.uid()
$$;

-- ===== 3. user_roles 自体の RLS =====
-- 本人は自分の行を読める／管理者は全行読める。書込ポリシーは作らない
-- ＝ user_roles の編集は service_role / SQL Editor からのみ（誤操作・権限昇格を防止）。
alter table public.user_roles enable row level security;

drop policy if exists ur_read_self  on public.user_roles;
drop policy if exists ur_read_admin on public.user_roles;
create policy ur_read_self  on public.user_roles for select to authenticated using (user_id = auth.uid());
create policy ur_read_admin on public.user_roles for select to authenticated using (app_role() = 'admin');

-- ===== 4. 管理者アカウントの登録（手順） =====
-- (a) Supabase ダッシュボード → Authentication → Users →「Add user」で
--     email/password を作成（Auto Confirm User を ON）。
-- (b) 下記を実行（email を作成したアカウントに合わせる）。auth.users から user_id を引いて登録：
--
-- insert into public.user_roles (user_id, role, display_name, email)
-- select id, 'admin', '坂本', email from auth.users
-- where email = 'm.sakamoto@besterra.co.jp'
-- on conflict (user_id) do update set role = excluded.role;
--
-- (c) 確認：select * from public.user_roles;
