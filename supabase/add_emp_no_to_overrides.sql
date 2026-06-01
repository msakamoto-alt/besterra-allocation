-- assignment_overrides に社員番号(emp_no)列を追加する。
-- 目的：配置(op=add)の社員紐付けを「氏名の文字列一致」から「社員番号という安定キー」へ移行し、
--       異体字（髙/高 等）や名簿の氏名変更で emp_id 解決が切れる不具合を恒久的に防ぐ。
--
-- 既存行は emp_no が NULL のまま → 読取時は氏名の正規化照合(normEmpKey)にフォールバックする
-- （後方互換。再保存・移行は不要）。新規追加分から emp_no が入り、以後は氏名に依存しない。
--
-- RLS は assignment_overrides の既存ポリシーがそのまま適用される（列追加で変化なし）。
-- 実行先：Supabase SQL Editor
--   https://supabase.com/dashboard/project/pajmsowweswaxowrbiwr/sql/new

ALTER TABLE public.assignment_overrides
  ADD COLUMN IF NOT EXISTS emp_no text;
