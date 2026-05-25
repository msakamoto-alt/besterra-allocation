-- 段階A 限定：RLS を一旦オフにする
--   理由：CREATE TABLE 後、テーブルに RLS が有効化されていた（Supabaseの安全寄りの既定）。
--   RLS 有効＋ポリシー無しだと anon キーでの読み書きが全てブロックされ、段階Aの
--   データ投入・画面表示検証ができない。
--   段階B（認証導入時）に enable + viewer/editor ポリシーで正しく有効化し直す。
alter table public.employees                disable row level security;
alter table public.salesforce_imports       disable row level security;
alter table public.prospects                disable row level security;
alter table public.assignment_overrides     disable row level security;
alter table public.g_work_logs              disable row level security;
alter table public.project_status_overrides disable row level security;
