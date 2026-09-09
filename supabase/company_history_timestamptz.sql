-- 【提案・未実施】取引先マスタ 変更履歴 changed_at をタイムゾーン付き（timestamptz）へ
--
-- 背景: 2026-09-08 に一括処理が JST の時刻を「タイムゾーン無し」の changed_at に入れ、画面が +9h して9時間未来になった。
--       列がタイムゾーン無しだと「何時基準の値か」を書く側の約束に頼ることになり、同じ事故が再発しうる。
--       timestamptz なら、書く側が JST（+09:00）で送っても UTC で送っても DB が正しく解釈し、画面は一律 JST 表示になる。
-- 実施の前提: 既存データは UTC として入っている（9/8 に −9h 補正済み）ため `at time zone 'utc'` で変換する。
--             画面（torihikisaki.js）の書込は ISO（Z 付き）なので変更不要。一括スクリプトも UTC naive を送っており互換。
-- 実行: 経理の正本の型変更なので、坂本さん判断のうえ SQL Editor で実行（数秒・行数 6,000 程度）。実行前に backup_prod.py で退避

alter table public.company_history
  alter column changed_at type timestamptz using changed_at at time zone 'utc';

-- 同型の列があれば同じ扱いにする候補（要確認）: company.created_at / updated_at, bank_account.created_at / updated_at / approved_at
-- alter table public.company alter column created_at type timestamptz using created_at at time zone 'utc';
-- alter table public.company alter column updated_at type timestamptz using updated_at at time zone 'utc';

-- 【確認】 select changed_at from public.company_history order by changed_at desc limit 3;   -- +00 付きで返る
