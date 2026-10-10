-- SF の承認待ち・回覧 → Teams 通知（sf-teams-notify）の送信記録 — 2026-10-10
-- Supabase SQL Editor で 1 回実行する（何度実行しても同じ結果になる）。
--
-- 1 行＝SF の 1 件（承認待ち＝ProcessInstanceWorkitem の Id／回覧＝Circulation__c の Id）。
-- 主キーで「誰が送るか」を取り合う＝cron の二重起動（9/10・9/11 の sf-export と同じ事象）でも 2 回は送らない。
-- 時刻は DB が付ける（created_at＝既定値・sent_at＝送れた瞬間にトリガが付ける）。関数からは渡さない。
-- 読み書きは Edge Function（service role）だけ。RLS は有効・ポリシー無し＝画面や anon キーからは見えない。

create table if not exists public.teams_notify_log (
  sf_id           text primary key,
  kind            text not null check (kind in ('approval', 'circulation', 'marker')),  -- marker＝起点の目印（sf_id='__baseline__'）
  status          text not null default 'claimed' check (status in ('baseline', 'claimed', 'sent', 'error')),
  attempts        int  not null default 1,
  record_id       text,
  record_name     text,
  title           text,
  recipient_name  text,
  recipient_email text,   -- SF のユーザーのメール（dev6 は末尾 .invalid のまま記録する）
  sent_to         text,   -- 実際に送った先（テスト中は TEAMS_TEST_RECIPIENT）
  error           text,
  sf_created_at   timestamptz,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

alter table public.teams_notify_log enable row level security;

create or replace function public.teams_notify_log_stamp() returns trigger
language plpgsql as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' then
    new.sent_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists teams_notify_log_stamp on public.teams_notify_log;
create trigger teams_notify_log_stamp before update on public.teams_notify_log
  for each row execute function public.teams_notify_log_stamp();

create index if not exists teams_notify_log_created_at on public.teams_notify_log (created_at desc);

-- 【確認】 select status, count(*) from teams_notify_log group by status;
--          select sf_id, kind, status, title, recipient_name, sent_to, error, created_at, sent_at
--            from teams_notify_log order by created_at desc limit 20;
