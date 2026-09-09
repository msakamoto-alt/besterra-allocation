-- 取引先マスタ配信（ハブ→Salesforce）の夜間スケジュール（pg_cron + pg_net）— 雛形
-- 実物（キー記入済み）は git外の 自動化\SF連携検証\sf_export_cron_filled.sql を
-- Supabase SQL Editor に貼り付けて実行する（初回のみ・同名ジョブは上書き）。
-- <ANON_KEY> = js/config.js の SUPABASE_ANON_KEY（公開前提の鍵）
-- <IMPORT_SECRET> = Edge Functions Secrets の IMPORT_SECRET（sf-import と共通）
--
-- 設計: 毎晩1回、有効な会社を全件 upsert する（冪等なので差分管理は不要・約13 APIコール・約25秒）。
--       接続先は Edge Function の Secrets（SF_EXPORT_INSTANCE_URL / SF_EXPORT_ALLOWED_ORG_IDS）で決まる。
--       即時に流したいときは sf_export_call.py export（またはハブ画面のボタン・未実装）。

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 毎朝5:30(JST)= 20:30 UTC。sf-import（6:00 JST）とは独立（対象テーブルが違う）
select cron.schedule(
  'sf-export-daily',
  '30 20 * * *',
  $$
  select net.http_post(
    url := 'https://pajmsowweswaxowrbiwr.supabase.co/functions/v1/sf-export',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>',
      'x-import-secret', '<IMPORT_SECRET>'
    ),
    body := '{"action":"export","source":"cron","scope":"active"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- 【確認】 select jobid, jobname, schedule, active from cron.job;
-- 【履歴】 select * from cron.job_run_details order by start_time desc limit 5;
--          select id, status_code, left(content::text, 300) from net._http_response order by id desc limit 5;
-- 【監査】 アプリの監査ログ → 対象「取引先マスタ（SF配信）」に SF_EXPORT が1晩1行
-- 【解除】 select cron.unschedule('sf-export-daily');
