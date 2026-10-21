-- parent_code_09_rollback.sql（2026-10-21）: 付け替え（parent_code_01_migrate.sql）を控え bak_parent_code から戻す
-- 使い方: 付け替えの直後に問題が出たときだけ。控えのあとに入った変更（会社の追加・編集）は失われる。SQL Editor で全文を 1 回実行。
begin;

-- トリガを止める
do $$
declare t text;
begin
  for t in
    select distinct c.relname from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass
    union select 'company'
  loop
    execute format('alter table public.%I disable trigger user', t);
  end loop;
end $$;

-- 子の表 → company → integration_log を空にして、控えから戻す（列は控えの列で合わせる）
do $$
declare t text; cols text;
begin
  for t in
    select distinct c.relname from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass and c.relname <> 'company'
  loop
    execute format('delete from public.%I', t);
  end loop;
  delete from company;
  alter table company drop constraint if exists company_id_5digits;
  alter table company drop column if exists is_test;
  alter table company drop column if exists legacy_company_id;
  -- company を先に
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns where table_schema = 'bak_parent_code' and table_name = 'company';
  execute format('insert into public.company (%s) select %s from bak_parent_code.company', cols, cols);
  -- 子の表
  for t in
    select distinct c.relname from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass and c.relname <> 'company'
  loop
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns where table_schema = 'bak_parent_code' and table_name = t;
    execute format('insert into public.%I (%s) select %s from bak_parent_code.%I', t, cols, cols, t);
  end loop;
  -- 連携ログ（控えがあるときだけ）
  if to_regclass('bak_parent_code.integration_log') is not null then
    delete from integration_log;
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns where table_schema = 'bak_parent_code' and table_name = 'integration_log';
    execute format('insert into public.integration_log (%s) select %s from bak_parent_code.integration_log', cols, cols);
  end if;
end $$;

drop function if exists next_parent_code(text);
drop sequence if exists parent_code_seq;
drop table if exists company_id_map;

-- トリガを戻す
do $$
declare t text;
begin
  for t in
    select distinct c.relname from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass
    union select 'company'
  loop
    execute format('alter table public.%I enable trigger user', t);
  end loop;
end $$;

commit;
-- 戻したあと: 旧版の sf-intake／sf-export（2026-10-20.x）を貼り直す。
