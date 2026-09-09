-- 連携ログの時刻ガード（2026-09-09・坂本さん指摘「時間がまた変」への根本対応）
--
-- 原因: 台帳の移行で、人（Claude）が記録時刻 at を手で指定した（18:30 という未来の時刻を含む）。
--       9/8 の「一括処理で JST を入れて9時間未来」も根は同じ＝記録時刻を人が決めていた。
-- 対策:
--   1. 記録時刻はシステムだけが付ける。画面・スクリプト（authenticated）からの insert は、送られてきた at を無視して now() で上書きし、
--      記録者もログイン情報（JWT の email）から取る。kind も note に固定（run/error は Edge Function＝service_role だけが書く）
--   2. 「出来事の日付」（event_on・人が書く日付）と「記録日時」（at・システム）を分ける。過去の出来事を書き起こすときは event_on に入れる
--   3. 移行済みの9行は、記録日時を実際に挿入した時刻（2026-09-09 04:58 UTC＝13:58 JST・秒で順序保持）へ直し、出来事の日付を 2026-09-09 にする
-- 実行: SQL Editor に貼って Run（鍵は不要・再実行可）

-- 1. 出来事の日付
alter table public.integration_log add column if not exists event_on date;

-- 2. 時刻・記録者・種類のガード（authenticated からの insert にだけ効く。service_role は素通り）
create or replace function public.integration_log_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated' then
    new.at := now();                                                   -- 記録時刻は必ずシステム
    new.actor := coalesce(auth.jwt() ->> 'email', new.actor, 'unknown'); -- 記録者はログイン情報
    new.kind := 'note';                                                -- 人が書けるのは出来事の記録だけ
    if new.event_on is null then new.event_on := (now() at time zone 'Asia/Tokyo')::date; end if;
    if new.event_on > (now() at time zone 'Asia/Tokyo')::date then
      raise exception '出来事の日付に未来の日付は入れられません';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_integration_log_guard on public.integration_log;
create trigger trg_integration_log_guard before insert on public.integration_log
  for each row execute function public.integration_log_guard();

-- 人（authenticated）が更新・削除できる経路は無い（ポリシー無し）。記録は追記のみ

-- 3. 移行済み9行の修正（記録者ラベルで特定・記録日時＝挿入した時刻・出来事の日付＝2026-09-09）
with t as (
  select id, row_number() over (order by at) as rn
  from public.integration_log
  where kind = 'note' and actor = '坂本 匡司（記録移行）'
)
update public.integration_log l
   set at = timestamptz '2026-09-09 04:58:00+00' + (t.rn * interval '1 second'),
       event_on = date '2026-09-09',
       actor = 'm.sakamoto@besterra.co.jp（コードの台帳から移行）'
  from t where l.id = t.id;

-- 【確認】 select at, event_on, actor, left(message, 40) from public.integration_log where kind = 'note' order by at;
