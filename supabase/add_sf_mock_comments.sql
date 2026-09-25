-- SF 案件・工事管理モックアップ（sfmock.html）の置き場所とコメント。
--
-- 目的：工事部その他の関係者に dev6 のモックアップを**触ってもらい**、画面の上に直接コメントを置いてもらう。
--   - 同時に何人でも書ける（Realtime で相手のコメントが即座に出る）
--   - 誰がいつ言ったかが残る（user_id / user_name / created_at）
--   - 画面のどこの話かが分かる（screen_id＋ピンの位置 x_pct / y_pct＋そのとき指していた文字 anchor_label）
--   - 返信でスレッドになる（parent_id）／対応済みは status='resolved' で畳む
--
-- 共有版の中身は **dev6 の部品そのもの**（koujiKagami / kagamiYukaPage / multiPicklist / kagamiData の
-- ソースと、dev6 が実際にサーバーから受け取った応答）。画像ではないので、レビューする人は
-- いつもの手つきで画面を移動し、数字を打って合計が動くところまで試せる（保存は手元で止まる）。
--
-- 🔴 その部品のソースと応答は GitHub（公開リポジトリ）には置かない。
--   このツールのリポジトリは公開＝置いたファイルは誰でも URL で取れてしまう（工事名・取引先・金額・氏名が入る）。
--   ツールが元々そうしているとおり「リポジトリにはコードだけ・データは Supabase」に揃え、
--   素材は **非公開バケット sfmock** に置いてログイン済みの人だけが読めるようにする。
--
-- 認証・ロールは統合管理ツールと同じ（同一オリジン＝ログイン状態を共有）。
--   素材・コメントの閲覧＝ログイン済み（ロール不問。工事部の閲覧者も読める・書ける）
--   素材の入れ替え＝admin のみ（SF リポジトリの scripts/mockup/publish.py か、この画面の「取り込む」）
--
-- 使い方：Supabase ダッシュボード → SQL Editor に貼り付け → Run（冪等・再実行可）。
--   https://supabase.com/dashboard/project/pajmsowweswaxowrbiwr/sql/new
-- 前提：phaseE1a_roles.sql 実行済み（app_role() が存在）。
-- 注意：ポリシー更新は drop→create をワンセットで実行（dropだけ通ると読めなくなる教訓）。

-- ===== 1. コメントのテーブル =====
create table if not exists public.sf_mock_comments (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  user_id         uuid not null default auth.uid(),
  user_name       text,                                   -- 表示名（user_roles.display_name の写し・一覧を軽くするため）
  screen_id       text not null,                          -- 例 'yamakyu|anken'（工事|画面）
  screen_label    text,                                   -- 例 '山九 土間基礎／工事管理（親案件）'
  x_pct           numeric,                                -- ピンの位置＝画面内の割合（0〜100）。null＝画面全体へのコメント
  y_pct           numeric,
  anchor_label    text,                                   -- 置いたときにそこにあった文字（例 '会計実績'）。
                                                          -- 画面は生きているので高さが変わるとピンはずれうる。
                                                          -- 何を指していたかが残れば、ずれても話が通じる
  body            text not null check (length(btrim(body)) > 0),
  parent_id       bigint references public.sf_mock_comments(id) on delete cascade,  -- 返信（null＝スレッドの先頭）
  status          text not null default 'open' check (status in ('open','resolved')),
  capture_version text                                    -- どの採取版に対して付けたか（manifest.capturedAt）
);

-- 既に作ってあった場合の足し込み（冪等）
alter table public.sf_mock_comments add column if not exists anchor_label text;

create index if not exists sf_mock_comments_screen_idx on public.sf_mock_comments (screen_id, id);
create index if not exists sf_mock_comments_parent_idx on public.sf_mock_comments (parent_id);

-- ===== 2. コメントの RLS =====
alter table public.sf_mock_comments enable row level security;

drop policy if exists smc_read   on public.sf_mock_comments;
drop policy if exists smc_insert on public.sf_mock_comments;
drop policy if exists smc_update on public.sf_mock_comments;
drop policy if exists smc_delete on public.sf_mock_comments;

-- 閲覧＝ログイン済みなら全部（レビューは全員で読む）
create policy smc_read   on public.sf_mock_comments for select to authenticated using (true);
-- 投稿＝自分名義でのみ
create policy smc_insert on public.sf_mock_comments for insert to authenticated with check (user_id = auth.uid());
-- 編集＝誰でも試みられる。中身の線引き（他人のコメントは「対応済み」の切替だけ）は下のトリガーで守る。
--   ⚠️ ポリシーの中で自分のテーブルを副問い合わせしない（「policy for relation に無限再帰」で弾かれる）。
--      所有者の突き合わせは OLD 行が見えるトリガー側でやるのが素直。
create policy smc_update on public.sf_mock_comments for update to authenticated
  using (true) with check (true);
-- 削除＝本人か admin
create policy smc_delete on public.sf_mock_comments for delete to authenticated
  using (user_id = auth.uid() or app_role() = 'admin');

-- 更新の線引き（本人・admin＝全部／ほかの人＝status だけ）。所有者・投稿日時は誰にも書き換えさせない
create or replace function public.sf_mock_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from auth.uid() and public.app_role() is distinct from 'admin' then
    if new.body         is distinct from old.body
    or new.screen_id    is distinct from old.screen_id
    or new.screen_label is distinct from old.screen_label
    or new.x_pct        is distinct from old.x_pct
    or new.y_pct        is distinct from old.y_pct
    or new.anchor_label is distinct from old.anchor_label
    or new.parent_id    is distinct from old.parent_id
    or new.user_name    is distinct from old.user_name then
      raise exception '他の人のコメントは「対応済み」の切替だけできます';
    end if;
  end if;
  new.user_id    := old.user_id;      -- 所有者は変えさせない
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists sf_mock_guard_update on public.sf_mock_comments;
create trigger sf_mock_guard_update
  before update on public.sf_mock_comments
  for each row execute function public.sf_mock_guard_update();

-- ===== 3. Realtime（同時コメント）=====
do $$
begin
  alter publication supabase_realtime add table public.sf_mock_comments;
exception
  when duplicate_object then null;
  when undefined_object then null;  -- publication が無い環境（ローカル等）
end $$;

alter table public.sf_mock_comments replica identity full;  -- 更新・削除も画面に反映するため

-- ===== 4. 素材を置く非公開バケット =====
-- 中身: manifest.json（目次）／apex.json・records.json（dev6 の応答）／picklists.json・formulas.json
--       （項目定義）／names.json（ピッカーの候補）／src/*（部品のソース 10 ファイル）
insert into storage.buckets (id, name, public)
values ('sfmock', 'sfmock', false)
on conflict (id) do update set public = false;   -- 万一 public になっていたら戻す

drop policy if exists sfmock_read   on storage.objects;
drop policy if exists sfmock_insert on storage.objects;
drop policy if exists sfmock_update on storage.objects;
drop policy if exists sfmock_delete on storage.objects;

-- 閲覧＝ログイン済み（匿名では取れない）
create policy sfmock_read   on storage.objects for select to authenticated using (bucket_id = 'sfmock');
-- 入れ替え＝admin のみ
create policy sfmock_insert on storage.objects for insert to authenticated with check (bucket_id = 'sfmock' and public.app_role() = 'admin');
create policy sfmock_update on storage.objects for update to authenticated using (bucket_id = 'sfmock' and public.app_role() = 'admin');
create policy sfmock_delete on storage.objects for delete to authenticated using (bucket_id = 'sfmock' and public.app_role() = 'admin');

-- ===== 5. 確認 =====
-- select id, public from storage.buckets where id = 'sfmock';          -- public が false であること
-- select policyname from pg_policies where tablename = 'objects' and policyname like 'sfmock%';   -- 4 本
-- select policyname from pg_policies where tablename = 'sf_mock_comments';                        -- 4 本
-- select tgname from pg_trigger where tgrelid = 'public.sf_mock_comments'::regclass and not tgisinternal;  -- sf_mock_guard_update
-- select count(*) from public.sf_mock_comments;
