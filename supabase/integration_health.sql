-- 連携の見張り（2026-10-29 坂本さん「エラー通知は A（画面の帯）と B（Teams）の両方」）
--
-- 発端：配置の取込（sf-import）が 10/19〜10/29 の 11 日間、毎朝失敗していたのに誰も気づけなかった
--       （SF 本番の実行ユーザーの権限が変わり、レポートの列が消えた）。記録（audit_logs）には残っていた。
--
-- 中身：
--   integration_health_core()   … 点検の本体。問題ごとに 1 行（ok=false が問題）。service_role だけが呼べる
--   integration_health()        … 画面の帯（A）用。admin／accounting のときだけ core の結果を返す
--   integration_alert           … Teams（B）に出す警報の表。同じ問題は JST の 1 日に 1 行だけ
--   integration_health_record() … core を見て、問題を integration_alert に積む（pg_cron が 1 時間おきに呼ぶ）
--   RSS の出口は Edge Function integration-health-feed（手順書＝supabase/PHASE_INTEGRATION_HEALTH_SETUP.md）
--
-- 見るもの：
--   sf_import            … 配置の取込（SF 本番 → 現場人員配置）。毎朝 6:00 JST
--                          ①最後の記録が失敗 ②26 時間以上成功していない ③行数が前回の半分未満
--   sf_export:<org の Id> … 取引先の配信（統合管理ツール → SF）。夜間全件は毎朝 5:30 JST
--                          ①夜間全件の失敗件数が 1 以上 ②26 時間以上夜間全件が来ていない ③24 時間以内に error の記録
--                          （直近 7 日に夜間全件が来た org と、24 時間以内に error が出た org が対象）
--
-- SQL Editor で 1 回実行する（再実行しても壊れない）。

-- ===== 1. 警報の表 =====
create table if not exists public.integration_alert (
  alert_key  text not null,          -- 'sf_import'／'sf_export:00Dfd000002CDWc'
  day        date not null,          -- JST の日付（同じ問題は 1 日 1 回）
  title      text not null,
  detail     text,
  first_seen timestamptz not null default now(),   -- RSS の pubDate（DB が付ける）
  primary key (alert_key, day)
);
alter table public.integration_alert enable row level security;
revoke all on public.integration_alert from anon, authenticated;

-- ===== 2. 点検の本体 =====
create or replace function public.integration_health_core()
returns table (alert_key text, label text, ok boolean, detail text, last_success timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_last   record;
  v_ok     record;
  v_prev_n int;
  v_n      int;
  r        record;
  v_run    record;
  v_err    record;
begin
  -- --- 配置の取込 ---
  select a.at, a.op, a.changes into v_last
    from audit_logs a where a.table_name = 'salesforce_imports' and a.op in ('IMPORT', 'ERROR')
    order by a.id desc limit 1;
  select a.at, a.changes into v_ok
    from audit_logs a where a.table_name = 'salesforce_imports' and a.op = 'IMPORT'
    order by a.id desc limit 1;
  select nullif(a.changes->'imported'->>'new', '')::int into v_prev_n
    from audit_logs a where a.table_name = 'salesforce_imports' and a.op = 'IMPORT'
    order by a.id desc offset 1 limit 1;

  alert_key    := 'sf_import';
  label        := '配置の取込（SF 本番 → 現場人員配置）';
  last_success := v_ok.at;
  v_n          := nullif(v_ok.changes->'imported'->>'new', '')::int;
  if v_last.at is null then
    ok := false; detail := '取込の記録がありません';
  elsif v_last.op = 'ERROR' then
    ok := false; detail := '取込に失敗しています：' || coalesce(v_last.changes->'error'->>'new', '（理由の記録なし）');
  elsif v_ok.at < now() - interval '26 hours' then
    ok := false; detail := floor(extract(epoch from now() - v_ok.at) / 3600)::int || ' 時間、取込が動いていません';
  elsif v_prev_n > 0 and v_n is not null and v_n * 2 < v_prev_n then
    ok := false; detail := '取込の行数が前回の半分未満に減りました（' || v_prev_n || ' → ' || v_n || ' 行）';
  else
    ok := true; detail := coalesce(v_n::text, '?') || ' 行';
  end if;
  return next;

  -- --- 取引先の配信（送り先の org ごと） ---
  for r in
    select coalesce(substring(l.target from '00D[A-Za-z0-9]{12}'), '(接続先不明)') as org
      from integration_log l
     where l.system = 'salesforce'
       and ((l.trigger = '自動（夜間・全件）' and l.kind = 'run' and l.at > now() - interval '7 days')
         or (l.kind = 'error' and l.at > now() - interval '24 hours'))
     group by 1
  loop
    select l.at, l.target, l.counts into v_run
      from integration_log l
     where l.system = 'salesforce' and l.trigger = '自動（夜間・全件）' and l.kind = 'run'
       and coalesce(substring(l.target from '00D[A-Za-z0-9]{12}'), '(接続先不明)') = r.org
     order by l.id desc limit 1;
    select l.at, l.target, l.message into v_err
      from integration_log l
     where l.system = 'salesforce' and l.kind = 'error' and l.at > now() - interval '24 hours'
       and coalesce(substring(l.target from '00D[A-Za-z0-9]{12}'), '(接続先不明)') = r.org
     order by l.id desc limit 1;

    alert_key    := 'sf_export:' || r.org;
    label        := '取引先の配信（統合管理ツール → ' || coalesce(v_run.target, v_err.target, r.org) || '）';
    last_success := v_run.at;
    if v_err.at is not null then
      ok := false; detail := '配信でエラーが出ました：' || left(coalesce(v_err.message, '（本文なし）'), 300);
    elsif v_run.at is null or v_run.at < now() - interval '26 hours' then
      ok := false; detail := '夜間の全件配信が 26 時間以上来ていません';
    elsif coalesce(nullif(v_run.counts->>'failed', '')::int, 0) > 0 then
      ok := false; detail := '夜間の全件配信で ' || (v_run.counts->>'failed') || ' 件失敗しました';
    else
      ok := true; detail := coalesce(v_run.counts->>'sent', '?') || ' 件配信';
    end if;
    return next;
  end loop;
end;
$$;
revoke all on function public.integration_health_core() from public, anon, authenticated;

-- ===== 3. 画面の帯（A）用 =====
create or replace function public.integration_health()
returns table (alert_key text, label text, ok boolean, detail text, last_success timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select h.* from public.integration_health_core() h where public.app_role() in ('admin', 'accounting')
$$;
revoke all on function public.integration_health() from public, anon;
grant execute on function public.integration_health() to authenticated;

-- ===== 4. 警報を積む（B）=====
create or replace function public.integration_health_record()
returns int
language sql
security definer
set search_path = public
as $$
  with ins as (
    insert into public.integration_alert (alert_key, day, title, detail)
    select h.alert_key, (now() at time zone 'Asia/Tokyo')::date, h.label, h.detail
      from public.integration_health_core() h
     where not h.ok
    on conflict (alert_key, day) do nothing
    returning 1
  )
  select count(*)::int from ins
$$;
revoke all on function public.integration_health_record() from public, anon, authenticated;

-- ===== 5. 1 時間おきに点検（6:15〜20:15 JST＝21〜11 時 UTC の 15 分）=====
-- 夜中は鳴らさない（日付が変わった瞬間に前日と同じ問題で 0:15 に鳴るのを避ける）。
-- 取込は 6:00、夜間全件配信は 5:30 JST なので、最初の 6:15 で前夜〜今朝の失敗を拾う。
create extension if not exists pg_cron;
select cron.schedule(
  'integration-health-watch',
  '15 21-23,0-11 * * *',
  $$select public.integration_health_record()$$
);

-- 【確認】いまの点検結果（SQL Editor は service_role 相当なので core を直接呼べる）
-- select * from public.integration_health_core();
-- 【確認】積まれた警報
-- select * from public.integration_alert order by first_seen desc limit 10;
-- 【解除したい場合】
-- select cron.unschedule('integration-health-watch');
