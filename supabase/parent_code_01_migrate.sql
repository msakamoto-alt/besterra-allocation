-- parent_code_01_migrate.sql（2026-10-21・v2）
-- 会社マスタの鍵（company.company_id）を「取引先番号の親コード（5 桁）」に付け替える。坂本さん決定 10/21（案 B＝番号は一本・振るのはハブ）。
--
-- 帯: 00001〜09999 ＝ 試験（dev6・dev7 など本番でない org からの箱。消したら使い回してよい）
--     10000       ＝ ベステラ自社（予約・自動では振らない）
--     10001〜99999 ＝ 本物（一度付いたら変えない・欠番は使い回さない）
-- 既存の会社は今の company_id（8 桁の連番）の順に 10001〜 を付ける。旧の鍵は company.legacy_company_id に残す。
--
-- 作り（v2）: 鍵を **その場で書き換える**（行の複製はしない＝法人番号などの一意の制約に当たらない）。
--   company を参照する外部キーを一時的に「遅延」にして、親と子を同じトランザクションの中で書き換え、最後に検査する。
--   外部キーを戻す・トリガを戻す・鍵の形の決まり・採番は、2 つ目のトランザクションで行う（1 つ目の中では ALTER TABLE ができないため）。
--
-- 使い方: 本番ハブを止めた時間帯に、SQL Editor でこのファイル全文を 1 回だけ実行（学習用で先に通す）。
--        実行前: dev6 の「ハブ送信の設定」の「送信する」を切る（Claude が切る）。経理に周知。
--        実行後: parent_code_02_verify.sql で確かめる → sf-intake／sf-export（2026-10-21.1）を貼る → sf-export action=rekey（dev6 の鍵を付け替え）→ 全件配信。
--        戻し方: parent_code_09_rollback.sql（控え bak_parent_code から戻す）。
--        途中で止まったときは、ここまでの変更は全部取り消される（1 つ目のトランザクション）。

-- ===================== 1 つ目: 控え・対応表・付け替え =====================
begin;

-- 0) 前提の確認（8 桁の鍵だけがある・付け替え済みなら止める）
do $$
declare n8 int; n5 int; nx int;
begin
  select count(*) into n8 from company where company_id ~ '^\d{8}$';
  select count(*) into n5 from company where company_id ~ '^\d{5}$';
  select count(*) into nx from company where company_id !~ '^\d{8}$';
  if n5 > 0 then raise exception '既に 5 桁の鍵があります（付け替え済み？）: % 件', n5; end if;
  if nx > 0 then raise exception '数字 8 桁でない鍵が % 件あります。先に直してください', nx; end if;
  if n8 = 0 then raise exception '会社がありません'; end if;
  if n8 > 89999 then raise exception '会社が % 件＝本物の帯（10001〜99999）に収まりません', n8; end if;
end $$;

-- 1) 控え（スキーマ bak_parent_code に、company を参照する表・company・integration_log を複製）
create schema if not exists bak_parent_code;
do $$
declare t text;
begin
  for t in
    select distinct c.relname from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass
    union select 'company'
    union select 'integration_log' where to_regclass('public.integration_log') is not null  -- 学習用には無いことがある
  loop
    execute format('drop table if exists bak_parent_code.%I', t);
    execute format('create table bak_parent_code.%I as table public.%I', t, t);
  end loop;
end $$;

-- 2) 対応表（今の鍵の順に 10001〜）
drop table if exists company_id_map;
create table company_id_map (old_id varchar(8) primary key, new_id varchar(8) not null unique, mapped_at timestamptz not null default now());
insert into company_id_map (old_id, new_id)
select company_id, (10000 + row_number() over (order by company_id))::text from company;

-- 3) 列を足す（試験の印・旧の鍵）
alter table company add column if not exists is_test boolean not null default false;
alter table company add column if not exists legacy_company_id varchar(8);

-- 4) 即時配信などのトリガを止め、company を参照する外部キーを「遅延」にする（親と子を続けて書き換えるため）
do $$
declare r record; t text;
begin
  for t in
    select distinct c.relname from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass
    union select 'company'
  loop
    execute format('alter table public.%I disable trigger user', t);
  end loop;
  for r in
    select c.relname as tbl, k.conname
    from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass
  loop
    execute format('alter table public.%I alter constraint %I deferrable initially deferred', r.tbl, r.conname);
  end loop;
end $$;

-- 5) 付け替え（その場で書き換え: 親 → 参照している列 → 旧の鍵を持つその他の列）
do $$
declare r record;
begin
  update company c set company_id = m.new_id, legacy_company_id = m.old_id from company_id_map m where c.company_id = m.old_id;
  for r in
    select c.relname as tbl, a.attname as col
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any(k.conkey)
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass
  loop
    execute format('update public.%I t set %I = m.new_id from company_id_map m where t.%I = m.old_id', r.tbl, r.col, r.col);
  end loop;
  update company set suspend_merged_into = m.new_id from company_id_map m where company.suspend_merged_into = m.old_id;
  if to_regclass('public.integration_log') is not null then
    update integration_log
       set company_ids = (select array_agg(coalesce(m.new_id, x)) from unnest(company_ids) x left join company_id_map m on m.old_id = x)
     where company_ids is not null;
  end if;
end $$;

-- 6) 外部キーの検査をここで走らせる（食い違いがあればここで止まり、全部取り消される）
set constraints all immediate;

-- 7) 札の整理（親コードの札は鍵そのものになったので消す。SF の取引先 Id の札は残す）
delete from system_code where system = 'torihikisaki_code';

-- 8) 確認（件数が控えと同じ・鍵は全部 5 桁・旧の鍵が全部残っている）
do $$
declare n_bak int; n_now int; n_leg int; n_bad int;
begin
  select count(*) into n_bak from bak_parent_code.company;
  select count(*) into n_now from company;
  select count(*) into n_leg from company where legacy_company_id is not null;
  select count(*) into n_bad from company where company_id !~ '^\d{5}$';
  if n_now <> n_bak then raise exception '会社の件数が控えと違います: 今 % / 控え %', n_now, n_bak; end if;
  if n_leg <> n_bak then raise exception '旧の鍵の無い会社があります: % / %', n_leg, n_bak; end if;
  if n_bad > 0 then raise exception '5 桁でない鍵が % 件', n_bad; end if;
end $$;

commit;

-- ===================== 2 つ目: 外部キーとトリガを戻す・鍵の形の決まり・採番 =====================
begin;

do $$
declare r record; t text;
begin
  for r in
    select c.relname as tbl, k.conname
    from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass
  loop
    execute format('alter table public.%I alter constraint %I not deferrable', r.tbl, r.conname);
  end loop;
  for t in
    select distinct c.relname from pg_constraint k join pg_class c on c.oid = k.conrelid
    where k.contype = 'f' and k.confrelid = 'public.company'::regclass
    union select 'company'
  loop
    execute format('alter table public.%I enable trigger user', t);
  end loop;
end $$;

alter table company drop constraint if exists company_id_5digits;
alter table company add constraint company_id_5digits check (company_id ~ '^\d{5}$');

create sequence if not exists parent_code_seq;
select setval('parent_code_seq', (select max(company_id::int) from company where company_id >= '10001'));

create or replace function next_parent_code(p_band text) returns text
language plpgsql security definer set search_path = public as $$
declare n int; mx int;
begin
  if p_band = 'real' then
    n := nextval('parent_code_seq');
    if n > 99999 then raise exception '取引先番号の帯（10001〜99999）を使い切りました'; end if;
    return lpad(n::text, 5, '0');
  elsif p_band = 'test' then
    select coalesce(max(company_id::int), 0) into mx from company where company_id between '00001' and '09999';
    if mx + 1 > 9999 then raise exception '試験の帯（00001〜09999）を使い切りました。試験の会社を消してください（parent_code_03_delete_test.sql）'; end if;
    return lpad((mx + 1)::text, 5, '0');
  else
    raise exception '帯は real か test です: %', p_band;
  end if;
end $$;
revoke all on function next_parent_code(text) from public;
grant execute on function next_parent_code(text) to authenticated, service_role;

commit;
-- ここまで来れば完了。続けて parent_code_02_verify.sql で確かめる。
