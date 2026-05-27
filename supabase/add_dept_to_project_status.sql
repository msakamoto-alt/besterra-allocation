-- 案件の修正：工事の「管轄事務所(dept)」を手動上書きできるよう、project_status_overrides に dept 列を追加。
--   この表は project_id 単位の手動上書き（完成/進行中の状態）。ここに dept を足し、
--   状態(completed)と管轄事務所(dept)を1行で持つ。どちらか入っていれば行が存在し、
--   両方クリアするとアプリ側が行を削除する。
--
-- 既存データは影響なし（dept 未設定＝事務所は自動=Salesforce元値）。
-- RLS は既存ポリシー（書込 admin+editor）がそのまま適用される。
--
-- 使い方：Supabase ダッシュボード → SQL Editor に貼り付け → Run。
-- ロールバック：alter table public.project_status_overrides drop column if exists dept;

alter table public.project_status_overrides
  add column if not exists dept text;
