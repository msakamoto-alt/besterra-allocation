-- SF自動取込の毎朝スケジュール（pg_cron + pg_net）— 雛形
-- 実物（キー記入済み）は git外の 自動化\SF連携検証\sf_import_cron_filled.sql を
-- Supabase SQL Editor に貼り付けて実行する（初回のみ）。
-- <ANON_KEY> = js/config.js の SUPABASE_ANON_KEY（公開前提の鍵）
-- <IMPORT_SECRET> = Edge Functions Secrets の IMPORT_SECRET と同じ値

-- 1. 拡張の有効化（既に有効なら何もしない）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2. 毎朝6時(JST)に sf-import を import モードで呼び出す
--    pg_cron はUTC基準のため 21:00 UTC = 翌朝6:00 JST
--    同名ジョブが既にあれば上書き（再実行しても二重登録にならない）
select cron.schedule(
  'sf-import-daily',
  '0 21 * * *',
  $$
  select net.http_post(
    url := 'https://pajmsowweswaxowrbiwr.supabase.co/functions/v1/sf-import',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>',
      'x-import-secret', '<IMPORT_SECRET>'
    ),
    body := '{"action":"import","source":"cron"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- 【確認】登録済みジョブの一覧
-- select jobid, jobname, schedule, active from cron.job;

-- 【確認】実行履歴（翌朝以降）
-- select * from cron.job_run_details order by start_time desc limit 5;
-- select id, status_code, left(content::text, 200) from net._http_response order by id desc limit 5;

-- 【解除したい場合】
-- select cron.unschedule('sf-import-daily');
