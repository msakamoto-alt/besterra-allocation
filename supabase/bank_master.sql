-- bank_master.sql（2026-11-26）: 取引先マスタ＝銀行マスタ（銀行・店）と、口座の入力の点検
-- なぜ: 経理の依頼 2026-11-24（銀行マスタを大マスターで持ち、口座の入力で点検し、tera の形式で書き出す）。
--       見本＝画面の見本_銀行マスタと口座の入力_今と案_2026-11-26。設計＝取引先マスタ_設計書（銀行マスタの章）。
--   ① 銀行（bank）と店（bank_branch）。行は消さない。無くなった店は「廃止」の日付を付けて残す
--      （tera は取込ファイルに無い店を廃止にするので、tera への書き出しはいつも全件が要る）。項目の長さは tera の桁と同じ。
--   ② 取込（bank_master_run・bank_master_stage）＝一覧を置いてから、今の銀行マスタとの違いだけを 1 回でまとめて反映する。
--      mode 'upsert' ＝ tera の形式の CSV。CSV にある行を入れる・直す。CSV に無い店はそのまま（廃止にしない・廃止も解かない）。
--      mode 'latest' ＝ 取得元の最新の一覧。一覧に無い店は廃止にし、廃止の店が一覧に戻れば解く。
--                      今の基準日（最後に反映した一覧の日付）より古い一覧は反映しない（古い状態に戻さない）。
--                      今ある店の 5% を超えて廃止になる一覧は、欠けた一覧とみて反映しない（確かめた上で通すときだけ p_allow_big_drop）。
--   ③ 変更の記録（bank_master_log）＝新設・改称・変更・廃止・復活を 1 行ずつ。銀行マスタが空のところへ入れる最初の 1 回は、数だけを取込の行に残す。
--   ④ 口座（bank_account）の点検＝口座を新しく入れるとき・銀行コードか支店コードを変えるときに、銀行マスタにある店か・廃止でないかを見る。
--      合っていれば銀行名を銀行マスタの名前で入れる。銀行マスタが空のあいだは今までどおり（何も見ない）。
--      コードを変えない直し（承認・名義の直しなど）は見ない＝前から入っている口座は止めない。前からの口座は v_bank_account_check に並ぶ。
--   ⑤ 画面が呼ぶ口（管理者と経理だけ）。画面は表を直接は触らず、この口だけを呼ぶ。
--      読む＝今の状態 bank_master_state ／コードから名前を引く bank_branch_lookup ／名前から探す bank_branch_search ／
--            変更の記録 bank_master_log_view ／tera への書き出しの中身 bank_master_export ／口座の点検の一覧 bank_account_check
--      CSV の取込＝始める bank_master_begin → 行を置く bank_master_stage_rows → 下見 bank_master_preview → 反映 bank_master_apply（やめる bank_master_cancel）
--   日付（基準日の既定・廃止の日付）は日本の日付で付ける（朝 9 時より前に動いても前の日にならない）。
-- 使い方: SQL Editor に貼って実行（本番ハブ）。何度流しても同じ。画面（main への push）より先に流す。
-- 結果の 1 行: prod_form true（本番）／ tables_5 5 ／ views_2 2 ／ policies_14 14 ／ triggers_2 2 ／ functions_15 15 ／ banks・branches は今の行の数（最初は 0）
-- 戻し方: ファイルの末尾。

do $do$
begin
  -- ① 銀行・店
  create table if not exists public.bank (
    bank_code    varchar(4) primary key,
    name         varchar(46) not null,                   -- 金融機関名称（tera の形。例: みずほ銀行）
    kana         varchar(30) not null,                   -- 金融機関名称（カナ）＝半角カナ
    abolished_on date,                                   -- 廃止の印を付けた日（DB が付ける）。空＝今ある銀行
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    constraint bank_code_chk check (bank_code ~ '^[0-9]{4}$'),
    constraint bank_name_chk check (name <> '' and kana <> '')
  );
  comment on table public.bank is '銀行マスタ：銀行。行は消さない（無くなった銀行は abolished_on）。Salesforce へは送らない（2026-11-26）';

  create table if not exists public.bank_branch (
    bank_code    varchar(4) not null references public.bank(bank_code),
    branch_code  varchar(3) not null,
    name         varchar(30) not null,                   -- 店舗名称（「支店」は付けない。例: 神田）
    kana         varchar(20) not null,                   -- 店舗名称（カナ）＝半角カナ。振込データに載る
    postal_code  varchar(10),
    address      varchar(110),
    phone        varchar(17),
    clearing_no  varchar(4),                             -- 手形交換所番号
    abolished_on date,                                   -- 廃止の印を付けた日（DB が付ける）。空＝今ある店
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    primary key (bank_code, branch_code),
    constraint bank_branch_code_chk check (branch_code ~ '^[0-9]{3}$'),
    constraint bank_branch_name_chk check (name <> '' and kana <> ''),
    constraint bank_branch_empty_chk check (postal_code <> '' and address <> '' and phone <> '' and clearing_no <> '')   -- 空は NULL で持つ
  );
  comment on table public.bank_branch is '銀行マスタ：店。行は消さない（無くなった店は abolished_on）。tera への書き出しは廃止の店も含めて全件（2026-11-26）';

  -- ② 取込
  create table if not exists public.bank_master_run (
    run_id      bigserial primary key,
    started_at  timestamptz not null default now(),      -- 始めた日時（DB が付ける）
    source      varchar(40) not null,                    -- 'csv'＝画面の CSV 取込 ／ 取得元の名前
    file_name   varchar(200),
    as_of       date,                                    -- この一覧の日付（基準日）。upsert で空なら取り込んだ日
    mode        varchar(10) not null,                    -- 'upsert' ／ 'latest'
    actor       varchar(40),                             -- 取り込んだ人（画面が入れる）
    applied_at  timestamptz,                             -- 反映した日時（DB が付ける）。空＝まだ反映していない
    counts      jsonb,                                   -- 反映した数
    constraint bank_master_run_mode_chk check (mode in ('upsert', 'latest'))
  );
  comment on table public.bank_master_run is '銀行マスタの取込 1 回ぶん。基準日＝反映済みの行の as_of のいちばん新しい日付（2026-11-26）';

  create table if not exists public.bank_master_stage (
    run_id      bigint not null references public.bank_master_run(run_id) on delete cascade,
    bank_code   varchar(4) not null,
    branch_code varchar(3) not null,
    bank_name   varchar(46),
    bank_kana   varchar(30),
    branch_name varchar(30),
    branch_kana varchar(20),
    postal_code varchar(10),
    address     varchar(110),
    phone       varchar(17),
    clearing_no varchar(4),
    primary key (run_id, bank_code, branch_code),
    constraint bank_master_stage_code_chk check (bank_code ~ '^[0-9]{4}$' and branch_code ~ '^[0-9]{3}$'),
    constraint bank_master_stage_empty_chk check (bank_name <> '' and bank_kana <> '' and branch_name <> '' and branch_kana <> ''
      and postal_code <> '' and address <> '' and phone <> '' and clearing_no <> '')                                      -- 空は NULL で置く
  );
  comment on table public.bank_master_stage is '銀行マスタの取込の置き場（反映したら消える）';

  -- ③ 変更の記録
  create table if not exists public.bank_master_log (
    log_id      bigserial primary key,
    run_id      bigint not null references public.bank_master_run(run_id),
    at          timestamptz not null default now(),      -- 記録した日時（DB が付ける）
    kind        varchar(4) not null,                     -- 新設・改称・変更・廃止・復活
    target      varchar(2) not null,                     -- 銀行・店
    bank_code   varchar(4) not null,
    branch_code varchar(3),
    before      jsonb,
    after       jsonb
  );
  create index if not exists ix_bank_master_log_run on public.bank_master_log (run_id);
  comment on table public.bank_master_log is '銀行マスタの変更の記録（新設・改称・変更・廃止・復活）。消さない（2026-11-26）';

  -- 見られる・書けるのは管理者と経理だけ。銀行・店・変更の記録は消す口を作らない
  --   役割は (select app_role()) で引く＝ 1 つの文につき 1 回だけ（行ごとに引くと、3 万行の取込で数倍の時間がかかる）
  alter table public.bank enable row level security;
  alter table public.bank_branch enable row level security;
  alter table public.bank_master_run enable row level security;
  alter table public.bank_master_stage enable row level security;
  alter table public.bank_master_log enable row level security;
  drop policy if exists bm_sel_bank on public.bank;
  drop policy if exists bm_ins_bank on public.bank;
  drop policy if exists bm_upd_bank on public.bank;
  drop policy if exists bm_sel_bank_branch on public.bank_branch;
  drop policy if exists bm_ins_bank_branch on public.bank_branch;
  drop policy if exists bm_upd_bank_branch on public.bank_branch;
  drop policy if exists bm_sel_run on public.bank_master_run;
  drop policy if exists bm_ins_run on public.bank_master_run;
  drop policy if exists bm_upd_run on public.bank_master_run;
  drop policy if exists bm_sel_stage on public.bank_master_stage;
  drop policy if exists bm_ins_stage on public.bank_master_stage;
  drop policy if exists bm_del_stage on public.bank_master_stage;
  drop policy if exists bm_sel_log on public.bank_master_log;
  drop policy if exists bm_ins_log on public.bank_master_log;
  create policy bm_sel_bank on public.bank for select to authenticated using ((select app_role()) in ('admin', 'accounting'));
  create policy bm_ins_bank on public.bank for insert to authenticated with check ((select app_role()) in ('admin', 'accounting'));
  create policy bm_upd_bank on public.bank for update to authenticated using ((select app_role()) in ('admin', 'accounting')) with check ((select app_role()) in ('admin', 'accounting'));
  create policy bm_sel_bank_branch on public.bank_branch for select to authenticated using ((select app_role()) in ('admin', 'accounting'));
  create policy bm_ins_bank_branch on public.bank_branch for insert to authenticated with check ((select app_role()) in ('admin', 'accounting'));
  create policy bm_upd_bank_branch on public.bank_branch for update to authenticated using ((select app_role()) in ('admin', 'accounting')) with check ((select app_role()) in ('admin', 'accounting'));
  create policy bm_sel_run on public.bank_master_run for select to authenticated using ((select app_role()) in ('admin', 'accounting'));
  create policy bm_ins_run on public.bank_master_run for insert to authenticated with check ((select app_role()) in ('admin', 'accounting'));
  create policy bm_upd_run on public.bank_master_run for update to authenticated using ((select app_role()) in ('admin', 'accounting')) with check ((select app_role()) in ('admin', 'accounting'));
  create policy bm_sel_stage on public.bank_master_stage for select to authenticated using ((select app_role()) in ('admin', 'accounting'));
  create policy bm_ins_stage on public.bank_master_stage for insert to authenticated with check ((select app_role()) in ('admin', 'accounting'));
  create policy bm_del_stage on public.bank_master_stage for delete to authenticated using ((select app_role()) in ('admin', 'accounting'));
  create policy bm_sel_log on public.bank_master_log for select to authenticated using ((select app_role()) in ('admin', 'accounting'));
  create policy bm_ins_log on public.bank_master_log for insert to authenticated with check ((select app_role()) in ('admin', 'accounting'));
  revoke all on public.bank, public.bank_branch, public.bank_master_run, public.bank_master_stage, public.bank_master_log from anon;
  revoke all on public.bank, public.bank_branch, public.bank_master_run, public.bank_master_stage, public.bank_master_log from authenticated;
  grant select, insert, update on public.bank, public.bank_branch, public.bank_master_run to authenticated;
  grant select, insert, delete on public.bank_master_stage to authenticated;
  grant select, insert on public.bank_master_log to authenticated;
  grant usage, select on sequence public.bank_master_run_run_id_seq, public.bank_master_log_log_id_seq to authenticated;

  -- 取込の行: 日時は DB が付ける。反映の印（applied_at・counts）は反映の関数だけが付ける
  create or replace function public.bank_master_run_guard() returns trigger language plpgsql set search_path = public as $fn$
  begin
    if tg_op = 'INSERT' then
      new.started_at := now();
      new.applied_at := null;
      new.counts := null;
      if new.mode = 'upsert' and new.as_of is null then
        new.as_of := (now() at time zone 'Asia/Tokyo')::date;   -- CSV の取込で日付が無ければ、取り込んだ日（日本の日付）を基準日にする
      end if;
    else
      new.run_id := old.run_id;
      new.started_at := old.started_at;
      if current_setting('bank_master.applying', true) is distinct from 'on' then
        if old.applied_at is not null then
          raise exception '反映済みの取込は直せません';
        end if;
        new.applied_at := null;
        new.counts := null;
      end if;
    end if;
    if new.as_of is not null and new.as_of > (now() at time zone 'Asia/Tokyo')::date then
      raise exception '基準日に未来の日付は入れられません';   -- 未来の基準日が入ると、そのあとの一覧が「古い」と判定されて反映できなくなる
    end if;
    return new;
  end $fn$;
  create or replace trigger trg_bank_master_run_guard before insert or update on public.bank_master_run
    for each row execute function public.bank_master_run_guard();

  -- 今の銀行マスタと、置いた一覧との違い（1 行＝1 つの違い）。読むだけ
  create or replace function public.bank_master_diff(p_run bigint)
  returns table (d_kind text, d_target text, d_bank varchar, d_branch varchar, d_before jsonb, d_after jsonb)
  language plpgsql stable set search_path = public as $fn$
  declare
    v_mode text;
  begin
    select r.mode into v_mode from bank_master_run r where r.run_id = p_run;
    if v_mode is null then
      raise exception '取込の番号 % がありません', p_run;
    end if;

    -- 銀行: 新設・改称・（latest だけ）復活
    return query
    with sb as (
      select s.bank_code as bc, max(s.bank_name) as nm, max(s.bank_kana) as kn
        from bank_master_stage s where s.run_id = p_run group by s.bank_code
    )
    select (case when b.bank_code is null then '新設'
                 when v_mode = 'latest' and b.abolished_on is not null then '復活'
                 else '改称' end)::text,
           '銀行'::text, sb.bc, null::varchar,
           case when b.bank_code is null then null else jsonb_build_object('name', b.name, 'kana', b.kana) end,
           jsonb_build_object('name', coalesce(sb.nm, b.name), 'kana', coalesce(sb.kn, b.kana))
      from sb left join bank b on b.bank_code = sb.bc
     where b.bank_code is null
        or (sb.nm is not null and sb.nm is distinct from b.name)
        or (sb.kn is not null and sb.kn is distinct from b.kana)
        or (v_mode = 'latest' and b.abolished_on is not null);

    -- 店: 新設・改称（名前かカナ）・変更（所在地など＝upsert だけ）・（latest だけ）復活
    return query
    select (case when t.bank_code is null then '新設'
                 when v_mode = 'latest' and t.abolished_on is not null then '復活'
                 when (s.branch_name is not null and s.branch_name is distinct from t.name)
                   or (s.branch_kana is not null and s.branch_kana is distinct from t.kana) then '改称'
                 else '変更' end)::text,
           '店'::text, s.bank_code, s.branch_code,
           case when t.bank_code is null then null
                else jsonb_build_object('name', t.name, 'kana', t.kana, 'postal_code', t.postal_code, 'address', t.address, 'phone', t.phone, 'clearing_no', t.clearing_no) end,
           case when v_mode = 'upsert'
                then jsonb_build_object('name', coalesce(s.branch_name, t.name), 'kana', coalesce(s.branch_kana, t.kana), 'postal_code', s.postal_code, 'address', s.address, 'phone', s.phone, 'clearing_no', s.clearing_no)
                else jsonb_build_object('name', coalesce(s.branch_name, t.name), 'kana', coalesce(s.branch_kana, t.kana), 'postal_code', coalesce(t.postal_code, s.postal_code), 'address', coalesce(t.address, s.address), 'phone', coalesce(t.phone, s.phone), 'clearing_no', coalesce(t.clearing_no, s.clearing_no)) end
      from bank_master_stage s
      left join bank_branch t on t.bank_code = s.bank_code and t.branch_code = s.branch_code
     where s.run_id = p_run
       and (t.bank_code is null
         or (s.branch_name is not null and s.branch_name is distinct from t.name)
         or (s.branch_kana is not null and s.branch_kana is distinct from t.kana)
         or (v_mode = 'upsert' and (s.postal_code is distinct from t.postal_code or s.address is distinct from t.address
                                 or s.phone is distinct from t.phone or s.clearing_no is distinct from t.clearing_no))
         or (v_mode = 'latest' and t.abolished_on is not null));

    -- 廃止（latest だけ）: 今ある店・銀行で、一覧に無いもの
    if v_mode = 'latest' then
      return query
      select '廃止'::text, '店'::text, t.bank_code, t.branch_code, jsonb_build_object('name', t.name, 'kana', t.kana), null::jsonb
        from bank_branch t
       where t.abolished_on is null
         and not exists (select 1 from bank_master_stage s where s.run_id = p_run and s.bank_code = t.bank_code and s.branch_code = t.branch_code);
      return query
      select '廃止'::text, '銀行'::text, b.bank_code, null::varchar, jsonb_build_object('name', b.name, 'kana', b.kana), null::jsonb
        from bank b
       where b.abolished_on is null
         and not exists (select 1 from bank_master_stage s where s.run_id = p_run and s.bank_code = b.bank_code);
    end if;
  end $fn$;

  -- 反映できない理由（無ければ空）。下見と反映の両方が使う
  create or replace function public.bank_master_problem(p_run bigint, p_allow_big_drop boolean default false) returns text
  language plpgsql stable set search_path = public as $fn$
  declare
    v_run bank_master_run;
    v_bad text;
    v_as_of date;
    v_now bigint;
    v_drop bigint;
  begin
    select * into v_run from bank_master_run where run_id = p_run;
    if not found then
      return format('取込の番号 %s がありません', p_run);
    end if;
    if v_run.applied_at is not null then
      return 'この取込はもう反映済みです';
    end if;
    if not exists (select 1 from bank_master_stage where run_id = p_run) then
      return '取り込む行がありません';
    end if;
    select string_agg(x.bank_code, '・' order by x.bank_code) into v_bad
      from (select s.bank_code from bank_master_stage s where s.run_id = p_run
             group by s.bank_code having count(distinct s.bank_name) > 1 or count(distinct s.bank_kana) > 1
             order by s.bank_code limit 5) x;
    if v_bad is not null then
      return format('同じ銀行コードに、銀行名かカナが 2 通りあります（%s）', v_bad);
    end if;
    select string_agg(x.code, '・' order by x.code) into v_bad
      from (select s.bank_code || '-' || s.branch_code as code
              from bank_master_stage s
              left join bank_branch t on t.bank_code = s.bank_code and t.branch_code = s.branch_code
              left join bank b on b.bank_code = s.bank_code
             where s.run_id = p_run
               and ((t.bank_code is null and (s.branch_name is null or s.branch_kana is null))
                 or (b.bank_code is null and (s.bank_name is null or s.bank_kana is null)))
             order by 1 limit 5) x;
    if v_bad is not null then
      return format('新しい銀行・店に、名前かカナがありません（%s）', v_bad);
    end if;
    if v_run.mode = 'latest' then
      if v_run.as_of is null then
        return '一覧の日付（基準日）がありません';
      end if;
      select max(r.as_of) into v_as_of from bank_master_run r where r.applied_at is not null;
      if v_as_of is not null and v_run.as_of < v_as_of then
        return format('基準日 %s の一覧は、今の銀行マスタ（基準日 %s）より古いので反映しません', v_run.as_of, v_as_of);
      end if;
      if not p_allow_big_drop then
        select count(*) into v_now from bank_branch t where t.abolished_on is null;
        select count(*) into v_drop from bank_branch t
         where t.abolished_on is null
           and not exists (select 1 from bank_master_stage s where s.run_id = p_run and s.bank_code = t.bank_code and s.branch_code = t.branch_code);
        if v_now > 0 and v_drop * 20 > v_now then
          return format('この一覧を反映すると、今ある %s 店のうち %s 店が廃止になります（5%% を超える）。一覧が欠けていないか確かめてください', v_now, v_drop);
        end if;
      end if;
    end if;
    return null;
  end $fn$;

  -- 下見: 置いた一覧を反映すると何がいくつ変わるか（読むだけ）
  create or replace function public.bank_master_preview(p_run bigint) returns jsonb language plpgsql stable set search_path = public as $fn$
  declare
    v_problem text := bank_master_problem(p_run);
    v_staged bigint;
    v_counts jsonb := '{}'::jsonb;
    v_samples jsonb := '[]'::jsonb;
    v_touched bigint := 0;
  begin
    select count(*) into v_staged from bank_master_stage where run_id = p_run;
    if exists (select 1 from bank_master_run where run_id = p_run) and v_staged > 0 then
      select coalesce(jsonb_object_agg(x.k, x.n), '{}'::jsonb), coalesce(sum(x.n) filter (where x.k like '店:%' and x.k <> '店:廃止'), 0)
        into v_counts, v_touched
        from (select d.d_target || ':' || d.d_kind as k, count(*) as n from bank_master_diff(p_run) d group by 1) x;
      select coalesce(jsonb_agg(to_jsonb(y)), '[]'::jsonb) into v_samples
        from (select d.d_kind as kind, d.d_target as target, d.d_bank as bank_code, d.d_branch as branch_code, d.d_before as before, d.d_after as after
                from bank_master_diff(p_run) d
               order by d.d_target desc, d.d_kind, d.d_bank, d.d_branch limit 60) y;
    end if;
    return jsonb_build_object('problem', v_problem, 'staged', v_staged, 'same', v_staged - v_touched, 'counts', v_counts, 'samples', v_samples,
      'master_branches', (select count(*) from bank_branch),
      'master_as_of', (select max(r.as_of) from bank_master_run r where r.applied_at is not null));
  end $fn$;

  -- 反映: 置いた一覧との違いを銀行マスタに入れる（1 回の呼び出し＝全部入るか、何も入らないか）。変更の記録を残し、置き場を空にする
  --   p_as_of を渡すと、その日付を基準日にしてから反映する（画面の下見の窓で基準日を直したとき。反映が止まれば基準日も元のまま）
  create or replace function public.bank_master_apply(p_run bigint, p_allow_big_drop boolean default false, p_as_of date default null) returns jsonb
  language plpgsql set search_path = public as $fn$
  declare
    v_run bank_master_run;
    v_problem text;
    v_empty boolean;
    v_staged bigint;
    v_touched bigint := 0;
    v_counts jsonb;
  begin
    select * into v_run from bank_master_run where run_id = p_run for update;
    if p_as_of is not null and v_run.run_id is not null and v_run.applied_at is null then
      update bank_master_run set as_of = p_as_of where run_id = p_run;
    end if;
    v_problem := bank_master_problem(p_run, p_allow_big_drop);
    if v_problem is not null then
      raise exception '%', v_problem;
    end if;
    select count(*) into v_staged from bank_master_stage where run_id = p_run;
    v_empty := not exists (select 1 from bank);

    if v_empty then
      -- 最初の 1 回（銀行マスタが空）: 全部が新設。1 行ずつの記録は残さず、数だけを取込の行に残す
      insert into bank (bank_code, name, kana)
        select s.bank_code, max(s.bank_name), max(s.bank_kana) from bank_master_stage s where s.run_id = p_run group by s.bank_code;
      insert into bank_branch (bank_code, branch_code, name, kana, postal_code, address, phone, clearing_no)
        select s.bank_code, s.branch_code, s.branch_name, s.branch_kana, s.postal_code, s.address, s.phone, s.clearing_no
          from bank_master_stage s where s.run_id = p_run;
      v_counts := jsonb_build_object('銀行:新設', (select count(*) from bank), '店:新設', v_staged);
      v_touched := v_staged;
    else
      insert into bank_master_log (run_id, kind, target, bank_code, branch_code, before, after)
        select p_run, d.d_kind, d.d_target, d.d_bank, d.d_branch, d.d_before, d.d_after from bank_master_diff(p_run) d;

      insert into bank (bank_code, name, kana)
        select l.bank_code, l.after->>'name', l.after->>'kana' from bank_master_log l
         where l.run_id = p_run and l.target = '銀行' and l.kind = '新設';
      update bank b
         set name = l.after->>'name', kana = l.after->>'kana',
             abolished_on = case when l.kind = '復活' then null else b.abolished_on end, updated_at = now()
        from bank_master_log l
       where l.run_id = p_run and l.target = '銀行' and l.kind in ('改称', '復活') and l.bank_code = b.bank_code;
      update bank b set abolished_on = (now() at time zone 'Asia/Tokyo')::date, updated_at = now()
        from bank_master_log l
       where l.run_id = p_run and l.target = '銀行' and l.kind = '廃止' and l.bank_code = b.bank_code;

      insert into bank_branch (bank_code, branch_code, name, kana, postal_code, address, phone, clearing_no)
        select l.bank_code, l.branch_code, l.after->>'name', l.after->>'kana', l.after->>'postal_code', l.after->>'address', l.after->>'phone', l.after->>'clearing_no'
          from bank_master_log l
         where l.run_id = p_run and l.target = '店' and l.kind = '新設';
      update bank_branch t
         set name = l.after->>'name', kana = l.after->>'kana', postal_code = l.after->>'postal_code', address = l.after->>'address',
             phone = l.after->>'phone', clearing_no = l.after->>'clearing_no',
             abolished_on = case when l.kind = '復活' then null else t.abolished_on end, updated_at = now()
        from bank_master_log l
       where l.run_id = p_run and l.target = '店' and l.kind in ('改称', '変更', '復活')
         and l.bank_code = t.bank_code and l.branch_code = t.branch_code;
      update bank_branch t set abolished_on = (now() at time zone 'Asia/Tokyo')::date, updated_at = now()
        from bank_master_log l
       where l.run_id = p_run and l.target = '店' and l.kind = '廃止'
         and l.bank_code = t.bank_code and l.branch_code = t.branch_code;

      select coalesce(jsonb_object_agg(x.k, x.n), '{}'::jsonb), coalesce(sum(x.n) filter (where x.k like '店:%' and x.k <> '店:廃止'), 0)
        into v_counts, v_touched
        from (select l.target || ':' || l.kind as k, count(*) as n from bank_master_log l where l.run_id = p_run group by 1) x;
    end if;

    v_counts := v_counts || jsonb_build_object('置いた行', v_staged, '変更なし', v_staged - v_touched);
    perform set_config('bank_master.applying', 'on', true);
    update bank_master_run set applied_at = now(), counts = v_counts where run_id = p_run;
    perform set_config('bank_master.applying', 'off', true);
    delete from bank_master_stage where run_id = p_run;
    -- 途中でやめた取込の置き場（1 日より前のもの）を片付ける
    delete from bank_master_stage s using bank_master_run r
     where r.run_id = s.run_id and r.applied_at is null and r.started_at < now() - interval '1 day';
    return v_counts;
  end $fn$;

  -- 画面の上に出す今の状態（数・基準日・最後に反映した日時）。p_since（前に tera へ書き出した日時）を渡すと、そのあとに変わった数も返す
  --   変わった数＝変更の記録の行の数。1 行ずつの記録を残さない最初の取込は、入れた店の数で数える
  create or replace function public.bank_master_state(p_since timestamptz default null) returns jsonb language sql stable set search_path = public as $fn$
    select jsonb_build_object(
      'banks', (select count(*) from bank),
      'branches', (select count(*) from bank_branch),
      'abolished_branches', (select count(*) from bank_branch t join bank b on b.bank_code = t.bank_code where t.abolished_on is not null or b.abolished_on is not null),
      'as_of', (select max(r.as_of) from bank_master_run r where r.applied_at is not null),
      'last_applied_at', (select max(r.applied_at) from bank_master_run r),
      'last_change_at', (select max(l.at) from bank_master_log l),
      'changes_since', case when p_since is null then null else
          (select count(*) from bank_master_log l where l.at > p_since)
        + coalesce((select sum(coalesce((r.counts->>'店:新設')::bigint, 0)) from bank_master_run r
                     where r.applied_at > p_since and not exists (select 1 from bank_master_log l where l.run_id = r.run_id)), 0) end)
  $fn$;

  -- 銀行と店を 1 行にした読み口。先頭の 10 列が tera の形式（このあとに全行「1」の 2 列が付く）。廃止の店も入る。並べるのは読む側（銀行コード・店コードの順）
  create or replace view public.v_bank_branch with (security_invoker = true) as
    select t.bank_code, t.branch_code, b.kana as bank_kana, b.name as bank_name, t.kana as branch_kana, t.name as branch_name,
           coalesce(t.postal_code, '') as postal_code, coalesce(t.address, '') as address, coalesce(t.phone, '') as phone,
           coalesce(t.clearing_no, '') as clearing_no,
           (t.abolished_on is not null or b.abolished_on is not null) as abolished
      from public.bank_branch t join public.bank b on b.bank_code = t.bank_code;

  -- コードから名前を引く（口座の入力・口座の表示・口座の CSV 取込）。鍵は「銀行コード-支店コード」。
  --   銀行が無ければ bank_name が空、銀行はあるが店が無ければ branch_name が空で返る（画面が「無い銀行」「無い店」を言い分ける）
  create or replace function public.bank_branch_lookup(p_keys text[])
  returns table (k text, bank_code varchar, branch_code varchar, bank_name varchar, bank_kana varchar, bank_abolished boolean,
                 branch_name varchar, branch_kana varchar, abolished boolean)
  language sql stable set search_path = public as $fn$
    select x.k, b.bank_code, t.branch_code, b.name, b.kana, (b.abolished_on is not null),
           t.name, t.kana, (t.abolished_on is not null or b.abolished_on is not null)
      from (select distinct u.k from unnest(p_keys) as u(k)) x
      left join bank b on b.bank_code = split_part(x.k, '-', 1)
      left join bank_branch t on t.bank_code = split_part(x.k, '-', 1) and t.branch_code = split_part(x.k, '-', 2)
  $fn$;

  -- 名前から探す（口座の入力の「名前から探す」・銀行マスタの画面の検索）。
  --   p_terms＝言葉の配列 [{t: 名前の形, k: カナの形, c: コードの形}]。どの言葉も、銀行か店の 名前・カナ・コード のどれかに当たる店を返す。
  --   名前の英数字は全角・半角・大文字・小文字を区別しない（言葉のほうは画面が半角の大文字にして渡す）。
  --   カナは半角カナで比べる。小さいカナ（ｬｭｮｯ など）は大きく、半角の長音「ｰ」は「-」にそろえてから比べる（言葉のほうも画面が同じ形にして渡す）。
  --   返すもの＝{total: 当たった店の数, rows: 先頭の p_limit 店（銀行コード・店コードの順）}
  create or replace function public.bank_branch_search(p_terms jsonb, p_with_abolished boolean default false, p_limit int default 30)
  returns jsonb language sql stable set search_path = public as $fn$
    with tt as (
      select btrim(coalesce(e->>'t', '')) as t, btrim(coalesce(e->>'k', '')) as k, btrim(coalesce(e->>'c', '')) as c
        from jsonb_array_elements(coalesce(p_terms, '[]'::jsonb)) e
       where btrim(coalesce(e->>'t', '')) <> '' or btrim(coalesce(e->>'k', '')) <> '' or btrim(coalesce(e->>'c', '')) <> ''
    ), src as (
      select v.bank_code, v.branch_code, v.bank_name, v.bank_kana, v.branch_name, v.branch_kana, v.abolished,
             upper(translate(v.bank_name,
               'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９',
               'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')) as n_bank,
             upper(translate(v.branch_name,
               'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９',
               'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')) as n_branch,
             upper(translate(v.bank_kana, 'ｧｨｩｪｫｬｭｮｯｰ', 'ｱｲｳｴｵﾔﾕﾖﾂ-')) as k_bank,
             upper(translate(v.branch_kana, 'ｧｨｩｪｫｬｭｮｯｰ', 'ｱｲｳｴｵﾔﾕﾖﾂ-')) as k_branch
        from v_bank_branch v
       where coalesce(p_with_abolished, false) or not v.abolished
    ), hit as (
      select s.bank_code, s.branch_code, s.bank_name, s.bank_kana, s.branch_name, s.branch_kana, s.abolished
        from src s
       where exists (select 1 from tt)
         and not exists (
           select 1 from tt
            where not (
                 (tt.t <> '' and (position(tt.t in s.n_bank) > 0 or position(tt.t in s.n_branch) > 0))
              or (tt.k <> '' and (position(tt.k in s.k_bank) > 0 or position(tt.k in s.k_branch) > 0))
              or (tt.c ~ '^[0-9]{4}$' and s.bank_code = tt.c)
              or (tt.c ~ '^[0-9]{3}$' and s.branch_code = tt.c)
              or (tt.c ~ '^[0-9]{4}-[0-9]{3}$' and s.bank_code || '-' || s.branch_code = tt.c)))
    )
    select jsonb_build_object(
      'total', (select count(*) from hit),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.bank_code, x.branch_code)
                          from (select h.* from hit h order by h.bank_code, h.branch_code limit greatest(1, least(coalesce(p_limit, 30), 200))) x), '[]'::jsonb))
  $fn$;

  -- 変更の記録を画面に出す形で読む（取込の新しい順。同じ取込の中は、銀行の行・店の行の順で、コードの順）。
  --   銀行ごと新設・廃止・復活したときは、銀行の 1 行にまとめて店の数を付ける（その銀行の店の行は出さない）。
  --   1 行ずつの記録が無い取込（最初の取込・何も変わらなかった取込）は、取込の 1 行（数つき）で出す
  create or replace function public.bank_master_log_view(p_limit int default 50)
  returns table (at timestamptz, run_id bigint, kind text, target text, bank_code varchar, branch_code varchar, bank_name text,
                 before jsonb, after jsonb, stores bigint, counts jsonb)
  language sql stable set search_path = public as $fn$
    with bk as (
      select l.run_id, l.kind, l.bank_code from bank_master_log l where l.target = '銀行' and l.kind in ('新設', '廃止', '復活')
    ), cnt as (
      select l.run_id, l.kind, l.bank_code, count(*) as n from bank_master_log l where l.target = '店' group by l.run_id, l.kind, l.bank_code
    )
    select x.at, x.run_id, x.kind, x.target, x.bank_code, x.branch_code, x.bank_name, x.before, x.after, x.stores, x.counts
      from (
        select l.at, l.run_id, l.kind::text as kind, l.target::text as target, l.bank_code, l.branch_code,
               coalesce(b.name, l.after->>'name', l.before->>'name')::text as bank_name, l.before, l.after,
               case when l.target = '銀行' then coalesce(cnt.n, 0) end as stores,
               null::jsonb as counts, l.log_id as ord
          from bank_master_log l
          left join bank b on b.bank_code = l.bank_code
          left join bk on l.target = '店' and bk.run_id = l.run_id and bk.kind = l.kind and bk.bank_code = l.bank_code
          left join cnt on l.target = '銀行' and cnt.run_id = l.run_id and cnt.kind = l.kind and cnt.bank_code = l.bank_code
         where l.target = '銀行' or bk.run_id is null
        union all
        select r.applied_at, r.run_id, '取込'::text, '一覧'::text, null::varchar, null::varchar, r.file_name::text, null::jsonb, null::jsonb, null::bigint, r.counts, 0::bigint
          from bank_master_run r
         where r.applied_at is not null and not exists (select 1 from bank_master_log l where l.run_id = r.run_id)
      ) x
     order by x.at desc, x.run_id desc, case x.target when '一覧' then 0 when '銀行' then 1 else 2 end, x.bank_code, x.branch_code, x.ord
     limit greatest(1, least(coalesce(p_limit, 50), 500))
  $fn$;

  -- tera への書き出しの中身＝全部の店（廃止の店も）を、銀行コード・店コードの順に 1 回で返す（1 行＝10 項目の配列。tera の形式の先頭 10 列）
  create or replace function public.bank_master_export() returns jsonb language sql stable set search_path = public as $fn$
    select coalesce(jsonb_agg(jsonb_build_array(v.bank_code, v.branch_code, v.bank_kana, v.bank_name, v.branch_kana, v.branch_name,
                                                 v.postal_code, v.address, v.phone, v.clearing_no) order by v.bank_code, v.branch_code), '[]'::jsonb)
      from v_bank_branch v
  $fn$;

  -- 画面の CSV 取込の 3 つの口（始める・行を置く・やめる）。行＝tera の形式の先頭 10 項目の配列（bank_master_export と同じ並び）。
  --   始める＝取込の行を 1 つ作って番号を返す（種類は upsert）。行を置く＝置いた数を返す（反映済みの取込には置けない＝0 が返る）
  create or replace function public.bank_master_begin(p_file_name text, p_as_of date default null, p_actor text default null) returns bigint
  language sql set search_path = public as $fn$
    insert into bank_master_run (source, file_name, as_of, mode, actor)
    values ('csv', left(p_file_name, 200), p_as_of, 'upsert', left(p_actor, 40))
    returning run_id
  $fn$;

  create or replace function public.bank_master_stage_rows(p_run bigint, p_rows jsonb) returns int
  language sql set search_path = public as $fn$
    with ins as (
      insert into bank_master_stage (run_id, bank_code, branch_code, bank_kana, bank_name, branch_kana, branch_name, postal_code, address, phone, clearing_no)
      select p_run, r->>0, r->>1, nullif(r->>2, ''), nullif(r->>3, ''), nullif(r->>4, ''), nullif(r->>5, ''),
             nullif(r->>6, ''), nullif(r->>7, ''), nullif(r->>8, ''), nullif(r->>9, '')
        from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
       where exists (select 1 from bank_master_run x where x.run_id = p_run and x.applied_at is null)
      returning 1)
    select count(*)::int from ins
  $fn$;

  create or replace function public.bank_master_cancel(p_run bigint) returns int language sql set search_path = public as $fn$
    with del as (delete from bank_master_stage where run_id = p_run returning 1)
    select count(*)::int from del
  $fn$;

  revoke all on function public.bank_master_diff(bigint), public.bank_master_problem(bigint, boolean), public.bank_master_preview(bigint),
    public.bank_master_apply(bigint, boolean, date), public.bank_master_state(timestamptz), public.bank_branch_lookup(text[]),
    public.bank_branch_search(jsonb, boolean, int), public.bank_master_log_view(int), public.bank_master_export(),
    public.bank_master_begin(text, date, text), public.bank_master_stage_rows(bigint, jsonb), public.bank_master_cancel(bigint) from public, anon;
  grant execute on function public.bank_master_diff(bigint), public.bank_master_problem(bigint, boolean), public.bank_master_preview(bigint),
    public.bank_master_apply(bigint, boolean, date), public.bank_master_state(timestamptz), public.bank_branch_lookup(text[]),
    public.bank_branch_search(jsonb, boolean, int), public.bank_master_log_view(int), public.bank_master_export(),
    public.bank_master_begin(text, date, text), public.bank_master_stage_rows(bigint, jsonb), public.bank_master_cancel(bigint) to authenticated;

  -- 口座の点検: 銀行マスタと合わない口座（コードが空・形が違う・無い店・廃止の店）。銀行マスタが空のあいだは見ない（全部が並ぶため）
  create or replace view public.v_bank_account_check with (security_invoker = true) as
    select a.account_id, a.company_id, c.official_name, coalesce(c.is_suspended, false) as is_suspended, a.priority, a.bank_name,
           btrim(coalesce(a.bank_code, '')) as bank_code, btrim(coalesce(a.branch_code, '')) as branch_code,
           case when btrim(coalesce(a.bank_code, '')) = '' and btrim(coalesce(a.branch_code, '')) = '' then '銀行コード・支店コードが空'
                when btrim(coalesce(a.bank_code, '')) !~ '^[0-9]{4}$' or btrim(coalesce(a.branch_code, '')) !~ '^[0-9]{3}$' then 'コードの形が違う'
                when t.bank_code is null then '銀行マスタに無い店'
                else '廃止の店' end as reason
      from public.bank_account a
      join public.company c on c.company_id = a.company_id
      left join public.bank b on b.bank_code = btrim(coalesce(a.bank_code, ''))
      left join public.bank_branch t on t.bank_code = btrim(coalesce(a.bank_code, '')) and t.branch_code = btrim(coalesce(a.branch_code, ''))
     where t.bank_code is null or t.abolished_on is not null or b.abolished_on is not null;

  revoke all on public.v_bank_branch, public.v_bank_account_check from anon;
  revoke all on public.v_bank_branch, public.v_bank_account_check from authenticated;
  grant select on public.v_bank_branch, public.v_bank_account_check to authenticated;

  -- 口座の点検の一覧を 1 回で返す（画面の「口座の点検」。有効な会社が先・取引先番号の順）
  create or replace function public.bank_account_check() returns jsonb language sql stable set search_path = public as $fn$
    select coalesce(jsonb_agg(to_jsonb(k) order by k.is_suspended, k.company_id, k.priority), '[]'::jsonb) from v_bank_account_check k
  $fn$;
  revoke all on function public.bank_account_check() from public, anon;
  grant execute on function public.bank_account_check() to authenticated;

  -- ④ 口座の点検（入れるとき・コードを変えるとき）。口座を書く人の権限に関わらず銀行マスタを見られるように、持ち主の権限で動かす
  create or replace function public.bank_account_master_guard() returns trigger language plpgsql security definer set search_path = public as $fn$
  declare
    v_bank text := btrim(coalesce(new.bank_code, ''));
    v_branch text := btrim(coalesce(new.branch_code, ''));
    v_name text;
    v_bank_abolished date;
    v_branch_name text;
    v_branch_abolished date;
  begin
    if not exists (select 1 from bank_branch) then
      return new;                                        -- 銀行マスタが空のあいだは今までどおり
    end if;
    if tg_op = 'UPDATE' and btrim(coalesce(old.bank_code, '')) = v_bank and btrim(coalesce(old.branch_code, '')) = v_branch then
      return new;                                        -- コードを変えない直しは見ない
    end if;
    if v_bank = '' or v_branch = '' then
      raise exception '銀行コードと支店コードは必須です';
    end if;
    select b.name, b.abolished_on into v_name, v_bank_abolished from bank b where b.bank_code = v_bank;
    if v_name is null then
      raise exception '銀行コード % は銀行マスタにありません', v_bank;
    end if;
    select t.name, t.abolished_on into v_branch_name, v_branch_abolished from bank_branch t where t.bank_code = v_bank and t.branch_code = v_branch;
    if v_branch_name is null then
      raise exception '%に支店コード % はありません', v_name, v_branch;
    end if;
    if v_bank_abolished is not null or v_branch_abolished is not null then
      raise exception '% %（%-%）は廃止の印が付いています。今の支店コードを確かめてください', v_name, v_branch_name, v_bank, v_branch;
    end if;
    new.bank_name := v_name;                             -- 銀行名は銀行マスタの名前で入る
    return new;
  end $fn$;
  create or replace trigger trg_bank_account_master_guard before insert or update on public.bank_account
    for each row execute function public.bank_account_master_guard();

  perform pg_notify('pgrst', 'reload schema');
end $do$;

select to_regproc('public.app_role') is not null as prod_form,
  (select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name in ('bank', 'bank_branch', 'bank_master_run', 'bank_master_stage', 'bank_master_log')) as tables_5,
  (select count(*) from information_schema.views where table_schema = 'public' and table_name in ('v_bank_branch', 'v_bank_account_check')) as views_2,
  (select count(*) from pg_policies where schemaname = 'public' and tablename in ('bank', 'bank_branch', 'bank_master_run', 'bank_master_stage', 'bank_master_log')) as policies_14,
  (select count(*) from pg_trigger where not tgisinternal and tgname in ('trg_bank_account_master_guard', 'trg_bank_master_run_guard')) as triggers_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    and p.proname in ('bank_master_run_guard', 'bank_master_diff', 'bank_master_problem', 'bank_master_preview', 'bank_master_apply', 'bank_master_state', 'bank_account_master_guard',
      'bank_branch_lookup', 'bank_branch_search', 'bank_master_log_view', 'bank_master_export',
      'bank_master_begin', 'bank_master_stage_rows', 'bank_master_cancel', 'bank_account_check')) as functions_15,
  (select count(*) from public.bank) as banks,
  (select count(*) from public.bank_branch) as branches
limit 100;

-- 戻し方（銀行マスタの中身も消える。画面を先に戻す）:
-- drop trigger if exists trg_bank_account_master_guard on public.bank_account;
-- drop function if exists public.bank_account_master_guard();
-- drop function if exists public.bank_account_check(), public.bank_master_cancel(bigint), public.bank_master_stage_rows(bigint, jsonb), public.bank_master_begin(text, date, text);
-- drop function if exists public.bank_master_export(), public.bank_master_log_view(int), public.bank_branch_search(jsonb, boolean, int), public.bank_branch_lookup(text[]);
-- drop view if exists public.v_bank_account_check, public.v_bank_branch;
-- drop function if exists public.bank_master_state(timestamptz), public.bank_master_apply(bigint, boolean, date), public.bank_master_preview(bigint), public.bank_master_problem(bigint, boolean), public.bank_master_diff(bigint);
-- drop table if exists public.bank_master_log, public.bank_master_stage, public.bank_master_run, public.bank_branch, public.bank;
-- drop function if exists public.bank_master_run_guard();
