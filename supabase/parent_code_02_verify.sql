-- parent_code_02_verify.sql（2026-10-21）: 付け替え（parent_code_01_migrate.sql）のあとに SQL Editor で実行して確かめる（読むだけ）
-- SQL Editor は最後の問い合わせの結果しか出さないので、確かめは 1 つの表にまとめてある。
-- 期待: ① 今＝控え（全部の表で同じ数） ② 5桁でない鍵 0・本物の帯の数＝会社の数 ③ 参照切れ 0・旧の鍵なし 0 ④ 採番の次＝本物の最大＋1 ⑤ 札に torihikisaki_code が無い
with child as (
  select distinct c.relname as tbl
  from pg_constraint k join pg_class c on c.oid = k.conrelid
  where k.contype = 'f' and k.confrelid = 'public.company'::regclass
  union select 'company'
),
counts as (
  select tbl,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', tbl), false, true, '')))[1]::text as now_n,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from bak_parent_code.%I', tbl), false, true, '')))[1]::text as bak_n
  from child
)
select '① 件数 今/控え（表ごと）' as check, string_agg(tbl || ' ' || now_n || '/' || bak_n, '・' order by tbl) as value from counts
union all select '① 件数が違う表', coalesce(string_agg(tbl, '・'), '（なし）') from counts where now_n <> bak_n
union all select '② 5 桁でない鍵（0 が正）', count(*)::text from company where company_id !~ '^\d{5}$'
union all select '② 帯の数 試験/自社/本物', count(*) filter (where company_id between '00001' and '09999')::text || ' / ' || count(*) filter (where company_id = '10000')::text || ' / ' || count(*) filter (where company_id >= '10001')::text from company
union all select '② 鍵の最小〜最大', min(company_id) || '〜' || max(company_id) from company
union all select '③ 旧の鍵の無い会社（0 が正）', count(*)::text from company where legacy_company_id is null
union all select '③ 親会社の参照切れ（0 が正）', count(*)::text from company c where parent_company_id is not null and not exists (select 1 from company p where p.company_id = c.parent_company_id)
union all select '③ 統合先の参照切れ（0 が正）', count(*)::text from company c where suspend_merged_into is not null and not exists (select 1 from company p where p.company_id = c.suspend_merged_into)
union all select '③ 例（新 ← 旧 社名）', string_agg(company_id || ' ← ' || legacy_company_id || ' ' || official_name, ' / ') from (select * from company order by company_id limit 3) x
union all select '④ 採番 本物の最大 / 順序の値', (select max(company_id::int) from company where company_id >= '10001')::text || ' / ' || (select last_value from parent_code_seq)::text
union all select '④ 試験の帯の次（読むだけ）', next_parent_code('test')
union all select '⑤ 札（system: 件数）', coalesce(string_agg(system || ': ' || n, '・'), '（なし）') from (select system, count(*) as n from system_code group by system order by system) s;
