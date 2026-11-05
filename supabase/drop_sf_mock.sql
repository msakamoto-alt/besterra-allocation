-- drop_sf_mock.sql（2026-11-05）: SF モックアップの撤去に伴い、コメントの表と素材の権限を本番ハブから消す（坂本さん 11/05）
-- 流す先: 本番ハブだけ（学習用 DB には作っていない）。何度流しても同じ
-- 🔴 取り消せません。sf_mock_comments のコメントが消えます。残すものは、流す前に CSV に落としてください
-- 素材のバケット sfmock は SQL では消しません。先に Storage の画面で空にして消してください（最後の 1 行で確かめます）
-- 作ったときの SQL＝supabase/add_sf_mock_comments.sql（履歴として残す）

drop policy if exists sfmock_read   on storage.objects;
drop policy if exists sfmock_insert on storage.objects;
drop policy if exists sfmock_update on storage.objects;
drop policy if exists sfmock_delete on storage.objects;

drop table if exists public.sf_mock_comments;       -- トリガ・ポリシー・索引も一緒に消え、Realtime の配信対象からも外れる
drop function if exists public.sf_mock_guard_update();

-- 確かめ（SQL Editor は最後の結果だけを出す）
select (to_regproc('public.app_role') is not null) as prod_form,                                                        -- true＝本番ハブに流れた
       (to_regclass('public.sf_mock_comments') is not null) as table_left,                                              -- false
       (to_regproc('public.sf_mock_guard_update') is not null) as function_left,                                        -- false
       (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'sfmock%') as policies_left,  -- 0
       (select count(*) from storage.buckets where id = 'sfmock') as bucket_left,                                       -- 0
       (select count(*) from storage.objects where bucket_id = 'sfmock') as objects_left;                               -- 0
