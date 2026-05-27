-- 準備期間（prep_start）：配属に「準備期間開始日」を持たせる。
--   準備期間 = prep_start 〜 配属開始(join_date)。ガントでは配属バーの左に役割色の斜線で表示。
--
-- assignment_overrides に prep_start 列（text・"YYYY/MM/DD"）を追加するだけ。既存データは影響なし
-- （prep_start が無い行＝準備期間なし）。RLS は既存ポリシー（書込 admin+editor）がそのまま適用される。
--
-- 使い方：Supabase ダッシュボード → SQL Editor に貼り付け → Run。
-- ロールバック：alter table public.assignment_overrides drop column if exists prep_start;

alter table public.assignment_overrides
  add column if not exists prep_start text;
