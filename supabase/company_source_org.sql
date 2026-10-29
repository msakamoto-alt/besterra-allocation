-- company_source_org.sql（2026-10-29）: 会社に「作った org（出どころ）」を持たせ、試験の会社はその org にだけ配る
-- なぜ: sf-export は試験の会社（is_test）を本番以外の送り先すべてに配っていた＝dev6 で作った試験の会社が dev7 にも届く（逆も）。
--       坂本さん 2026-10-29「私が混乱しそうなので実装しておきましょう」。
-- 使い方: SQL Editor で実行（本番ハブ。学習用 DB でも画面を試すなら同じ SQL を）。そのあと sf-intake 2026-10-29.1 と sf-export 2026-10-29.1 を貼る。
-- 中身: 列 2 つ（org の 15 桁と呼び名）。sf-intake が箱を作るときに入れる。sf-export は is_test の会社を source_org_id の org にだけ配る
--       （source_org_id が空の試験の会社は従来どおり本番以外の全部へ）。本物の会社（is_test=false）の配信は変えない。

alter table company add column if not exists source_org_id varchar(15);
alter table company add column if not exists source_org_label varchar(40);
comment on column company.source_org_id is '箱を送ってきた Salesforce の org（15 桁）。sf-intake が入れる。試験の会社（is_test）は sf-export がこの org にだけ配る（2026-10-29）';
comment on column company.source_org_label is '出どころの org の呼び名（Secret SF_EXPORT_TARGETS の name＝dev6・dev7。無ければ org の 15 桁）。画面の「テスト」の印に添える';

-- 今ある試験の会社（2026-10-29 読取: 17 件・全部 dev6 の sf-intake 由来）＝dev6 を入れる。
-- parent_code_03_delete_test.sql で先に消していれば 0 件で、それでよい。
update company set source_org_id = '00Dfd000002CDWc', source_org_label = 'dev6'
 where is_test and source_org_id is null and data_source = 'salesforce_test';

select is_test, source_org_label, count(*) from company group by 1, 2 order by 1, 2;
