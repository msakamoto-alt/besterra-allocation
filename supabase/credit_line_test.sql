-- credit_line_test.sql（2026-10-30）: 試験の与信を本物の与信と分けて持つ＝sandbox の稟議の結果はその org にだけ配る
-- なぜ: 2026-10-30 に dev6 の試験の与信の稟議（YS-00027）の決裁額を、本物の会社 10487 の credit_line に入れた。
--       credit_line は本番の会社マスタの与信そのもの＝dev6・dev7（1/28 からは本番 SF）の全部に配られ、本番マスタが汚れ、dev7 の試験参加者にも広がった。
--       坂本さん 10/30「同じことが起きないようにガードできないか。今後 UAT をすると確実にまた起きる」。
-- 使い方: SQL Editor で実行（本番ハブ）。何度流しても同じ。そのあと sf-export 2026-10-30.1 を貼り、画面（torihikisaki.js）を公開する。
--         順番を逆にしても壊れない（sf-export は表が無ければ本物の値だけで配る・画面は表が無ければ与信の保存を止めて案内する）。
-- 中身:
--   1. sf_target_org … 配信先の Salesforce の一覧（画面が「どの Salesforce の稟議か」を選ばせるため。Secrets は画面から読めない）。
--      is_prod の行があるときだけ、画面で「本番」を選べる＝今は dev6・dev7 だけ＝本物の credit_line には稟議の結果が入らない。
--   2. credit_line_test … 試験の与信（会社 × org で 1 行）。sf-export が送り先の org にだけ、本物の credit_line の上にかぶせて配る。本番の org には使わない。
--   3. credit_line.application_no … 本物の与信に入れた稟議の番号（YS-… またはバクラクの申請番号）。画面が必須にする。
--   4. 即時配信のトリガ（notify_sf_export を credit_line_test にも）。消すと本物の値（多くは空）が配り直される。
-- 戻し方: drop trigger trg_sfx_credit_line_test on public.credit_line_test; drop table public.credit_line_test; drop table public.sf_target_org;
--         alter table public.credit_line drop column application_no;（sf-export 2026-10-30.1 は表が無くても動く）

-- 1. 配信先の Salesforce
create table if not exists public.sf_target_org (
  org_id   varchar(15) primary key,          -- org の 15 桁（Secret SF_EXPORT_TARGETS の org_id と同じ）
  label    varchar(40) not null,             -- 呼び名（SF_EXPORT_TARGETS の name と同じ＝dev6・dev7）
  is_prod  boolean not null default false,   -- 本番 SF（1/28 の配備のあとに足す。Secret SF_PROD_ORG_IDS とそろえる）
  sort_no  int not null default 0
);
comment on table public.sf_target_org is '配信先の Salesforce（画面の「どの Salesforce の稟議か」の選択肢）。Secret SF_EXPORT_TARGETS／SF_PROD_ORG_IDS とそろえる（2026-10-30）';
insert into public.sf_target_org (org_id, label, is_prod, sort_no) values
  ('00Dfd000002CDWc', 'dev6', false, 1),
  ('00Dff0000014yuf', 'dev7', false, 2)
on conflict (org_id) do nothing;

-- 2. 試験の与信
create table if not exists public.credit_line_test (
  id              bigserial primary key,
  company_id      varchar(8) not null references public.company(company_id) on delete cascade,
  org_id          varchar(15) not null references public.sf_target_org(org_id),
  org_label       varchar(40),
  application_no  varchar(40) not null,      -- その org の与信の稟議の番号（YS-00027 など）
  limit_amount    bigint,
  limit_type      varchar(20),
  valid_until     date,
  approved_on     date,
  decided_by      varchar(40),
  created_by      varchar(80),
  created_at      timestamptz not null default now(),
  updated_by      varchar(80),
  updated_at      timestamptz not null default now(),
  unique (company_id, org_id)
);
comment on table public.credit_line_test is 'sandbox（dev6・dev7）の与信の稟議の結果。sf-export がその org にだけ、本物の credit_line の代わりに配る（本番の org には使わない）。本物の会社マスタを汚さない（2026-10-30・会社 10487 の件）';
create index if not exists ix_credit_line_test_company on public.credit_line_test (company_id);

-- 3. 本物の与信に入れた稟議の番号
alter table public.credit_line add column if not exists application_no varchar(40);
comment on column public.credit_line.application_no is '本物の与信の元になった稟議の番号（本番 SF の YS-… またはバクラクの申請番号）。画面が入れるときに必須（2026-10-30）';

-- 権限（取引先マスタの表と同じ＝admin・accounting）
do $$
declare t text;
begin
  foreach t in array array['sf_target_org', 'credit_line_test'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tm_sel_%s on public.%I', t, t);
    execute format('drop policy if exists tm_ins_%s on public.%I', t, t);
    execute format('drop policy if exists tm_upd_%s on public.%I', t, t);
    execute format('drop policy if exists tm_del_%s on public.%I', t, t);
    execute format('create policy tm_sel_%s on public.%I for select to authenticated using (app_role() in (''admin'',''accounting''))', t, t);
    if t = 'sf_target_org' then
      -- 配信先の一覧は管理者だけが直す
      execute format('create policy tm_ins_%s on public.%I for insert to authenticated with check (app_role() = ''admin'')', t, t);
      execute format('create policy tm_upd_%s on public.%I for update to authenticated using (app_role() = ''admin'') with check (app_role() = ''admin'')', t, t);
      execute format('create policy tm_del_%s on public.%I for delete to authenticated using (app_role() = ''admin'')', t, t);
    else
      execute format('create policy tm_ins_%s on public.%I for insert to authenticated with check (app_role() in (''admin'',''accounting''))', t, t);
      execute format('create policy tm_upd_%s on public.%I for update to authenticated using (app_role() in (''admin'',''accounting'')) with check (app_role() in (''admin'',''accounting''))', t, t);
      execute format('create policy tm_del_%s on public.%I for delete to authenticated using (app_role() in (''admin'',''accounting''))', t, t);
    end if;
  end loop;
end $$;
revoke all on public.sf_target_org, public.credit_line_test from anon;
grant select, insert, update, delete on public.sf_target_org, public.credit_line_test to authenticated;
grant usage, select on sequence public.credit_line_test_id_seq to authenticated;

-- 4. 即時配信（sf_export_trigger.sql の notify_sf_export をそのまま使う＝company_id で sf-export を呼ぶ）
drop trigger if exists trg_sfx_credit_line_test on public.credit_line_test;
create trigger trg_sfx_credit_line_test after insert or update or delete on public.credit_line_test
  for each row execute function public.notify_sf_export();

-- 確かめ
select 'sf_target_org' as t, count(*) from public.sf_target_org
union all select 'credit_line_test', count(*) from public.credit_line_test
union all select 'credit_line（稟議番号あり）', count(*) from public.credit_line where application_no is not null;
