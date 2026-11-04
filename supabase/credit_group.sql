-- credit_group.sql（2026-11-04）: 取引先マスタの「グループ」と「グループの与信」（一括手続先・与信管理規程 KG-10 第20条）
-- 設計: Box ツール【統合管理】\自動化\SF連携設計\グループと与信_設計_2026-11-02.md（坂本さんの決定 §8・11/02 夕方）
-- 考え方: 「グループは事実、グループの与信は決裁」で分けて持つ。
--   グループ      ＝ company.parent_company_id（既存・本番 0 件）＋ 持株比率・確認日・確かめた資料（この SQL で足す）
--   グループの与信 ＝ 子会社の側に与信先 company.credit_holder_id。付け外しは別紙『一括手続先一覧』の記録 credit_group_listing に
--                   トリガが 1 行ずつ残す（常務会の日・決裁番号・入れた人。日時は DB が付ける＝人が決めない）。
--   実効の与信（グループの子会社の限度額・期限・グループの使用額）は view v_credit_effective で読める。画面と sf-export は同じ決まりで計算する。
--   credit_line.use_parent_credit（旧「一括手続先」・本番 29 行すべて false）は使わない。画面からは外した。列を消すのは末尾（後日）。
-- 使い方: SQL Editor で実行（学習用 DB → 本番ハブ の順・何度流しても同じ）。
--   権限（4.3）は環境で分かれる: app_role() がある本番ハブは RLS（admin・accounting だけ読める）、
--   app_role() も user_roles も Auth ユーザーも無い学習用 DB（画面は anon・RLS 無し）は anon が読めて消せる形（書けないのは同じ）。
--   このあと sf-export 2026-11-04.1 を貼り（与信先の限度額・期限とグループの使用額を一括手続先にも配る）、画面（torihikisaki.js）を公開する。
--   sf-export を貼る前でも壊れない（古い sf-export は与信先を知らない＝今までどおり自分の行だけで配る）。
-- 戻し方: 末尾。

-- =====================================================================
-- 1. 会社: 親会社の補足と与信先・別紙の決裁
-- =====================================================================
alter table public.company add column if not exists parent_ownership_pct numeric(5,2);
alter table public.company add column if not exists parent_confirmed_on date;
alter table public.company add column if not exists parent_source varchar(40);
alter table public.company add column if not exists credit_holder_id varchar(8) references public.company(company_id);
alter table public.company add column if not exists credit_listing_decided_on date;
alter table public.company add column if not exists credit_listing_ref varchar(60);
alter table public.company drop constraint if exists ck_company_parent_pct;
alter table public.company add constraint ck_company_parent_pct check (parent_ownership_pct is null or (parent_ownership_pct >= 0 and parent_ownership_pct <= 100));
comment on column public.company.parent_company_id is '直接の親会社（取引先マスタ番号・1 段上だけ）。頂点は親をたどって計算する（表には持たない）';
comment on column public.company.parent_ownership_pct is '親の持株比率（%・分からなければ空）';
comment on column public.company.parent_confirmed_on is '親子関係を確かめた日';
comment on column public.company.parent_source is '何で確かめたか（有価証券報告書・登記・帝国データバンク・Sansan など）';
comment on column public.company.credit_holder_id is '与信先。この会社の与信を、どの会社の限度額でまかなうか（同じグループの上の会社・自分で与信を取っている会社に限る）。空＝自分の与信。規程 KG-10 第20条の一括手続先';
comment on column public.company.credit_listing_decided_on is '別紙『一括手続先一覧』に載せた（外した）常務会の日';
comment on column public.company.credit_listing_ref is 'その決裁番号など';
create index if not exists ix_company_parent on public.company (parent_company_id) where parent_company_id is not null;
create index if not exists ix_company_credit_holder on public.company (credit_holder_id) where credit_holder_id is not null;

-- =====================================================================
-- 2. 決まりを DB で守る（画面・CSV・SQL のどこから入れても同じ）
--   ・親に自分は指定できない／親子が輪にならない
--   ・与信先は、親をたどった先（同じグループの上の会社）で、自分で与信を取っている会社（与信先がさらに与信先を持たない＝2 段で借りない）
--   ・与信不要先にはグループの与信を付けない（1 社 1 つの取り方）
--   ・誰かの与信先になっている会社は、自分がグループの与信にはなれない（先にその会社の与信先を変える）
--   親を付け替えたせいで「与信先が上の会社でなくなる」孫の会社は止めない（画面と view で赤く出し、経理が直す）
-- =====================================================================
create or replace function public.company_group_guard() returns trigger
language plpgsql as $$
declare
  cur varchar(8);
  hops int;
  holder_found boolean := false;  -- found は plpgsql の予約の変数なので使わない
  holder_holder varchar(8);
  n_members int;
begin
  if new.parent_company_id is not null and new.parent_company_id = new.company_id then
    raise exception '親会社に自分自身（%）は指定できません', new.company_id;
  end if;
  -- 輪の検査: 新しい親から上へたどって自分に戻らない
  cur := new.parent_company_id; hops := 0;
  while cur is not null loop
    if cur = new.company_id then
      raise exception '親会社の指定が輪になります（% の上に % が既にあります）', new.parent_company_id, new.company_id;
    end if;
    hops := hops + 1;
    if hops > 50 then raise exception '親会社の階層が深すぎます（50 段超）'; end if;
    select parent_company_id into cur from public.company where company_id = cur;
  end loop;
  if new.credit_holder_id is not null then
    if new.credit_holder_id = new.company_id then raise exception '与信先に自分自身は指定できません'; end if;
    if new.credit_exempt then raise exception '与信不要先にはグループの与信（与信先）を付けられません。与信の取り方は 1 つにしてください'; end if;
    -- 与信先は親をたどった先にある
    cur := new.parent_company_id; hops := 0;
    while cur is not null loop
      if cur = new.credit_holder_id then holder_found := true; exit; end if;
      hops := hops + 1; exit when hops > 50;
      select parent_company_id into cur from public.company where company_id = cur;
    end loop;
    if not holder_found then
      raise exception '与信先（%）は、この会社（%）の親会社をたどった先にありません。先に親会社を入れるか、親を変えるなら先にグループの与信を外してください', new.credit_holder_id, new.company_id;
    end if;
    -- 与信先は自分で与信を取っている会社（2 段で借りない）
    select credit_holder_id into holder_holder from public.company where company_id = new.credit_holder_id;
    if holder_holder is not null then
      raise exception '与信先（%）自身がグループの与信（与信先 %）です。与信先は自分で与信を取っている会社にしてください', new.credit_holder_id, holder_holder;
    end if;
    -- 自分が誰かの与信先なら、グループの与信にはなれない
    select count(*) into n_members from public.company where credit_holder_id = new.company_id and company_id <> new.company_id;
    if n_members > 0 then
      raise exception 'この会社（%）は % 社の与信先です。先にその会社の与信先を変えてください', new.company_id, n_members;
    end if;
  end if;
  return new;
end $$;
comment on function public.company_group_guard() is 'グループ（親会社）と与信先の決まりを守る（credit_group.sql・2026-11-04）';
drop trigger if exists trg_company_group_guard on public.company;
create trigger trg_company_group_guard before insert or update of parent_company_id, credit_holder_id, credit_exempt on public.company
  for each row execute function public.company_group_guard();

-- =====================================================================
-- 3. 別紙『一括手続先一覧』の記録（誰を・いつの常務会で・どの与信先の下に載せたか・外したか）
--   人が直接は書けない（insert のポリシー無し）。company.credit_holder_id が変わるたびにトリガが 1 行残す。
-- =====================================================================
create table if not exists public.credit_group_listing (
  id            bigserial primary key,
  member_id     varchar(8) not null references public.company(company_id),   -- 一括手続先（子会社）
  holder_id     varchar(8) not null references public.company(company_id),   -- 与信先
  action        varchar(10) not null check (action in ('載せる', '外す')),
  ownership_pct numeric(5,2),                                                -- そのときの持株比率（直接の親の比率）
  decided_on    date,                                                        -- 常務会の日
  decision_ref  varchar(60),                                                 -- 決裁番号など
  created_at    timestamptz not null default now(),                          -- DB が付ける
  created_by    varchar(80)
);
comment on table public.credit_group_listing is '別紙『一括手続先一覧』の記録（規程 KG-10 第20条）。company.credit_holder_id の付け外しをトリガが残す。内部監査で「いつから一括手続先か」を示す正本（2026-11-04）';
create index if not exists ix_credit_group_listing_member on public.credit_group_listing (member_id, created_at desc);
create index if not exists ix_credit_group_listing_holder on public.credit_group_listing (holder_id, created_at desc);
-- 権限（RLS・anon の取り上げ）は 4.3 で環境ごとに付ける

create or replace function public.company_credit_listing_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who varchar(80);
begin
  if tg_op = 'UPDATE' and new.credit_holder_id is not distinct from old.credit_holder_id then return null; end if;
  if tg_op = 'INSERT' and new.credit_holder_id is null then return null; end if;
  -- 入れた人＝画面が company.updated_by に入れる名前。無ければログインのメール、無ければ DB のロール
  who := coalesce(nullif(new.updated_by, ''), nullif(new.created_by, ''),
                  nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''), current_user);  -- 設定が '' のことがある（auth.jwt() と同じ守り）
  if tg_op = 'UPDATE' and old.credit_holder_id is not null then
    insert into public.credit_group_listing (member_id, holder_id, action, ownership_pct, decided_on, decision_ref, created_by)
    values (new.company_id, old.credit_holder_id, '外す', new.parent_ownership_pct, new.credit_listing_decided_on, new.credit_listing_ref, who);
  end if;
  if new.credit_holder_id is not null then
    insert into public.credit_group_listing (member_id, holder_id, action, ownership_pct, decided_on, decision_ref, created_by)
    values (new.company_id, new.credit_holder_id, '載せる', new.parent_ownership_pct, new.credit_listing_decided_on, new.credit_listing_ref, who);
  end if;
  return null;
end $$;
comment on function public.company_credit_listing_log() is '与信先の付け外しを別紙の記録（credit_group_listing）に残す（credit_group.sql・2026-11-04）';
drop trigger if exists trg_company_credit_listing on public.company;
create trigger trg_company_credit_listing after insert or update of credit_holder_id on public.company
  for each row execute function public.company_credit_listing_log();

-- =====================================================================
-- 4. 読むための view（表には持たない＝親を付け替えたときの直し忘れを無くす）
--   security_invoker＝読む人の権限（company・credit_line の RLS＝admin／accounting）で動く。PG15 以上。
-- =====================================================================
-- 4.1 グループ: 会社ごとに 頂点（root_id）・深さ・頂点からの道（path）・直接の子の数
create or replace view public.v_company_group with (security_invoker = true) as
with recursive up as (
  select c.company_id, c.parent_company_id, c.company_id as root_id, 0 as depth, array[c.company_id]::varchar[] as path  -- ::varchar[] が要る（varchar(8)[] のままだと再帰側の || の結果 varchar[] と型が合わない）
  from public.company c where c.parent_company_id is null
  union all
  select c.company_id, c.parent_company_id, up.root_id, up.depth + 1, up.path || c.company_id
  from public.company c join up on c.parent_company_id = up.company_id
  where up.depth < 50
)
select up.company_id, up.parent_company_id, up.root_id, up.depth, up.path,
       (select count(*) from public.company k where k.parent_company_id = up.company_id) as child_count
from up;
comment on view public.v_company_group is 'グループ（親をたどった頂点・深さ・道）。輪になった会社は出ない（トリガで防いでいる）';

-- 4.2 実効の与信: 与信の取り方（自分／グループ／不要）・与信先・限度額など（与信先の行）・グループの使用額（与信先＋一括手続先の合計）・確認が要る印
create or replace view public.v_credit_effective with (security_invoker = true) as
with cl as (  -- credit_line は 1 社 1 行の運用。複数あれば後の行（credit_id の大きい方＝sf-export と同じ）
  select distinct on (company_id) company_id, limit_amount, limit_type, valid_until, approved_on, decided_by, used_amount
  from public.credit_line order by company_id, credit_id desc
),
mem as (  -- 与信先ごとの「与信先＋その下の一括手続先」
  select company_id as holder_id, company_id as member_id from public.company where credit_holder_id is null
  union all
  select credit_holder_id, company_id from public.company where credit_holder_id is not null
),
grp as (
  select m.holder_id, sum(cl.used_amount) as used_sum, count(*) filter (where m.member_id <> m.holder_id) as member_count
  from mem m left join cl on cl.company_id = m.member_id
  group by m.holder_id
)
select c.company_id, c.official_name,
       case when c.credit_exempt then '不要' when c.credit_holder_id is not null then 'グループ' else '自分' end as credit_mode,
       coalesce(c.credit_holder_id, c.company_id) as holder_id,
       h.official_name as holder_name,
       hc.limit_amount, hc.limit_type, hc.valid_until, hc.approved_on, hc.decided_by,
       own.used_amount as own_used_amount,
       g.used_sum as group_used_amount,
       case when hc.limit_amount is not null then hc.limit_amount - coalesce(g.used_sum, 0) end as remaining,
       coalesce(g.member_count, 0) as member_count,
       c.credit_listing_decided_on, c.credit_listing_ref,
       (c.credit_holder_id is not null and own.limit_amount is not null) as own_credit_conflict,      -- 第4条「1 件限り」に反する（自分の行が残っている）
       (c.credit_holder_id is not null and hc.limit_amount is null)      as holder_without_credit,   -- 与信先に限度額が無い
       (c.credit_holder_id is not null and not (c.credit_holder_id = any(coalesce(vg.path, array[]::varchar[])))) as holder_not_ancestor  -- 親を付け替えて与信先が上の会社でなくなった
from public.company c
left join public.v_company_group vg on vg.company_id = c.company_id
left join public.company h on h.company_id = coalesce(c.credit_holder_id, c.company_id)
left join cl hc on hc.company_id = coalesce(c.credit_holder_id, c.company_id)
left join cl own on own.company_id = c.company_id
left join grp g on g.holder_id = coalesce(c.credit_holder_id, c.company_id);
comment on view public.v_credit_effective is '実効の与信（グループの子会社は与信先の行・使用額はグループの合計）。画面と sf-export は同じ決まりで計算する（credit_group.sql・2026-11-04）';
-- 4.3 権限（取引先マスタの表と同じ＝admin・accounting だけ読める。別紙の記録は人が書けない＝select 以外のポリシー無し）
--   学習用 DB（iinbncpofqaldpygfryz）には user_roles も app_role() も Auth ユーザーも無く、画面も検証スクリプトも anon で動く（RLS 無し・2026-08-26 の前提）。
--   app_role() が無ければ学習用と見なし、RLS と anon の取り上げはしない（本番と同じ形は作れないため）。本番ハブには app_role() がある。
do $$
begin
  if to_regproc('public.app_role') is not null then
    -- 本番ハブ
    execute 'alter table public.credit_group_listing enable row level security';
    execute 'drop policy if exists learning_sel_credit_group_listing on public.credit_group_listing';
    execute 'drop policy if exists learning_del_credit_group_listing on public.credit_group_listing';
    execute 'drop policy if exists tm_sel_credit_group_listing on public.credit_group_listing';
    execute 'create policy tm_sel_credit_group_listing on public.credit_group_listing for select to authenticated using (public.app_role() in (''admin'',''accounting''))';
    execute 'revoke all on public.credit_group_listing from anon';
    execute 'revoke insert, update, delete on public.credit_group_listing from authenticated';
    execute 'grant select on public.credit_group_listing to authenticated';
    execute 'revoke all on public.v_company_group, public.v_credit_effective from anon';
    execute 'grant select on public.v_company_group, public.v_credit_effective to authenticated';
  else
    -- 学習用 DB（検証スクリプト verify_torihikisaki_group.py が anon で読み、片付けで別紙の記録を消す。人が書けないのは本番と同じ）
    execute 'alter table public.credit_group_listing disable row level security';
    execute 'revoke insert, update on public.credit_group_listing from anon, authenticated';
    execute 'grant select, delete on public.credit_group_listing to anon, authenticated';
    execute 'grant select on public.v_company_group, public.v_credit_effective to anon, authenticated';
    -- Supabase は新しい表に RLS を付けることがある（disable_rls_learning.sql の前提。2026-11-04 は上の disable のあとも掛かっていて anon から 0 行に見えた）。
    -- RLS が掛かっていてもいなくても同じに読めて消せるよう、ポリシーも置く
    execute 'drop policy if exists learning_sel_credit_group_listing on public.credit_group_listing';
    execute 'drop policy if exists learning_del_credit_group_listing on public.credit_group_listing';
    execute 'create policy learning_sel_credit_group_listing on public.credit_group_listing for select to anon, authenticated using (true)';
    execute 'create policy learning_del_credit_group_listing on public.credit_group_listing for delete to anon, authenticated using (true)';
  end if;
end $$;

-- =====================================================================
-- 5. 確かめ
-- =====================================================================
select (to_regproc('public.app_role') is not null) as prod_form,                                                     -- 本番ハブ true／学習用 false
       (select relrowsecurity from pg_class where oid = 'public.credit_group_listing'::regclass) as listing_rls,      -- 本番 true／学習用 false
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'credit_group_listing') as listing_policies;  -- 本番 1／学習用 2
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'company'
   and column_name in ('parent_ownership_pct','parent_confirmed_on','parent_source','credit_holder_id','credit_listing_decided_on','credit_listing_ref')
 order by column_name;                                                                       -- 6 行
select tgname from pg_trigger where tgname in ('trg_company_group_guard','trg_company_credit_listing') order by 1;  -- 2 行
select (select count(*) from public.company where parent_company_id is not null) as with_parent,
       (select count(*) from public.company where credit_holder_id is not null) as with_holder,
       (select count(*) from public.credit_group_listing) as listing_rows,
       (select count(*) from public.v_credit_effective where credit_mode = 'グループ') as group_mode;  -- 初回は全部 0

-- =====================================================================
-- 戻し方（上から順に・別紙の記録ごと消えるので本番では慎重に）
-- =====================================================================
-- drop view if exists public.v_credit_effective;
-- drop view if exists public.v_company_group;
-- drop trigger if exists trg_company_credit_listing on public.company;  drop function if exists public.company_credit_listing_log();
-- drop trigger if exists trg_company_group_guard on public.company;     drop function if exists public.company_group_guard();
-- drop table if exists public.credit_group_listing;
-- alter table public.company drop constraint if exists ck_company_parent_pct;
-- alter table public.company drop column if exists credit_listing_ref, drop column if exists credit_listing_decided_on,
--   drop column if exists credit_holder_id, drop column if exists parent_source, drop column if exists parent_confirmed_on, drop column if exists parent_ownership_pct;
-- （sf-export は 2026-10-30.1 に貼り直す・画面は main の 8f9d569 に戻す）
--
-- 旧「一括手続先」の列を消すとき（新しい欄へ移したあと・本番 29 行すべて false を確かめてから）:
-- alter table public.credit_line drop column if exists use_parent_credit;
