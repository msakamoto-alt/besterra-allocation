-- 取引先マスタの連携ログ（integration_log）— 2026-09-09
--
-- 目的: ハブ→Salesforce 配信（sf-export）の実行記録を、アプリ共通の監査ログ（audit_logs）から切り離す。
--       保存のたびに配信が走る即時方式では監査ログが配信行で埋まるため（坂本さん指摘）。
--       取引先マスタの左サイド「連携ログ」ページと「システム連携」ページの接続の記録は、この表から動的に描く。
-- 行の種類（kind）:
--   run   … sf-export の1実行（配信・突合）。counts に件数、meta に接続先/版/方式（関数が毎回書く＝陳腐化しない）
--   error … sf-export の失敗（message に本文）
--   note  … 人が書く出来事の記録（登録方法・運用変更・不具合と復旧など）。画面「連携ログ」から追記できる
-- 書込: run/error は Edge Function（service_role・RLS 迂回）。note は admin / accounting が画面から。

create table if not exists public.integration_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  system      text not null,                 -- 'salesforce' など（将来 Bill One・奉行も同じ表に）
  target      text,                          -- 接続先（org 名・ID・sandbox か）
  kind        text not null check (kind in ('run','error','note')),
  action      text,                          -- export / link / dry_run
  trigger     text,                          -- 自動（保存時・即時）／自動（夜間・全件）／手動（スクリプト）／手動（アプリ）
  actor       text,                          -- 関数名または人のメール
  counts      jsonb,                         -- {sent, created, updated, failed, code_conflict, writeback, linked, ...}
  company_ids text[],                        -- 対象を絞った実行（即時配信＝その会社）
  reason      text,                          -- 契機（company:UPDATE 等）
  message     text,                          -- note の本文／error の本文
  meta        jsonb,                         -- {version, mode, settle_ms, allowed_orgs, writeback, scope}
  duration_ms int
);
create index if not exists ix_integration_log_sys_at on public.integration_log (system, at desc);
create index if not exists ix_integration_log_cids on public.integration_log using gin (company_ids);

alter table public.integration_log enable row level security;
drop policy if exists il_sel on public.integration_log;
create policy il_sel on public.integration_log for select to authenticated using (app_role() in ('admin','accounting'));
drop policy if exists il_ins_note on public.integration_log;
create policy il_ins_note on public.integration_log for insert to authenticated
  with check (app_role() in ('admin','accounting') and kind = 'note');
revoke all on public.integration_log from anon;
grant select, insert on public.integration_log to authenticated;
grant usage, select on sequence public.integration_log_id_seq to authenticated;

-- 【確認】 select at, kind, action, trigger, counts, company_ids, left(message, 60) from public.integration_log order by at desc limit 20;
