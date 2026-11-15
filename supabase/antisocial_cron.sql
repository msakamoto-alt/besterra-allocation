-- 反社チェック（RoboRobo）の定時実行（pg_cron + pg_net）— 雛形・2026-11-15
-- 実物（キー記入済み）は git の外（自動化\API連携\RoboRobo_道具\antisocial_cron_filled.sql）に作り、
-- Supabase SQL Editor に貼り付けて実行する（同名ジョブは上書き）。
-- <ANON_KEY>      = js/config.js の SUPABASE_ANON_KEY（公開前提の鍵）
-- <IMPORT_SECRET> = Edge Functions Secrets の IMPORT_SECRET（sf-import・sf-export と共通）
--
-- 10 分おきに antisocial-check の tick を呼ぶ＝決まりに沿って頼む（設定 enabled のときだけ）→ 依頼待ちを送る
--   → 届かない結果を取りに行く → 取引判断を取り込む。何も無い回は RoboRobo を呼ばない（判断の取り込みは判断待ちがあるときと毎時 1 回だけ）。

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'antisocial-check-tick',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://pajmsowweswaxowrbiwr.supabase.co/functions/v1/antisocial-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>',
      'x-import-secret', '<IMPORT_SECRET>'
    ),
    body := '{"action":"tick","source":"cron"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- 【確認】 select jobid, jobname, schedule, active from cron.job where jobname = 'antisocial-check-tick';
-- 【履歴】 select * from cron.job_run_details where jobname = 'antisocial-check-tick' order by start_time desc limit 5;
--          select id, status_code, left(content::text, 300) from net._http_response order by id desc limit 5;
-- 【止める】 select cron.unschedule('antisocial-check-tick');
