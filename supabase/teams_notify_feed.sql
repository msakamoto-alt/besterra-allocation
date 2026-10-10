-- Teams 通知を RSS で渡す（sf-teams-feed）ための追加 — 2026-10-10
-- teams_notify.sql の後に Supabase SQL Editor で 1 回実行する（何度実行しても同じ結果になる）。
--
-- Webhook を外から直接呼べない環境向けに、
-- sf-teams-notify は送る分を「RSS に出した」（status='queued'）として積み、sf-teams-feed が RSS で出す。
-- payload＝{to, card}（宛先とアダプティブ カード）。queued_at＝RSS に出た時刻＝RSS の pubDate（DB が付ける）。

alter table public.teams_notify_log add column if not exists payload   jsonb;
alter table public.teams_notify_log add column if not exists queued_at timestamptz;

alter table public.teams_notify_log drop constraint if exists teams_notify_log_kind_check;
alter table public.teams_notify_log add constraint teams_notify_log_kind_check
  check (kind in ('approval', 'circulation', 'marker', 'ping'));  -- ping＝接続テスト

alter table public.teams_notify_log drop constraint if exists teams_notify_log_status_check;
alter table public.teams_notify_log add constraint teams_notify_log_status_check
  check (status in ('baseline', 'claimed', 'queued', 'sent', 'error'));

create or replace function public.teams_notify_log_stamp() returns trigger
language plpgsql as $$
begin
  if new.status = 'queued' and (tg_op = 'INSERT' or old.status is distinct from 'queued') then
    new.queued_at := now();
  end if;
  if new.status = 'sent' and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
    new.sent_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists teams_notify_log_stamp on public.teams_notify_log;
create trigger teams_notify_log_stamp before insert or update on public.teams_notify_log
  for each row execute function public.teams_notify_log_stamp();

create index if not exists teams_notify_log_queued_at on public.teams_notify_log (queued_at desc) where status = 'queued';

-- 【確認】 select sf_id, kind, title, sent_to, queued_at from teams_notify_log where status = 'queued' order by queued_at desc limit 10;
