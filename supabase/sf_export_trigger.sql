-- 取引先マスタ配信（ハブ→Salesforce）の即時化＝保存のたびにトリガから sf-export を直接呼ぶ
-- （2026-09-09・坂本さん決定「即時にする。運用開始済みで大量取込は無いので保存のたびに直接叩く」）
--
-- 仕組み:
--   会社マスタ系テーブル（company / company_type / system_code / permit_license / credit_line）の行が変わると、
--   トリガが pg_net で sf-export（mode=direct・company_ids=[その会社]）を非同期に呼ぶ。
--   pg_net は送信をキューに積むだけなので、経理の保存は Salesforce の応答を待たない（関数が落ちていても保存は成功する）。
--   sf-export 側は 3 秒待ってからハブを読み直す（1回の保存で複数行が別トランザクションで書かれても、確定後の状態を送るため）。
--   ＝保存から数秒で Salesforce に反映。失敗の取りこぼしは夜間の全件配信（sf_export_cron.sql）で拾う。
--
-- 実物（キー記入済み）は git外の 自動化\SF連携検証\sf_export_trigger_filled.sql を SQL Editor で実行する（初回のみ・再実行可）。
-- <ANON_KEY> = js/config.js の SUPABASE_ANON_KEY（公開前提の鍵）／<IMPORT_SECRET> = Edge Functions Secrets の IMPORT_SECRET

create extension if not exists pg_net;

-- 1. トリガ関数（変更された行の会社IDで sf-export を呼ぶ）
create or replace function public.notify_sf_export() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cid varchar(8);
  sysname text;
begin
  -- 🔴列の参照はテーブルごとに分けて書く（PL/pgSQL は AND の右側も評価するため、
  --   company の行で old.system を参照すると「record "old" has no field "system"」で保存自体が失敗する＝2026-09-09 実害）
  if tg_op = 'DELETE' then cid := old.company_id; else cid := new.company_id; end if;
  if cid is null then return null; end if;
  -- sf-export 自身の書き戻し（system_code system='salesforce'）で往復しない
  if tg_table_name = 'system_code' then
    if tg_op = 'DELETE' then sysname := old.system; else sysname := new.system; end if;
    if sysname = 'salesforce' then return null; end if;
  end if;
  perform net.http_post(
    url := 'https://pajmsowweswaxowrbiwr.supabase.co/functions/v1/sf-export',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>',
      'x-import-secret', '<IMPORT_SECRET>'
    ),
    body := jsonb_build_object('action', 'export', 'mode', 'direct', 'source', 'trigger',
                               'company_ids', jsonb_build_array(cid), 'reason', tg_table_name || ':' || tg_op),
    timeout_milliseconds := 60000
  );
  return null;
end $$;

-- 2. トリガ（配信に使うテーブルだけ。bank_account 等の SF に送らないテーブルには付けない）
drop trigger if exists trg_sfx_company on public.company;
create trigger trg_sfx_company after insert or update on public.company
  for each row execute function public.notify_sf_export();
drop trigger if exists trg_sfx_company_type on public.company_type;
create trigger trg_sfx_company_type after insert or update or delete on public.company_type
  for each row execute function public.notify_sf_export();
drop trigger if exists trg_sfx_system_code on public.system_code;
create trigger trg_sfx_system_code after insert or update or delete on public.system_code
  for each row execute function public.notify_sf_export();
drop trigger if exists trg_sfx_permit_license on public.permit_license;
create trigger trg_sfx_permit_license after insert or update or delete on public.permit_license
  for each row execute function public.notify_sf_export();
drop trigger if exists trg_sfx_credit_line on public.credit_line;
create trigger trg_sfx_credit_line after insert or update or delete on public.credit_line
  for each row execute function public.notify_sf_export();

-- 【確認】 select tgname, tgrelid::regclass from pg_trigger where tgname like 'trg_sfx_%';
--          select id, status_code, left(content::text, 300) from net._http_response order by id desc limit 5;   -- 直近の呼び出し結果
-- 【監査】 アプリの監査ログ → 対象「取引先マスタ（SF配信）」に SF_EXPORT（自動（保存時・即時））が保存のたびに1行
-- 【止める】 drop trigger trg_sfx_company on public.company; drop trigger trg_sfx_company_type on public.company_type;
--            drop trigger trg_sfx_system_code on public.system_code; drop trigger trg_sfx_permit_license on public.permit_license;
--            drop trigger trg_sfx_credit_line on public.credit_line;
