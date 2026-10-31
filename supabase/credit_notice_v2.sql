-- credit_notice_v2.sql（2026-10-31）: 与信の稟議の知らせを「申請した時点」から＝状態・下書き・反映の印・状態の履歴
-- なぜ: 坂本さん 10/31「経理は承認の経路の中で審査しているのに、承認後に届くのは一段遅れている」
--       → SF は稟議の状態が変わるたびに送る（申請中・承認・差し戻し・取り下げ）。経理は審査中に窓で下書きを入れ（SF には配らない）、
--         最終の承認の時点で sf-intake が下書きを自動で反映する（本番の org → credit_line／sandbox → credit_line_test → 即時配信）。
--       実務上ありえない操作（承認済みなのに「入れずに済み」など）は作らない＝閉じる・反映するは SF の稟議の状態に従って自動。
-- 前提: credit_notice.sql（2026-10-30）を流してあること。
-- 使い方: SQL Editor で実行（本番ハブ）。何度流しても同じ。このあと sf-intake 2026-10-31.1 を貼り、画面を公開する。
--         sf-intake を貼る前でも壊れない（古い sf-intake は状態を送らない＝今までどおり承認の知らせとして入る）。
-- 戻し方: ファイルの末尾。

-- 1. 状態・下書き・反映の印
alter table public.credit_notice add column if not exists stage varchar(10);          -- 申請中／承認／差し戻し／取り下げ
alter table public.credit_notice add column if not exists stage_at timestamptz;      -- SF でその状態になった時刻（遅れて届いた古い状態を無視する）
alter table public.credit_notice add column if not exists draft_limit_amount bigint; -- 下書き（審査中に経理が入れる・SF には配らない）
alter table public.credit_notice add column if not exists draft_limit_type varchar(20);
alter table public.credit_notice add column if not exists draft_valid_until date;
alter table public.credit_notice add column if not exists draft_decided_by varchar(40);
alter table public.credit_notice add column if not exists draft_by varchar(80);
alter table public.credit_notice add column if not exists draft_at timestamptz;
alter table public.credit_notice add column if not exists applied_at timestamptz;    -- 反映した時刻（承認で自動／窓の［保存して反映］）
alter table public.credit_notice add column if not exists applied_to varchar(20);    -- credit_line／credit_line_test
comment on column public.credit_notice.stage is 'SF の稟議の状態（申請中／承認／差し戻し／取り下げ）。sf-intake が上書きする。差し戻しは一覧から外し、取り下げと反映済みは閉じる（done_at）';
comment on column public.credit_notice.draft_limit_amount is '審査中の下書きの限度額（SF には配らない）。承認の時点で sf-intake が credit_line／credit_line_test に反映する';

-- 10/30〜31 の版で入った知らせ（承認のあとに届いた）＝承認
update public.credit_notice set stage = '承認', stage_at = coalesce(stage_at, received_at) where stage is null;

-- 2. 状態の履歴（知らせ 1 件に何行も・sf-intake が入れる）
create table if not exists public.credit_notice_event (
  id          bigserial primary key,
  notice_id   bigint not null references public.credit_notice(id) on delete cascade,
  stage       varchar(10) not null,
  stage_at    timestamptz,
  received_at timestamptz not null default now(),
  note        varchar(200)                        -- 反映した・古い状態なので無視した・会社が未特定で反映できない など
);
comment on table public.credit_notice_event is '与信の稟議の知らせの状態の履歴（sf-intake が入れる・2026-10-31）';
create index if not exists ix_credit_notice_event_notice on public.credit_notice_event (notice_id, received_at);

alter table public.credit_notice_event enable row level security;
drop policy if exists tm_sel_credit_notice_event on public.credit_notice_event;
create policy tm_sel_credit_notice_event on public.credit_notice_event for select to authenticated using (app_role() in ('admin','accounting'));
revoke all on public.credit_notice_event from anon;
grant select on public.credit_notice_event to authenticated;

-- 確かめ
select stage, (done_at is null) as open, count(*) from public.credit_notice group by 1, 2 order by 1, 2;
select count(*) as events from public.credit_notice_event;

-- 戻し方（上から順に）:
-- drop table if exists public.credit_notice_event;
-- alter table public.credit_notice drop column if exists stage, drop column if exists stage_at, drop column if exists draft_limit_amount,
--   drop column if exists draft_limit_type, drop column if exists draft_valid_until, drop column if exists draft_decided_by,
--   drop column if exists draft_by, drop column if exists draft_at, drop column if exists applied_at, drop column if exists applied_to;
-- （sf-intake は 2026-10-30.1 に貼り直す・画面は main の 0e8e690 に戻す）
