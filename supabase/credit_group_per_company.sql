-- credit_group_per_company.sql（2026-11-25）: グループの与信「限度額は会社ごと、グループの限度額は合計」
-- 経緯: 11/04 の作り（credit_group.sql）は「枠はグループに 1 つ。一括手続先は与信先の行を読むだけで、自分の与信の行は持たせない」。
--       第54期の与信管理表【与信枠（一括）】は会社ごとに枠を決めていて（小計は各社の額の合計）、取引先マスタにも会社ごとの額が入っている（経理 2026-11-25）。
--       → グループの与信の会社にも会社ごとの与信の行を持たせる。グループの限度額・使用額は、与信先＋その下の一括手続先の合計。
--       限度額の無い会社（取引の無い親）も与信先にできる（決まりのトリガは 11/04 のまま＝もともと限度額の有無は見ていない）。
-- この SQL が変えるもの: 読むための view v_credit_effective の中身と、列の説明 1 つだけ。
--   ・限度額・種類・期限・決裁日・使用額・残り（remaining）＝会社ごとの行（11/04 は与信先の行）
--   ・group_limit_amount・group_used_amount・group_remaining＝グループの合計（欠番の会社の限度額は数えない）。どちらでもない会社は自分 1 社の値
--   ・own_credit_conflict（自分の行が残っている）・holder_without_credit（与信先に限度額が無い）の 2 列は無くなる（確かめる必要が無くなった）
--   表・データ・トリガ（決まり・別紙の記録）・権限の形は変えない。画面（torihikisaki.js）と sf-export（2026-11-25.1）は、同じ決まりを自分で計算する（view は読まない）。
-- 使い方: SQL Editor で実行（何度流しても同じ・途中で止まれば何も変わらない＝DO ブロック 1 つ）。
--   view の定義は credit_group.sql 本体の 4.2 と同じ（supabase/tests/credit_group.test.mjs が同じになることを確かめる）。
-- 順番: この SQL・sf-export 2026-11-25.1・画面の公開は、どの順でも壊れない（view を読むのは SQL だけ）。
-- 戻し方: 末尾。

do $do$
begin
  if to_regclass('public.v_company_group') is null or to_regclass('public.credit_group_listing') is null then
    raise exception '先に credit_group.sql を流してください（v_company_group・credit_group_listing がありません）';
  end if;
  execute 'drop view if exists public.v_credit_effective';
  execute $v$
create view public.v_credit_effective with (security_invoker = true) as
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
  select m.holder_id,
         sum(cl.limit_amount) filter (where not coalesce(mc.is_suspended, false)) as limit_sum,
         sum(cl.used_amount) as used_sum,
         count(*) filter (where m.member_id <> m.holder_id) as member_count
  from mem m
  join public.company mc on mc.company_id = m.member_id
  left join cl on cl.company_id = m.member_id
  group by m.holder_id
)
select c.company_id, c.official_name,
       case when c.credit_exempt then '不要' when c.credit_holder_id is not null then 'グループ' else '自分' end as credit_mode,
       coalesce(c.credit_holder_id, c.company_id) as holder_id,
       h.official_name as holder_name,
       own.limit_amount, own.limit_type, own.valid_until, own.approved_on, own.decided_by,
       own.used_amount as own_used_amount,
       case when own.limit_amount is not null then own.limit_amount - coalesce(own.used_amount, 0) end as remaining,
       g.limit_sum as group_limit_amount,
       g.used_sum as group_used_amount,
       case when g.limit_sum is not null then g.limit_sum - coalesce(g.used_sum, 0) end as group_remaining,
       coalesce(g.member_count, 0) as member_count,
       c.credit_listing_decided_on, c.credit_listing_ref,
       (c.credit_holder_id is not null and not (c.credit_holder_id = any(coalesce(vg.path, array[]::varchar[])))) as holder_not_ancestor  -- 親を付け替えて与信先が上の会社でなくなった
from public.company c
left join public.v_company_group vg on vg.company_id = c.company_id
left join public.company h on h.company_id = coalesce(c.credit_holder_id, c.company_id)
left join cl own on own.company_id = c.company_id
left join grp g on g.holder_id = coalesce(c.credit_holder_id, c.company_id)
  $v$;
  execute $c$comment on view public.v_credit_effective is '与信（会社ごとの行）とグループの合計（与信先＋一括手続先・欠番の会社の限度額は数えない）。画面と sf-export は同じ決まりで計算する（credit_group.sql・2026-11-25 改定）'$c$;
  execute $c$comment on column public.company.credit_holder_id is '与信先（同じグループの上の会社・自分がグループの与信でない会社に限る）。入っている会社＝規程 KG-10 第20条の一括手続先。空＝単体の与信。限度額は会社ごとに credit_line に持ち、グループの限度額は与信先＋一括手続先の合計（2026-11-25）'$c$;
  -- 権限は credit_group.sql の 4.3 と同じ形（作り直した view には既定の権限が付くので、付け直す）
  if to_regproc('public.app_role') is not null then
    execute 'revoke all on public.v_credit_effective from anon';                 -- 本番ハブ: 読めるのは authenticated（RLS は company・credit_line の側で admin・accounting）
    execute 'grant select on public.v_credit_effective to authenticated';
  else
    execute 'grant select on public.v_credit_effective to anon, authenticated';  -- 学習用 DB
  end if;
end $do$;

-- 確かめ（SQL Editor は最後の結果だけを出すので、見る値を 1 行にまとめる）
select (to_regproc('public.app_role') is not null) as prod_form,                                                                -- 本番ハブ true／学習用 false
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'v_credit_effective'
          and column_name in ('group_limit_amount', 'group_remaining')) as new_columns,                                        -- 2
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'v_credit_effective'
          and column_name in ('own_credit_conflict', 'holder_without_credit')) as old_columns,                                 -- 0
       has_table_privilege('anon', 'public.v_credit_effective', 'select') as anon_can_read,                                     -- 本番 false／学習用 true
       has_table_privilege('authenticated', 'public.v_credit_effective', 'select') as auth_can_read,                           -- true
       (select count(*) from public.v_credit_effective) as companies,                                                          -- 会社の数と同じ
       (select count(*) from public.v_credit_effective where limit_amount is not null) as with_limit,                          -- 限度額が入っている会社の数
       (select coalesce(sum(limit_amount), 0) from public.v_credit_effective) as limit_total,                                  -- 限度額の合計（会社ごとの行をそのまま足した額）
       (select count(*) from public.v_credit_effective where credit_mode = 'グループ') as group_mode                           -- グループの与信の会社の数
limit 100;

-- 戻し方（11/04 の形に戻す）: git の f4dc89b の supabase/credit_group.sql の 4.2（create or replace view … comment on view …）を、
--   drop view if exists public.v_credit_effective; のあとに流し、同じファイルの 4.3 の権限（revoke／grant）を流す。
--   あわせて sf-export を 2026-11-24.1 に貼り直し、画面は main の f4dc89b に戻す。
