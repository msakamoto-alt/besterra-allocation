-- 連携ログに「送信内容」を残す列（2026-09-09・坂本さん「何を送ったのかが見て分からない」）
-- payload = { items: [{ company_id, name, action: 'create'|'update', fields: [{ f, l, old, new }] }], total_changed, truncated }
--   f=API名／l=表示ラベル／old=送信前の Salesforce の値／new=送った値。変わった項目だけを残す（変更なしの配信は items が空）
--   1実行あたり最大200社まで保存（夜間全件の初回など多い場合は truncated=true）
alter table public.integration_log add column if not exists payload jsonb;
-- 【確認】 select at, counts->>'sent' as sent, jsonb_array_length(coalesce(payload->'items','[]')) as changed from public.integration_log where kind='run' order by at desc limit 5;
