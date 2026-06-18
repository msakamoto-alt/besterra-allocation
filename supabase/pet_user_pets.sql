-- 多人数対応ペット「アップル/ピー」：1人1匹。各ユーザーが自分の行だけ読み書き（RLS）。
--
-- 経緯：従来は学習用Supabaseの pet_config 単一 'pilot' 行を全員で共有していた
--   （誰かが名前/画像を変えると全員に反映）。本番の個人アカウント(Auth)に紐づけ、
--   本人だけが自分のペット設定を読み書きできるようにする。
--
-- 保存先＝本番プロジェクト（pajmsowweswaxowrbiwr）。pet-embed.js はツールの
--   認証済みセッション（Sync.getSupabase）でこの表にアクセスする。
-- 画像は base64 data URL（アップロード時に220pxへ縮小・静止画）。null＝デフォルト画像。

create table if not exists public.user_pets (
  user_id    uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  pet_name   text,
  image_data text,            -- data URL(base64) または null（=デフォルト画像）
  scale      text,            -- 表示倍率（文字列）
  hidden     boolean default false,  -- 本人が「今後表示しない」を選んだ＝恒久非表示
  updated_at timestamptz default now()
);

-- 既に作成済みの場合に列を追加（冪等＝再実行可）
alter table public.user_pets add column if not exists hidden boolean default false;

alter table public.user_pets enable row level security;

drop policy if exists up_sel on public.user_pets;
drop policy if exists up_ins on public.user_pets;
drop policy if exists up_upd on public.user_pets;
drop policy if exists up_del on public.user_pets;

-- 本人の行だけ（auth.uid()）。他人のペット設定は読めない・書けない。
create policy up_sel on public.user_pets for select to authenticated using (user_id = auth.uid());
create policy up_ins on public.user_pets for insert to authenticated with check (user_id = auth.uid());
create policy up_upd on public.user_pets for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy up_del on public.user_pets for delete to authenticated using (user_id = auth.uid());
