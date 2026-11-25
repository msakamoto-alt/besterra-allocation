-- company_old_code.sql（2026-11-25）: 取引先マスタ＝①旧コードの表 ②社名変更の履歴の「記録した人・日時」 ③適格請求書の登録日・失効日
-- なぜ: 経理の依頼 2026-11-24（開発のお願い）。見本＝画面の見本_旧コード・社名の履歴・インボイスの日付_今と案_2026-11-25（坂本さん 11/25「作業は進めましょう」）。
--   ① 旧コード＝寄せる前の取引先コード（tera と勘定奉行オンプレの 4 桁は全社同じ番号）。1 社に何件でも持てる。入れるのはコードとメモだけ。
--      今のコード（tera・勘定奉行オンプレ）や、ほかの会社の旧コードと同じ番号は入らない＝旧コードで引いたとき会社が 1 つに決まる（逆向きも止める）。
--      統合で寄せた会社のコードは画面が自動で出す（この表には入れない）。Salesforce へは送らない。
--   ② 社名変更の履歴＝正式社名を直したとき、窓で「残す」を選ぶと画面が 1 行足す。記録した人は画面が入れ、日時は DB が付ける。
--      前からある行の日時は空のまま（いつ記録したかが分からないので埋めない）。
--   ③ 登録日・失効日＝国税庁の公表データの日付。失効した会社の登録番号は消さずに残す。
-- 使い方: SQL Editor に貼って実行（本番ハブ）。何度流しても同じ。画面（main への push）より先に流す。
-- 結果の 1 行: old_code_table true ／ policies_4 4 ／ triggers_3 3 ／ company_cols_2 2 ／ name_cols_2 2 ／ name_rows_unstamped 前からある行の数（11/25 は 12）
-- 戻し方: ファイルの末尾。

do $do$
begin
  -- ① 旧コードの表
  create table if not exists public.company_old_code (
    old_code_id bigserial primary key,
    company_id  varchar(8) not null references public.company(company_id),
    code        varchar(20) not null,
    memo        varchar(200),
    created_by  varchar(40),                             -- 登録した人（画面が入れる）
    created_at  timestamptz not null default now(),      -- 登録した日時（DB が付ける）
    constraint company_old_code_code_key unique (code),
    constraint company_old_code_code_chk check (code <> '' and code = btrim(code))
  );
  comment on table public.company_old_code is '取引先の旧コード（寄せる前の tera・勘定奉行のコード）。1 社に何件でも・番号は今のコードと合わせて 1 社だけ。Salesforce へは送らない（2026-11-25）';
  create index if not exists ix_company_old_code_company on public.company_old_code (company_id);

  alter table public.company_old_code enable row level security;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'company_old_code' and policyname = 'tm_sel_company_old_code') then
    create policy tm_sel_company_old_code on public.company_old_code for select to authenticated using (app_role() in ('admin', 'accounting'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'company_old_code' and policyname = 'tm_ins_company_old_code') then
    create policy tm_ins_company_old_code on public.company_old_code for insert to authenticated with check (app_role() in ('admin', 'accounting'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'company_old_code' and policyname = 'tm_upd_company_old_code') then
    create policy tm_upd_company_old_code on public.company_old_code for update to authenticated using (app_role() in ('admin', 'accounting')) with check (app_role() in ('admin', 'accounting'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'company_old_code' and policyname = 'tm_del_company_old_code') then
    create policy tm_del_company_old_code on public.company_old_code for delete to authenticated using (app_role() in ('admin', 'accounting'));
  end if;
  revoke all on public.company_old_code from anon;
  grant select, insert, update, delete on public.company_old_code to authenticated;
  grant usage, select on sequence public.company_old_code_old_code_id_seq to authenticated;

  -- 旧コードを入れる・直すとき: 日時と登録者と会社は後から変えられない。今のコードと同じ番号は止める
  create or replace function public.company_old_code_guard() returns trigger language plpgsql set search_path = public as $fn$
  declare
    chk boolean := true;
    hit_id varchar(8);
    hit_name varchar(200);
  begin
    if tg_op = 'UPDATE' then
      new.company_id := old.company_id;
      new.created_by := old.created_by;
      new.created_at := old.created_at;
      chk := new.code is distinct from old.code;
    else
      new.created_at := now();
    end if;
    if chk then
      select s.company_id, c.official_name into hit_id, hit_name
        from system_code s join company c on c.company_id = s.company_id
       where s.system in ('tera', 'obc_onpre') and btrim(s.code) = new.code
       limit 1;
      if hit_id is not null then
        raise exception '% は % % の今のコードです', new.code, hit_id, hit_name;
      end if;
    end if;
    return new;
  end $fn$;
  create or replace trigger trg_company_old_code_guard before insert or update on public.company_old_code
    for each row execute function public.company_old_code_guard();

  -- 逆向き: 今のコード（tera・勘定奉行オンプレ）に、どこかの会社の旧コードと同じ番号は入らない
  create or replace function public.system_code_old_guard() returns trigger language plpgsql set search_path = public as $fn$
  declare
    chk boolean := true;
    hit_id varchar(8);
    hit_name varchar(200);
  begin
    if new.system in ('tera', 'obc_onpre') then
      if tg_op = 'UPDATE' then
        chk := new.code is distinct from old.code or new.system is distinct from old.system;
      end if;
      if chk then
        select o.company_id, c.official_name into hit_id, hit_name
          from company_old_code o join company c on c.company_id = o.company_id
         where o.code = btrim(new.code)
         limit 1;
        if hit_id is not null then
          raise exception '% は % % の旧コードです', new.code, hit_id, hit_name;
        end if;
      end if;
    end if;
    return new;
  end $fn$;
  create or replace trigger trg_system_code_old_guard before insert or update on public.system_code
    for each row execute function public.system_code_old_guard();

  -- ② 社名変更の履歴: 記録した人・日時（前からある行は空のまま）
  alter table public.company_name_history add column if not exists recorded_by varchar(40);
  alter table public.company_name_history add column if not exists recorded_at timestamptz;
  comment on column public.company_name_history.recorded_by is '記録した人（画面が入れる）。空＝8 月の移行で入った行';
  comment on column public.company_name_history.recorded_at is '記録した日時（DB が付ける＝入れたとき・直したとき）。空＝8 月の移行で入った行';
  create or replace function public.company_name_history_stamp() returns trigger language plpgsql as $fn$
  begin
    new.recorded_at := now();
    return new;
  end $fn$;
  create or replace trigger trg_company_name_history_stamp before insert or update on public.company_name_history
    for each row execute function public.company_name_history_stamp();

  -- ③ 適格請求書の登録日・失効日
  alter table public.company add column if not exists invoice_registered_on date;
  alter table public.company add column if not exists invoice_expired_on date;
  comment on column public.company.invoice_registered_on is '適格請求書発行事業者の登録日（国税庁の公表データ）。登録番号が失効しても残す';
  comment on column public.company.invoice_expired_on is '適格請求書発行事業者の失効日または取消日（国税庁の公表データ）。この日から登録なし。先の日付＝失効予定';

  perform pg_notify('pgrst', 'reload schema');
end $do$;

select to_regclass('public.company_old_code') is not null as old_code_table,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'company_old_code') as policies_4,
  (select count(*) from pg_trigger where not tgisinternal and tgname in ('trg_company_old_code_guard', 'trg_system_code_old_guard', 'trg_company_name_history_stamp')) as triggers_3,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'company' and column_name in ('invoice_registered_on', 'invoice_expired_on')) as company_cols_2,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'company_name_history' and column_name in ('recorded_by', 'recorded_at')) as name_cols_2,
  (select count(*) from public.company_name_history where recorded_at is null) as name_rows_unstamped
limit 100;

-- 戻し方（旧コードの中身も消える。画面を先に戻す）:
-- drop trigger if exists trg_system_code_old_guard on public.system_code;
-- drop function if exists public.system_code_old_guard();
-- drop table if exists public.company_old_code;
-- drop function if exists public.company_old_code_guard();
-- drop trigger if exists trg_company_name_history_stamp on public.company_name_history;
-- drop function if exists public.company_name_history_stamp();
-- alter table public.company_name_history drop column if exists recorded_by, drop column if exists recorded_at;
-- alter table public.company drop column if exists invoice_registered_on, drop column if exists invoice_expired_on;
