-- 段階D6（旧 employees テーブルの物理削除）
--
-- 経緯：段階D5（phaseD5_schema.sql）で社員の正を organization+employee_tiers に、
--       資格の正を employee_quals に移行し、旧 employees テーブルは機能的に切離し済み。
--       本番安定を確認したため物理削除する。
--
-- 前提（削除前に必ず確認）：
--   - アプリのコードが employees テーブルを fetch しないこと
--     （js/sync.js fetchRawFromSupabase から削除済み・コミット参照）。
--   - GitHub Pages 本番に上記コードが反映済みであること。
--   - employees を参照する外部キー制約が無いこと（全列 text・FK 無しのため CASCADE 不要）。
--
-- 復元方法：万一戻す場合は schema.sql の employees CREATE 文を再実行し、
--           supabase/load_data.py で再投入（要 service_role キー）。
--
-- 使い方：Supabase ダッシュボード → SQL Editor に貼り付け → Run。

drop table if exists public.employees;
