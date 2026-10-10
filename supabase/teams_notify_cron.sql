-- SF の承認待ち・回覧 → Teams 通知（sf-teams-notify）の定期実行（pg_cron + pg_net）— 雛形・2026-10-10
-- 実物（キー記入済み）は git の外（自動化\SF連携検証\teams_notify_cron_filled.sql など）に作り、
-- Supabase SQL Editor に貼り付けて実行する（同名ジョブは上書き）。
-- <ANON_KEY>      = js/config.js の SUPABASE_ANON_KEY（公開前提の鍵）
-- <IMPORT_SECRET> = Edge Functions Secrets の IMPORT_SECRET（sf-import・sf-export と共通）
--
-- 5 分おき。1 回あたり SF の API 4〜8 コール（トークン・組織・承認待ち・判定金額・回覧）。

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sf-teams-notify',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://pajmsowweswaxowrbiwr.supabase.co/functions/v1/sf-teams-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>',
      'x-import-secret', '<IMPORT_SECRET>'
    ),
    body := '{"action":"send","source":"cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- 【確認】 select jobid, jobname, schedule, active from cron.job;
-- 【履歴】 select * from cron.job_run_details where jobname = 'sf-teams-notify' order by start_time desc limit 5;
--          select id, status_code, left(content::text, 300) from net._http_response order by id desc limit 5;
-- 【送信記録】 select status, count(*) from teams_notify_log group by status;
-- 【止める】 select cron.unschedule('sf-teams-notify');
