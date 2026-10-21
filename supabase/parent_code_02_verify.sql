-- parent_code_02_verify.sql（2026-10-21）: 付け替えのあとに SQL Editor で実行して確かめる（読むだけ）
-- 期待: ①全部の表で「今」と「控え」の件数が同じ ②鍵は 5 桁だけ ③参照の孤児 0 ④採番が 10001〜の最大の次

-- ① 件数（今 vs 控え）
select t.relname as tbl,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.relname), false, true, '')))[1]::text::int as now_n,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from bak_parent_code.%I', t.relname), false, true, '')))[1]::text::int as bak_n
from (select distinct c.relname from pg_constraint k join pg_class c on c.oid = k.conrelid
      where k.contype = 'f' and k.confrelid = 'public.company'::regclass
      union select 'company') t
order by 1;

-- ② 鍵の形（5 桁だけ＝bad が 0）・帯ごとの数
select count(*) filter (where company_id !~ '^\d{5}$') as bad,
       count(*) filter (where company_id between '00001' and '09999') as test_band,
       count(*) filter (where company_id = '10000') as own,
       count(*) filter (where company_id >= '10001') as real_band,
       min(company_id), max(company_id)
from company;

-- ③ 旧の鍵との対応（例 5 件）と、親会社・統合先の参照
select company_id, legacy_company_id, official_name from company order by company_id limit 5;
select count(*) as parent_refs_ok from company c where parent_company_id is null or exists (select 1 from company p where p.company_id = c.parent_company_id);
select count(*) as merged_refs_dangling from company c where suspend_merged_into is not null and not exists (select 1 from company p where p.company_id = c.suspend_merged_into);

-- ④ 採番（次に振られる本物の番号＝max+1）
select last_value as seq_last, (select max(company_id::int) from company where company_id >= '10001') as max_real from parent_code_seq;
select next_parent_code('test') as next_test_preview;  -- 試験の帯の次（読むだけ・番号は消費しない）

-- ⑤ 札（親コードの札は消えている・SF の札は残っている）
select system, count(*) from system_code group by system order by 1;
