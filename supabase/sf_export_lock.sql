-- 取引先マスタ配信（sf-export）の全件配信 同時実行ガード — 2026-09-11
--
-- 事象: 夜間 5:30 JST の pg_cron（sf-export-daily）は net.http_post を1本しか出していない（net._http_response が1行）のに、
--       関数 sf-export が約1秒差で2回起動する事象が 9/10・9/11 と2日連続した（連携ログ #28/#29・#35/#36）。
--       cron の二重登録ではなく Supabase 側の二重配送（pg_net の再送か関数リレーの再試行）。
--       配信は冪等なので結果は同じだが、API 呼び出しが2倍になり、同じ Account を同時に更新して行ロック競合
--       （UNABLE_TO_LOCK_ROW）になる芽がある。cron 設定は触らず、関数側で直列化する。
-- 仕組み: 1行のロック表を「1文の UPDATE」で取る。Postgres は行ロック待ちの後に WHERE を再評価するため、
--       同時に2本来ても片方だけが true を得る。後から来た方は書かずに連携ログへ kind='skip'（見送り）を1行残して返す。
--       ガードの窓は 120 秒（全件配信は約 25 秒）。対象は本当の全件だけ（即時配信 direct・company_ids 指定・limit 付きの試し流しは掛けない）。
-- 実行: SQL Editor に貼って Run（鍵は不要・再実行可）。その後 sf-export（v2026-09-11.1 以降）を Via Editor で再デプロイ。

-- 1. ロック表（mode ごとに1行。今は 'full' だけ）
create table if not exists public.sf_export_lock (
  mode        text primary key,
  started_at  timestamptz,
  finished_at timestamptz,
  holder      text
);
insert into public.sf_export_lock (mode) values ('full') on conflict do nothing;
alter table public.sf_export_lock enable row level security;
revoke all on public.sf_export_lock from anon, authenticated;

-- 2. 取得: p_window_sec 秒以内に開始した実行が無ければ取得して acquired=true。あれば false と、先に取った実行の開始時刻・名乗りを返す
--    （戻り列名は表の列名と別にしてある＝PL/pgSQL で変数と列名が曖昧にならないように）
create or replace function public.sf_export_try_lock(p_mode text, p_holder text, p_window_sec int default 120)
returns table (acquired boolean, lock_started_at timestamptz, lock_holder text)
language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  insert into public.sf_export_lock (mode) values (p_mode) on conflict do nothing;
  update public.sf_export_lock l
     set started_at = now(), finished_at = null, holder = p_holder
   where l.mode = p_mode
     and (l.started_at is null or l.started_at < now() - make_interval(secs => p_window_sec))
  returning l.started_at, l.holder into r;
  if found then
    return query select true, r.started_at, r.holder;
    return;
  end if;
  return query select false, l.started_at, l.holder from public.sf_export_lock l where l.mode = p_mode;
end $$;

-- 3. 解放（情報用。ガードの判定は started_at だけで行うため、解放し忘れても窓が過ぎれば次は取れる）
create or replace function public.sf_export_release_lock(p_mode text) returns void
language sql security definer set search_path = public as $$
  update public.sf_export_lock set finished_at = now() where mode = p_mode;
$$;

revoke execute on function public.sf_export_try_lock(text, text, int) from public, anon, authenticated;
revoke execute on function public.sf_export_release_lock(text) from public, anon, authenticated;

-- 4. 連携ログに「見送り」の種類を足す（既存の表の制約を差し替え。integration_log.sql の新規作成側にも同じ4値を入れてある）
alter table public.integration_log drop constraint if exists integration_log_kind_check;
alter table public.integration_log add constraint integration_log_kind_check check (kind in ('run','error','note','skip'));

-- service_role（Edge Function）には明示的に許可する（既定権限に頼らない）。anon／authenticated からは触れない
grant all on public.sf_export_lock to service_role;
grant execute on function public.sf_export_try_lock(text, text, int) to service_role;
grant execute on function public.sf_export_release_lock(text) to service_role;

-- 【確認】 select * from public.sf_export_lock;
--          select at, kind, trigger, left(message, 80) from public.integration_log where kind in ('run','skip') order by at desc limit 6;
-- 【期待】 翌朝 5:30 は run 1行（送信 2,339）＋ skip 1行（見送り）になる。skip が出なければ二重配送が止まっただけ＝それも正常
