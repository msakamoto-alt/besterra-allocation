-- company_main_type.sql（2026-11-04）: 取引先マスタの「種別のメイン」
-- 坂本さん 11/04「種別にメインとサブで切り分けを」。発注先の種別（外注・リース・資材など）が 2 つ以上の会社で、どれがメインかを持つ。
-- 使い道: SF の原価要素につなぐ（10/29 刷新PJ 第 4 回の宿題 9「原価要素コードの付け方＝工種との対比表、取引先に持たせる案」）。
-- 決まり:
--   ・発注先の種別が 1 つならそれがメイン（この列は空のままでよい）。計算は画面（mainTypeCandidates）と sf-export（mainTypeOf）が同じ決まりで行う
--   ・顧客・施主・スクラップ・グループの親は候補にしない（発注の原価に関係しない）
--   ・種別から外された値がこの列に残っていても、画面と sf-export は無視する
-- 流す順: 学習用 → 本番ハブ（何度流しても同じ）。sf-export 2026-11-04.2 と画面より先に流す。流す前の確かめ＝supabase/tests/credit_group.test.mjs

alter table public.company add column if not exists main_type_code varchar(20);
comment on column public.company.main_type_code is '種別のメイン（company_type.type_code の値）。発注先の種別が 2 つ以上の会社で選ぶ。1 つならそれがメインなので空のまま（company_main_type.sql・2026-11-04）';

-- 確かめ（SQL Editor は最後の結果だけを出す）
select (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'company' and column_name = 'main_type_code') as new_column,  -- 1
       (select count(*) from public.company where main_type_code is not null) as with_main;                           -- 初回は 0

-- 戻し方（画面と sf-export を前の版に戻してから）:
-- alter table public.company drop column if exists main_type_code;
