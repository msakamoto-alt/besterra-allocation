-- parent_code_03_delete_test.sql（2026-10-21）: 試験の会社（is_test＝dev6・dev7 などから来た箱・帯 00001〜09999）をまとめて消す
-- 使い方: SQL Editor で実行。消す前に件数を見る（最初の select）。消した番号は試験の帯で使い回される（next_parent_code('test') は最大＋1）。
-- 注意: 本物の会社（is_test=false）には触らない。integration_log の参照は残す（履歴）。

select count(*) as test_companies, min(company_id), max(company_id) from company where is_test;

do $$
declare r record; n int;
begin
  -- company を参照する表から先に消す（company 自身の parent_company_id は null に）
  update company set parent_company_id = null where parent_company_id in (select company_id from company where is_test);
  for r in
    select c.relname as tbl, a.attname as col
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any(k.conkey)
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass and c.relname <> 'company'
  loop
    execute format('delete from public.%I t where t.%I in (select company_id from company where is_test)', r.tbl, r.col);
  end loop;
  delete from company where is_test;
  get diagnostics n = row_count;
  raise notice '試験の会社を % 件消しました', n;
end $$;

select count(*) as remaining_test from company where is_test;
