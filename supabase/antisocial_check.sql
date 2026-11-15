-- 反社チェックの API 連携（RoboRobo コンプライアンスチェック）— 2026-11-15
-- 何度流しても同じ結果になる（if not exists／create or replace）。Supabase の SQL Editor で本番に流す。
-- 渡す前に手元で通す: supabase/tests/antisocial_check.test.mjs（PGlite）
--
-- 考え方（検討書 自動化\API連携\反社チェック_RoboRobo連携_検討_2026-11-15.html）
--   調べるのは RoboRobo、決めるのは経理、残すのはツール。新しい相手は申請で、今の相手は 1 年ごとに。
--   ・compliance_check を「1 回のチェック＝1 行」の履歴にする（RoboRobo の回は source='roborobo'）
--   ・compliance_check_item＝RoboRobo に頼んだ 1 件（会社／代表者）。RoboRobo の取引先 ID・実行 ID・結果・取引判断を持つ
--   ・回の結果（result）は項目から DB が決める（compliance_round_refresh）。人は直さない（判断は RoboRobo の画面で打つ）
--   ・今の状態は持たずに計算する（v_compliance_status）＝期限切れが日付だけで出る
--   ・依頼の決まり（いつ・誰を）は antisocial_enqueue／antisocial_enqueue_due。RoboRobo との通信は関数 antisocial-check
--   ・テスト環境のトークンで流した回は is_test＝本物の状態に数えない

-- ===== 1. 記録の表（今の compliance_check）に列を足す =====
alter table public.compliance_check add column if not exists source varchar(20);         -- roborobo／空＝移行・手入力
alter table public.compliance_check add column if not exists trigger_kind varchar(20);   -- 与信の稟議／取引開始申請／登録／定期／手動
alter table public.compliance_check add column if not exists trigger_ref varchar(80);    -- 稟議番号など
alter table public.compliance_check add column if not exists is_test boolean not null default false;
alter table public.compliance_check add column if not exists requested_at timestamptz;   -- 依頼した時刻（新しい回は DB が付ける）
alter table public.compliance_check add column if not exists requested_by varchar(80);
alter table public.compliance_check add column if not exists completed_at timestamptz;   -- 結果が決まった時刻（該当なし・問題なし・取引不可）
alter table public.compliance_check add column if not exists note text;
alter table public.compliance_check alter column requested_at set default now();        -- 既にある行は空のまま（移行の記録に今日の日付を付けない）
comment on column public.compliance_check.result is '反社チェックの結果。RoboRobo の回＝調査中／要確認／該当なし／問題なし／取引不可／エラー（DB が項目から決める）。手入力＝該当なし／問題なし／取引不可。移行の行は空';
comment on column public.compliance_check.source is 'roborobo＝RoboRobo の API で調べた回（直せない・消せない）。空＝移行・手入力';
comment on column public.compliance_check.is_test is 'テスト環境のトークン・試験の org から流した回。本物の状態（v_compliance_status）に数えない';

do $$ begin
  alter table public.compliance_check add constraint compliance_check_result_chk
    check (result is null or result in ('調査中','要確認','該当なし','問題なし','取引不可','エラー'));
exception when duplicate_object then null; end $$;

-- ===== 2. RoboRobo に頼んだ 1 件（会社／代表者） =====
create table if not exists public.compliance_check_item (
  item_id           bigserial primary key,
  check_id          bigint not null references public.compliance_check(check_id) on delete cascade,
  company_id        varchar(8) not null references public.company(company_id),
  subject           varchar(6) not null check (subject in ('会社','代表者')),
  name_sent         varchar(200) not null,   -- RoboRobo の取引先名（検索の言葉）
  relative_word     varchar(200),            -- 関連ワード（代表者のときは社名）
  management_number varchar(40),             -- 取引先番号（代表者は 取引先番号-R）
  entity_type       varchar(4),              -- 組織／個人
  folder_name       varchar(80),
  state             varchar(10) not null default '依頼待ち'
                    check (state in ('依頼待ち','調査中','要確認','該当なし','問題なし','取引不可','エラー')),
  rr_customer_id    bigint,                  -- RoboRobo の取引先 ID
  rr_execution_id   bigint,                  -- RoboRobo のチェック実行 ID
  sent_at           timestamptz,
  received_at       timestamptz,
  checked_at        timestamptz,             -- RoboRobo のチェック日
  hit_total         int, hit_high int, hit_middle int, hit_low int, hit_none int, hit_exclude int,
  newspaper_count   int,
  blacklist_hit     boolean,
  other_hits        jsonb,                   -- SPN・官報・World-Check・LLM の結果（契約していれば）
  compliance_url    text,                    -- RoboRobo の結果画面（見るには RoboRobo へのログインが要る）
  articles          jsonb,                   -- 注目度の高い順に 20 件（題名・URL・出典・掲載日・注目度）
  decision          smallint check (decision in (0,1,2)),  -- RoboRobo の取引判断（保留 0・承認 1・否認 2）
  decision_comment  text,
  decision_at       timestamptz,
  decision_ref      bigint,                  -- RoboRobo の取引判断 ID
  attempts          int not null default 0,  -- 送った回数（失敗の送り直しを数える）
  next_try_at       timestamptz,
  error_text        text,
  payload           jsonb,                   -- 届いた結果そのまま（監査用・記事は 200 件まで）
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists ix_cci_check on public.compliance_check_item(check_id);
create index if not exists ix_cci_state on public.compliance_check_item(state);
create index if not exists ix_cci_exec on public.compliance_check_item(rr_execution_id);
create index if not exists ix_cci_customer on public.compliance_check_item(rr_customer_id);
create index if not exists ix_cci_company on public.compliance_check_item(company_id);
create index if not exists ix_cc_company_req on public.compliance_check(company_id, requested_at desc);

-- ===== 3. 設定（1 行） =====
create table if not exists public.antisocial_setting (
  id                   smallint primary key default 1 check (id = 1),
  enabled              boolean not null default false,  -- 決まりに沿って自動で頼むか（false＝画面の［反社チェックを流す］だけ）
  use_prod_token       boolean not null default false,  -- true＝本番のトークン（契約のあと）。false＝テスト環境のトークン（回は試し）
  auto_rule            varchar(20) not null default 'zero_hits' check (auto_rule in ('zero_hits','no_high')),
                                                         -- zero_hits＝どの検索もヒット 0 件なら該当なし／no_high＝注目度 高 0 件・新聞 0 件・DB ヒットなしなら該当なし
  check_rep            boolean not null default true,   -- 代表者も調べる
  on_credit            boolean not null default true,   -- ① SF の申請（申請中）で頼む
  on_register          boolean not null default false,  -- ② ツールに会社を登録したら頼む（本番のトークンのときだけ）
  periodic             boolean not null default false,  -- ③ 1 年ごとの見直し（本番のトークンのときだけ）
  periodic_monthly_cap int not null default 100 check (periodic_monthly_cap between 0 and 1000),
  periodic_days_before int not null default 30 check (periodic_days_before between 0 and 120),
  updated_at           timestamptz not null default now(),
  updated_by           varchar(80)
);
insert into public.antisocial_setting (id) values (1) on conflict (id) do nothing;
-- 変えた時刻と人は DB が付ける（人が時刻を決めない）
create or replace function public.antisocial_setting_touch() returns trigger
language plpgsql as $$
declare v_claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
  new.updated_at := now();
  new.updated_by := left(coalesce(case when v_claims is not null then v_claims::jsonb ->> 'email' end, current_user), 80);
  return new;
end $$;
drop trigger if exists ast_touch on public.antisocial_setting;
create trigger ast_touch before update on public.antisocial_setting
  for each row execute function public.antisocial_setting_touch();

-- ===== 4. 小さな道具 =====
-- 代表者名を検索の言葉に（最初の 1 人・括弧の中・役職・空白を落とす）
create or replace function public.antisocial_norm_rep(p text) returns text
language sql immutable as $$
  select case when char_length(x) >= 2 then x end from (
    select regexp_replace(regexp_replace(regexp_replace(
             split_part(regexp_replace(coalesce(p, ''), '[、,，/／;；]', '、', 'g'), '、', 1),
             '[（(][^）)]*[）)]', '', 'g'),
             '(代表取締役社長|代表取締役会長|代表取締役副社長|代表取締役専務|代表取締役常務|代表取締役|取締役社長|代表執行役社長|代表執行役|執行役員社長|代表社員|業務執行社員|職務執行者|代表理事長|代表理事|理事長|代表者|社長|会長|院長|学長|組合長|代表|CEO|ＣＥＯ)', '', 'g'),
             '[[:space:]　・]+', '', 'g') as x
  ) s
$$;

-- 組織か個人か（法人番号がある・社名に法人の形があれば組織。法人／個人区分が個人なら個人。分からなければ組織）
create or replace function public.antisocial_entity_type(p_name text, p_corp text, p_class text) returns varchar
language sql immutable as $$
  select case
    when coalesce(p_corp, '') ~ '^[0-9]{13}$' then '組織'
    when coalesce(p_name, '') ~ '(株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|㈱|㈲|\(株\)|（株）|\(有\)|（有）|社団法人|財団法人|医療法人|学校法人|宗教法人|社会福祉法人|特定非営利活動法人|NPO法人|独立行政法人|国立大学法人|監査法人|税理士法人|弁護士法人|弁理士法人|司法書士法人|行政書士法人|社会保険労務士法人|協同組合|組合|機構|公社|共同企業体|ＪＶ|Co\.|Ltd|Inc|Corp|LLC|GmbH)' then '組織'
    when p_class = '個人' then '個人'
    else '組織' end
$$;

-- 官公庁・公的な法人らしい名前（1 年ごとの見直しから外す目安）
create or replace function public.antisocial_is_public_name(p_name text) returns boolean
language sql immutable as $$
  select coalesce(p_name, '') ~ '(国土交通省|防衛省|省$|庁$|都庁|県庁|市役所|区役所|町役場|村役場|独立行政法人|国立大学法人|地方独立行政法人|機構$|公社$|税務署|年金事務所|法務局|労働基準監督署|裁判所)'
$$;

-- ===== 5. 回の結果を項目から決める（項目が変わるたびに DB が呼ぶ） =====
create or replace function public.compliance_round_refresh(p_check_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  n_total int; n_wait int; n_rev int; n_ng int; n_err int; n_ok int; n_dec int;
  v_result varchar(20); v_checked date;
begin
  select count(*),
         count(*) filter (where state in ('依頼待ち','調査中')),
         count(*) filter (where state = '要確認'),
         count(*) filter (where state = '取引不可'),
         count(*) filter (where state = 'エラー'),
         count(*) filter (where state = '問題なし'),
         count(*) filter (where decision is not null)
    into n_total, n_wait, n_rev, n_ng, n_err, n_ok, n_dec
    from compliance_check_item where check_id = p_check_id;
  if coalesce(n_total, 0) = 0 then return; end if;
  v_result := case
    when n_ng > 0 then '取引不可'
    when n_rev > 0 then '要確認'
    when n_wait > 0 then '調査中'
    when n_err > 0 then 'エラー'
    when n_ok > 0 then '問題なし'
    else '該当なし' end;
  select max((checked_at at time zone 'Asia/Tokyo')::date) into v_checked
    from compliance_check_item where check_id = p_check_id;
  update compliance_check c set
    result       = v_result,
    checked_on   = coalesce(v_checked, c.checked_on),
    valid_until  = case when v_result in ('該当なし','問題なし')
                        then (coalesce(v_checked, c.checked_on) + interval '1 year' - interval '1 day')::date end,
    completed_at = case when v_result in ('該当なし','問題なし','取引不可') then coalesce(c.completed_at, now()) end,
    checked_by   = case when v_result in ('該当なし','問題なし','取引不可')
                        then case when n_dec > 0 then '経理（RoboRobo の取引判断）' else 'RoboRobo（自動）' end end
  where c.check_id = p_check_id and c.source = 'roborobo'
    and (c.result is distinct from v_result or c.checked_on is distinct from coalesce(v_checked, c.checked_on)
         or (v_result in ('該当なし','問題なし') and c.valid_until is null));
end $$;

create or replace function public.trg_cci_refresh() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform compliance_round_refresh(old.check_id);
  else
    perform compliance_round_refresh(new.check_id);
  end if;
  return null;
end $$;
drop trigger if exists cci_refresh on public.compliance_check_item;
create trigger cci_refresh after insert or update or delete on public.compliance_check_item
  for each row execute function public.trg_cci_refresh();

-- RoboRobo の回は人（画面・REST）から直せない・消せない（関数＝service_role と SQL Editor だけ）
create or replace function public.compliance_check_guard() returns trigger
language plpgsql as $$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_role text := coalesce(case when v_claims is not null then v_claims::jsonb ->> 'role' end, nullif(current_setting('request.jwt.claim.role', true), ''));
begin
  if v_role = 'authenticated' then
    if tg_op = 'DELETE' then
      if old.source = 'roborobo' then raise exception 'RoboRobo の反社チェックの記録は消せません'; end if;
      return old;
    end if;
    if tg_op = 'UPDATE' then
      if old.source = 'roborobo' then raise exception 'RoboRobo の反社チェックの記録は直せません（判断は RoboRobo の画面で打ちます）'; end if;
    end if;
    if new.source = 'roborobo' then raise exception 'RoboRobo の回は関数だけが作ります'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists compliance_check_guard on public.compliance_check;
create trigger compliance_check_guard before insert or update or delete on public.compliance_check
  for each row execute function public.compliance_check_guard();

-- ===== 6. 今の状態（持たずに計算する） =====
-- status: 未実施／調査中／要確認／該当なし／問題なし／取引不可／期限切れ／エラー
--   最新の回が「取引不可」「要確認」ならそれ。有効な「該当なし」「問題なし」があればそれ（新しい回を調べている途中でも）。
--   有効期限＝回の valid_until（手入力で空なら実施日から 1 年）。試しの回（is_test）は数えない。
create or replace view public.v_compliance_status with (security_invoker = true) as
with r as (
  select c.*, row_number() over (partition by c.company_id
           order by coalesce(c.requested_at, c.checked_on::timestamptz) desc, c.check_id desc) as rn
  from public.compliance_check c where not c.is_test
), okv as (
  select distinct on (company_id) company_id, result, checked_on,
         coalesce(valid_until, (checked_on + interval '1 year' - interval '1 day')::date) as valid_until
  from public.compliance_check
  where not is_test and result in ('該当なし','問題なし')
  order by company_id, coalesce(valid_until, (checked_on + interval '1 year' - interval '1 day')::date) desc
), today as (select (now() at time zone 'Asia/Tokyo')::date as d)
select co.company_id, co.official_name, co.registration_stage, co.is_suspended, co.is_test,
       (select array_agg(t.type_code order by t.type_code) from public.company_type t where t.company_id = co.company_id) as type_codes,
       l.check_id as latest_check_id, l.result as latest_result, l.checked_on as latest_checked_on,
       l.source as latest_source, l.trigger_kind as latest_trigger,
       o.result as ok_result, o.checked_on as ok_checked_on, o.valid_until as ok_valid_until,
       case
         when l.result = '取引不可' then '取引不可'
         when l.result = '要確認' then '要確認'
         when o.valid_until >= (select d from today) then o.result
         when l.result in ('調査中','エラー') then l.result
         when o.valid_until is not null then '期限切れ'
         else '未実施' end as status,
       case when o.valid_until >= (select d from today) then o.checked_on end as status_checked_on,
       case when o.valid_until >= (select d from today) then o.valid_until end as status_valid_until
from public.company co
left join r l on l.company_id = co.company_id and l.rn = 1
left join okv o on o.company_id = co.company_id;
comment on view public.v_compliance_status is '会社ごとの反社チェックの今の状態（毎回計算・期限切れが日付で出る・試しの回は数えない）';

-- ===== 7. 頼む（回と項目を作る＝依頼待ち。送るのは関数） =====
-- 返り値＝作った回の check_id。作らなかったとき（試験の会社・調べている途中・同じ稟議で作った・有効な結果がある）は null。
create or replace function public.antisocial_enqueue(p_company_id varchar, p_trigger varchar, p_ref varchar, p_is_test boolean, p_by varchar)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  co record; s record; v_check bigint; v_rep text; v_entity varchar(4); v_folder varchar(80);
  v_today date := (now() at time zone 'Asia/Tokyo')::date; v_need date;
begin
  if p_trigger not in ('与信の稟議','取引開始申請','登録','定期','手動') then raise exception 'きっかけが違います: %', p_trigger; end if;
  select * into co from company where company_id = p_company_id;
  if not found then raise exception '会社がありません: %', p_company_id; end if;
  if coalesce(co.is_test, false) then return null; end if;                       -- 試験の帯の会社は流さない
  select * into s from antisocial_setting where id = 1;
  if exists (select 1 from compliance_check where company_id = p_company_id and source = 'roborobo'
               and is_test = coalesce(p_is_test, false) and result in ('調査中','要確認')) then return null; end if;
  if p_ref is not null and exists (select 1 from compliance_check where company_id = p_company_id and source = 'roborobo'
               and trigger_ref = p_ref and is_test = coalesce(p_is_test, false)) then return null; end if;
  if p_trigger <> '手動' and not coalesce(p_is_test, false) then
    v_need := case when p_trigger = '定期' then v_today + coalesce(s.periodic_days_before, 30) else v_today end;
    if exists (select 1 from v_compliance_status v where v.company_id = p_company_id
                 and v.status in ('該当なし','問題なし') and v.status_valid_until > v_need) then return null; end if;
  end if;
  -- 代表者名の欄を先に使う（検索用の名前の欄は古い値・名前でない言葉が残っていることがある＝2026-11-15 有効の会社で 43 社が食い違い）
  v_rep := antisocial_norm_rep(coalesce(nullif(btrim(co.representative_name), ''), co.search_rep_normalized));
  v_entity := antisocial_entity_type(co.official_name, co.corporate_number, co.entity_class);
  v_folder := left(case p_trigger when '定期' then '定期' when '手動' then '手動' when '登録' then '登録' else '新規' end
                   || ' ' || to_char(v_today, 'YYYY-MM') || case when coalesce(p_is_test, false) then '（試し）' else '' end, 80);
  insert into compliance_check (company_id, checked_on, result, method, source, trigger_kind, trigger_ref, is_test,
                                requested_at, requested_by, name_at_check, rep_at_check)
  values (p_company_id, v_today, '調査中', 'RoboRobo API', 'roborobo', p_trigger, left(p_ref, 80), coalesce(p_is_test, false),
          now(), left(p_by, 80), left(co.official_name, 200), left(v_rep, 100))
  returning check_id into v_check;
  insert into compliance_check_item (check_id, company_id, subject, name_sent, management_number, entity_type, folder_name)
  values (v_check, p_company_id, '会社', left(co.official_name, 200), p_company_id, v_entity, v_folder);
  if coalesce(s.check_rep, true) and v_rep is not null and v_entity = '組織' then
    insert into compliance_check_item (check_id, company_id, subject, name_sent, relative_word, management_number, entity_type, folder_name)
    values (v_check, p_company_id, '代表者', left(v_rep, 200), left(co.official_name, 200), p_company_id || '-R', '個人', v_folder);
  end if;
  return v_check;
end $$;

-- 決まりに沿って頼む（関数の定時実行から呼ぶ）。① SF の申請 ② 登録 ③ 1 年ごとの見直し
create or replace function public.antisocial_enqueue_due() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s record; r record; v_id bigint; n_credit int := 0; n_reg int := 0; n_per int := 0;
  v_today date := (now() at time zone 'Asia/Tokyo')::date; v_cap int; v_used_month int; v_used_day int;
begin
  select * into s from antisocial_setting where id = 1;
  if not found or not s.enabled then return jsonb_build_object('enabled', false); end if;
  -- ① SF の与信の稟議・取引開始申請が申請中（本番の SF は本番のトークンがあるときだけ・試験の org は試しで流す）
  if s.on_credit then
    for r in select n.company_id, n.kind, n.application_no, n.is_prod, coalesce(n.org_label, n.org_id) as org
               from credit_notice n
              where n.kind in ('与信','取引開始') and n.company_id is not null and n.done_at is null
                and n.stage = '申請中' and n.received_at > now() - interval '30 days'
              order by n.received_at loop
      if r.is_prod and not s.use_prod_token then continue; end if;
      v_id := antisocial_enqueue(r.company_id, case r.kind when '与信' then '与信の稟議' else '取引開始申請' end,
                                 r.application_no, not r.is_prod, 'SF ' || r.org);
      if v_id is not null then n_credit := n_credit + 1; end if;
    end loop;
  end if;
  -- ② ツールに会社を登録した（7 日以内・SF の箱と移行は除く・販管費先だけの会社は除く・一度も調べていない）
  if s.on_register and s.use_prod_token then
    for r in select c.company_id from company c
              where c.created_at > now() - interval '7 days'
                and not coalesce(c.is_test, false) and not coalesce(c.is_suspended, false)
                and coalesce(c.data_source, '') <> 'migration' and coalesce(c.data_source, '') not like 'salesforce%'
                and exists (select 1 from company_type t where t.company_id = c.company_id and t.type_code <> 'sga')
                and not exists (select 1 from compliance_check k where k.company_id = c.company_id and k.source = 'roborobo')
              order by c.created_at loop
      v_id := antisocial_enqueue(r.company_id, '登録', null, false, '登録（自動）');
      if v_id is not null then n_reg := n_reg + 1; end if;
    end loop;
  end if;
  -- ③ 1 年ごとの見直し（本登録の会社・取引の種別がある会社・上場と官公庁らしい会社を除く・顧客→外注→ほかの順・月と日の上限でならす）
  --    仮登録（SF の箱）は申請（①）のときに調べるので、見直しには入れない
  if s.periodic and s.use_prod_token then
    select count(*) filter (where requested_at >= (date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo')),
           count(*) filter (where requested_at >= (v_today::timestamp at time zone 'Asia/Tokyo'))
      into v_used_month, v_used_day
      from compliance_check where source = 'roborobo' and not is_test and trigger_kind = '定期';
    v_cap := least(greatest(s.periodic_monthly_cap - v_used_month, 0),
                   greatest(ceil(s.periodic_monthly_cap / 20.0)::int - v_used_day, 0));
    if v_cap > 0 then
      for r in select v.company_id from v_compliance_status v join company c on c.company_id = v.company_id
                where not coalesce(c.is_suspended, false) and not coalesce(c.is_test, false) and c.registration_stage = 'full'
                  and coalesce(c.listing_class, '') <> '上場' and not antisocial_is_public_name(c.official_name)
                  and exists (select 1 from company_type t where t.company_id = c.company_id and t.type_code <> 'sga')
                  and (v.status in ('未実施','期限切れ')
                       or (v.status in ('該当なし','問題なし') and v.status_valid_until <= v_today + s.periodic_days_before))
                order by ('customer' = any(coalesce(v.type_codes, '{}'))) desc,
                         ('subcontractor' = any(coalesce(v.type_codes, '{}'))) desc,
                         coalesce(v.ok_valid_until, v.latest_checked_on, date '1900-01-01'), c.company_id
                limit v_cap loop
        v_id := antisocial_enqueue(r.company_id, '定期', null, false, '定期（自動）');
        if v_id is not null then n_per := n_per + 1; end if;
      end loop;
    end if;
  end if;
  return jsonb_build_object('enabled', true, 'credit', n_credit, 'register', n_reg, 'periodic', n_per);
end $$;

-- ===== 8. 結果を取り込む（RoboRobo の結果の送付・結果の取得の両方） =====
-- p＝{ resultList: [...] }（送付の本文・チェック結果詳細取得の返事と同じ形）。返り値＝取り込んだ件数
create or replace function public.antisocial_apply_result(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  e jsonb; it public.compliance_check_item%rowtype; n int := 0; v_rule varchar(20);
  v_total int; v_high int; v_mid int; v_low int; v_none int; v_excl int; v_news int; v_bl boolean;
  v_db_hit boolean; v_db_err boolean; v_state varchar(10); v_dec int; v_checked timestamptz; v_articles jsonb; v_list jsonb;
begin
  if p is null or jsonb_typeof(p -> 'resultList') is distinct from 'array' then return 0; end if;
  select auto_rule into v_rule from antisocial_setting where id = 1;
  v_rule := coalesce(v_rule, 'zero_hits');
  for e in select x from jsonb_array_elements(p -> 'resultList') as t(x) loop
    if jsonb_typeof(e) is distinct from 'object' or e ->> 'totalUrlCount' is null then continue; end if;  -- まだ結果が無い
    it.item_id := null;
    if (e ->> 'checkExecutionId') is not null then
      select * into it from compliance_check_item where rr_execution_id = (e ->> 'checkExecutionId')::bigint order by item_id desc limit 1;
    end if;
    if it.item_id is null and (e ->> 'customerId') is not null then
      select * into it from compliance_check_item where rr_customer_id = (e ->> 'customerId')::bigint
        and state in ('調査中','依頼待ち') order by item_id desc limit 1;
    end if;
    if it.item_id is null and (e ->> 'managementNumber') is not null then  -- 送った記録より先に結果が届いたとき
      select * into it from compliance_check_item where management_number = e ->> 'managementNumber'
        and name_sent = e ->> 'customerName' and state in ('調査中','依頼待ち') order by item_id desc limit 1;
    end if;
    if it.item_id is null then continue; end if;
    v_total := coalesce((e ->> 'totalUrlCount')::int, 0);
    v_high  := coalesce((e #>> '{riskLevelCount,high}')::int, 0);
    v_mid   := coalesce((e #>> '{riskLevelCount,middle}')::int, 0);
    v_low   := coalesce((e #>> '{riskLevelCount,low}')::int, 0);
    v_none  := coalesce((e #>> '{riskLevelCount,none}')::int, 0);
    v_excl  := coalesce((e #>> '{riskLevelCount,exclude}')::int, 0);
    v_news  := coalesce((e #>> '{newspaperResult,articleCount}')::int, 0);
    v_bl    := jsonb_typeof(e -> 'blacklistInfo') = 'array' and jsonb_array_length(e -> 'blacklistInfo') > 0;
    v_db_hit := coalesce(e #>> '{spnResult,result}', '') = 'あり' or coalesce(e #>> '{bankruptSearchResult,result}', '') = 'あり'
             or coalesce(e #>> '{worldCheckResult,result}', '') = 'あり';
    v_db_err := coalesce(e #>> '{spnResult,result}', '') = 'エラー' or coalesce(e #>> '{bankruptSearchResult,result}', '') = 'エラー'
             or coalesce(e #>> '{worldCheckResult,result}', '') = 'エラー' or coalesce(e #>> '{newspaperResult,message}', 'success') <> 'success';
    -- 自動で該当なしにする線（ツール独自の点数は作らず RoboRobo の数をそのまま使う）
    if v_bl or v_db_hit or v_db_err or v_news > 0 then v_state := '要確認';
    elsif v_total = 0 then v_state := '該当なし';
    elsif v_rule = 'no_high' and v_high = 0 then v_state := '該当なし';
    else v_state := '要確認'; end if;
    -- 既に取引判断が付いていれば（結果の取得のとき）それに従う
    v_dec := case when (e ->> 'checkDecisionChoice') ~ '^[0-2]$' then (e ->> 'checkDecisionChoice')::int end;
    if v_dec = 1 and v_state = '要確認' then v_state := '問題なし';
    elsif v_dec = 2 then v_state := '取引不可'; end if;
    v_checked := case when coalesce(e ->> 'checkedExecutionAt', '') ~ '^\d{4}-\d{2}-\d{2}'
                      then ((e ->> 'checkedExecutionAt')::timestamp at time zone 'Asia/Tokyo') end;
    v_list := case when jsonb_typeof(e -> 'checkResultList') = 'array' then e -> 'checkResultList' else '[]'::jsonb end;
    select coalesce(jsonb_agg(a order by ord, rn), '[]'::jsonb) into v_articles from (
      select jsonb_build_object('title', x ->> 'title', 'url', x ->> 'url',
                                'site', coalesce(x ->> 'domainName', x ->> 'domain'),
                                'date', coalesce(x ->> 'publicationDate', x ->> 'publication_date'),
                                'risk', case when (x ->> 'riskLevelScore') ~ '^-?\d+$' then (x ->> 'riskLevelScore')::int end) as a,
             case x ->> 'riskLevelScore' when '0' then 0 when '1' then 1 when '2' then 2 when '3' then 3 else 4 end as ord, rn
        from jsonb_array_elements(v_list) with ordinality as t(x, rn)
       order by ord, rn limit 20) s;
    update compliance_check_item set
      state           = case when state in ('問題なし','取引不可') and v_dec is null then state else v_state end,  -- 人の判断は上書きしない
      rr_customer_id  = coalesce(rr_customer_id, (e ->> 'customerId')::bigint),
      rr_execution_id = coalesce(rr_execution_id, (e ->> 'checkExecutionId')::bigint),
      received_at     = now(),
      checked_at      = coalesce(v_checked, checked_at),
      hit_total = v_total, hit_high = v_high, hit_middle = v_mid, hit_low = v_low, hit_none = v_none, hit_exclude = v_excl,
      newspaper_count = v_news,
      blacklist_hit   = v_bl,
      other_hits      = jsonb_strip_nulls(jsonb_build_object('spn', e -> 'spnResult', 'bankrupt', e -> 'bankruptSearchResult',
                          'worldCheck', e -> 'worldCheckResult', 'llm', e -> 'llmRiskLevelCount', 'newspaper', e -> 'newspaperResult')),
      compliance_url  = coalesce(e ->> 'complianceUrl', compliance_url),
      articles        = v_articles,
      decision        = coalesce(v_dec, decision),
      payload         = case when jsonb_array_length(v_list) > 200
                             then jsonb_set(e, '{checkResultList}', (select jsonb_agg(x) from (select x from jsonb_array_elements(v_list) as t(x) limit 200) s2))
                             else e end,
      error_text      = null,
      updated_at      = now()
    where item_id = it.item_id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ===== 9. 取引判断を取り込む（RoboRobo の取引判断・コメント取得 API の返事） =====
-- p＝{ checkDecisionList: [...] }。承認→問題なし／否認→取引不可／保留→要確認（該当なしは承認でもそのまま）
create or replace function public.antisocial_apply_decisions(p jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare e jsonb; it public.compliance_check_item%rowtype; n int := 0; v_dec int; v_at timestamptz;
begin
  if p is null or jsonb_typeof(p -> 'checkDecisionList') is distinct from 'array' then return 0; end if;
  for e in select x from jsonb_array_elements(p -> 'checkDecisionList') as t(x) loop
    v_dec := case when (e ->> 'checkDecisionChoice') ~ '^[0-2]$' then (e ->> 'checkDecisionChoice')::int end;
    if v_dec is null then continue; end if;
    it.item_id := null;
    if (e ->> 'checkExecutionId') is not null then
      select * into it from compliance_check_item where rr_execution_id = (e ->> 'checkExecutionId')::bigint order by item_id desc limit 1;
    end if;
    if it.item_id is null and (e ->> 'customerId') is not null then
      select * into it from compliance_check_item where rr_customer_id = (e ->> 'customerId')::bigint
        and state in ('要確認','問題なし','取引不可','該当なし') order by item_id desc limit 1;
    end if;
    if it.item_id is null then continue; end if;
    v_at := case when coalesce(e ->> 'updatedAt', '') ~ '^\d{4}-\d{2}-\d{2}' then ((e ->> 'updatedAt')::timestamp at time zone 'Asia/Tokyo') else now() end;
    -- 古い判断で上書きしない。同じ時刻なら判断の番号が新しい方を残す
    --（RoboRobo は 1 回の判断を同じ時刻の 2 行＝コメントあり・なしで返すことがある＝2026-11-15 テスト環境で確かめた）
    if it.decision_at is not null and (it.decision_at > v_at or (it.decision_at = v_at
         and coalesce(it.decision_ref, 0) >= coalesce((e ->> 'checkDecisionId')::bigint, 0))) then continue; end if;
    if it.state in ('依頼待ち','調査中','エラー') then continue; end if;                    -- 結果が来る前の判断は次の回で
    update compliance_check_item set
      decision = v_dec, decision_comment = left(e ->> 'comment', 2000), decision_at = v_at,
      decision_ref = (e ->> 'checkDecisionId')::bigint,
      state = case when v_dec = 2 then '取引不可'
                   when v_dec = 1 then case when state = '該当なし' then '該当なし' else '問題なし' end
                   else case when state = '該当なし' then '該当なし' else '要確認' end end,
      updated_at = now()
    where item_id = it.item_id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ===== 10. 権限（見るのは管理者と経理・書くのは関数だけ／設定を変えるのは管理者） =====
alter table public.compliance_check_item enable row level security;
drop policy if exists cci_sel on public.compliance_check_item;
create policy cci_sel on public.compliance_check_item for select to authenticated using (app_role() in ('admin','accounting'));
alter table public.antisocial_setting enable row level security;
drop policy if exists ast_sel on public.antisocial_setting;
drop policy if exists ast_upd on public.antisocial_setting;
create policy ast_sel on public.antisocial_setting for select to authenticated using (app_role() in ('admin','accounting'));
create policy ast_upd on public.antisocial_setting for update to authenticated using (app_role() = 'admin') with check (app_role() = 'admin');
revoke all on function public.antisocial_enqueue(varchar, varchar, varchar, boolean, varchar) from public, anon, authenticated;
revoke all on function public.antisocial_enqueue_due() from public, anon, authenticated;
revoke all on function public.antisocial_apply_result(jsonb) from public, anon, authenticated;
revoke all on function public.antisocial_apply_decisions(jsonb) from public, anon, authenticated;
revoke all on function public.compliance_round_refresh(bigint) from public, anon, authenticated;
grant execute on function public.antisocial_enqueue(varchar, varchar, varchar, boolean, varchar) to service_role;
grant execute on function public.antisocial_enqueue_due() to service_role;
grant execute on function public.antisocial_apply_result(jsonb) to service_role;
grant execute on function public.antisocial_apply_decisions(jsonb) to service_role;
grant execute on function public.compliance_round_refresh(bigint) to service_role;
grant select on public.v_compliance_status to authenticated;

-- 流した結果（SQL Editor に出るのはこの 1 行）: setting_rows 1・new_columns 8・item_table 1・companies＝会社の数・roborobo_rounds 0（初回）
select (select count(*) from public.antisocial_setting) as setting_rows,
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'compliance_check'
          and column_name in ('source','trigger_kind','trigger_ref','is_test','requested_at','requested_by','completed_at','note')) as new_columns,
       (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'compliance_check_item') as item_table,
       (select count(*) from public.v_compliance_status) as companies,
       (select count(*) from public.compliance_check where source = 'roborobo') as roborobo_rounds;

-- 【確認】 select * from antisocial_setting;
--         select status, count(*) from v_compliance_status where not is_suspended group by status order by 2 desc;
-- 【戻す】 drop view v_compliance_status; drop table compliance_check_item; drop table antisocial_setting;
--         drop trigger compliance_check_guard on compliance_check;（足した列は残しても害はない）
