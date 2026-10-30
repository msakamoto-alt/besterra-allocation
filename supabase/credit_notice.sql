-- credit_notice.sql（2026-10-30）: 承認の知らせ＋試験の与信＝Salesforce の稟議の結果を、どの SF の稟議かで入れ分ける
-- なぜ: 2026-10-30 に dev6 の試験の与信の稟議（YS-00027）の決裁額を、本物の会社 10487 の credit_line に手で入れた。
--       credit_line は本番の会社マスタの与信そのもの＝dev6・dev7（1/28 からは本番 SF）の全部に配られ、本番マスタが汚れ、dev7 の試験参加者にも広がった。
--       坂本さん 10/30「同じことが起きないようにガードできないか。今後 UAT をすると確実にまた起きる」→「承認の知らせ＋窓」の形に決定。
-- 流れ: SF で与信の稟議・取引開始申請が承認される → SF（CreditDecisionNotice）が sf-intake に「承認の知らせ」を 1 件送る → credit_notice に 1 行
--       → 画面の一覧「届いている承認の知らせ」と会社の窓 → 経理が限度額・種類・期限・決裁者を入れる
--       → 知らせの org が本番なら credit_line（本物）、sandbox なら credit_line_test（その org にだけ配る）。入れる人は org を選ばない。
-- 使い方: SQL Editor で実行（本番ハブ）。何度流しても同じ。順番＝この SQL → sf-intake・sf-export を貼る → 画面を公開 → SF の「承認の知らせを送る」を ON。
--         どの順でも既存の配信・画面は壊れない（sf-export は credit_line_test が無ければ本物の値だけで配る・画面は表が無ければ知らせの枠を出さない）。
-- 戻し方: ファイルの末尾（行を消してから表を消す）。

-- 1. 承認の知らせ（sf-intake が service role で入れる＝画面からは読む・済みにするだけ）
create table if not exists public.credit_notice (
  id               bigserial primary key,
  org_id           varchar(15) not null,          -- 送ってきた Salesforce（15 桁）
  org_label        varchar(40),                   -- 呼び名（Secret SF_EXPORT_TARGETS の name＝dev6・dev7。無ければ 15 桁）
  is_prod          boolean not null default false, -- 本番 SF（Secret SF_PROD_ORG_IDS にある org）から来た知らせ＝本物の与信に入れる
  kind             varchar(10) not null,          -- 与信／取引開始
  application_no   varchar(40) not null,          -- 稟議番号（YS-00027）
  application_id   varchar(18),                   -- SF の稟議の Id
  sf_account_id    varchar(18),                   -- SF の取引先 Id
  account_name     varchar(200),                  -- SF の取引先名（会社が引けないときに窓で選ぶ手掛かり）
  company_id       varchar(8) references public.company(company_id) on delete set null, -- 会社（引けなければ空＝窓で選ぶ）
  applicant        varchar(80),
  approved_on      date,
  requested_limit  bigint,                        -- 希望額（参考・入れる値ではない）
  project_no       varchar(20),
  received_at      timestamptz not null default now(),
  done_at          timestamptz,                   -- 済み（与信を入れた・本登録の番を済ませた・入れずに閉じた）
  done_by          varchar(80),
  done_note        varchar(200),
  unique (org_id, application_no)
);
comment on table public.credit_notice is 'Salesforce の与信の稟議・取引開始申請の承認の知らせ（sf-intake action=credit_notice・2026-10-30）。画面の「届いている承認の知らせ」と会社の窓の元。決裁額は来ない（限度額は経理が入れる）';
create index if not exists ix_credit_notice_open on public.credit_notice (company_id) where done_at is null;

-- 2. 試験の与信（会社 × org で 1 行）。sf-export が送り先の org にだけ、本物の credit_line の代わりに配る（本番の org には使わない）
create table if not exists public.credit_line_test (
  id              bigserial primary key,
  company_id      varchar(8) not null references public.company(company_id) on delete cascade,
  org_id          varchar(15) not null,
  org_label       varchar(40),
  application_no  varchar(40) not null,
  notice_id       bigint references public.credit_notice(id) on delete set null,
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
comment on table public.credit_line_test is 'sandbox（dev6・dev7）の与信の稟議の結果。sf-export がその org にだけ、本物の credit_line の代わりに配る。本物の会社マスタを汚さない（2026-10-30・会社 10487 の件）';
create index if not exists ix_credit_line_test_org on public.credit_line_test (org_id);

-- 3. 本物の与信の根拠（本番 SF の稟議番号・棚卸 2026-11 など）。画面が入れるときに必須（YS- は知らせの窓からだけ）
alter table public.credit_line add column if not exists basis varchar(60);
comment on column public.credit_line.basis is '本物の与信の根拠（本番 SF の稟議番号＝知らせの窓から／棚卸 2026-11 など＝今の欄から）。2026-10-30';

-- 権限（取引先マスタの表と同じ＝admin・accounting。知らせは画面から作らない＝insert は service role の sf-intake だけ）
do $$
declare t text;
begin
  foreach t in array array['credit_notice', 'credit_line_test'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tm_sel_%s on public.%I', t, t);
    execute format('drop policy if exists tm_ins_%s on public.%I', t, t);
    execute format('drop policy if exists tm_upd_%s on public.%I', t, t);
    execute format('drop policy if exists tm_del_%s on public.%I', t, t);
    execute format('create policy tm_sel_%s on public.%I for select to authenticated using (app_role() in (''admin'',''accounting''))', t, t);
    execute format('create policy tm_upd_%s on public.%I for update to authenticated using (app_role() in (''admin'',''accounting'')) with check (app_role() in (''admin'',''accounting''))', t, t);
    if t = 'credit_notice' then
      execute format('create policy tm_del_%s on public.%I for delete to authenticated using (app_role() = ''admin'')', t, t);
    else
      execute format('create policy tm_ins_%s on public.%I for insert to authenticated with check (app_role() in (''admin'',''accounting''))', t, t);
      execute format('create policy tm_del_%s on public.%I for delete to authenticated using (app_role() in (''admin'',''accounting''))', t, t);
    end if;
  end loop;
end $$;
revoke all on public.credit_notice, public.credit_line_test from anon;
grant select, update, delete on public.credit_notice to authenticated;
grant select, insert, update, delete on public.credit_line_test to authenticated;
grant usage, select on sequence public.credit_line_test_id_seq to authenticated;

-- 4. 即時配信（sf_export_trigger.sql の notify_sf_export をそのまま使う＝company_id で sf-export を呼ぶ）
drop trigger if exists trg_sfx_credit_line_test on public.credit_line_test;
create trigger trg_sfx_credit_line_test after insert or update or delete on public.credit_line_test
  for each row execute function public.notify_sf_export();

-- 確かめ
select 'credit_notice' as t, count(*) from public.credit_notice
union all select 'credit_line_test', count(*) from public.credit_line_test
union all select 'credit_line（根拠あり）', count(*) from public.credit_line where basis is not null;
select tgname, tgrelid::regclass from pg_trigger where tgname like 'trg_sfx_%' order by 1;

-- 戻し方（上から順に）:
-- drop trigger if exists trg_sfx_credit_line_test on public.credit_line_test;
-- delete from public.credit_line_test;              -- 先に行を消す＝トリガの即時配信で dev6・dev7 の与信が本物の値（多くは空）に戻る（drop だけだと翌朝の全件配信まで残る）
-- drop table if exists public.credit_line_test;
-- drop table if exists public.credit_notice;
-- alter table public.credit_line drop column if exists basis;
