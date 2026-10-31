-- credit_test_cleanup.sql（2026-10-31）: 試験の与信・試験の稟議の知らせの片付け＝管理者の手順（画面には置かない・坂本さん 10/31）
-- いつ: UAT の終わり、sandbox（dev6・dev7）を作り直したとき、試験の行を消したいとき。
-- 使い方: SQL Editor で、org_id を書き換えてから、1 の SELECT で消える行を確かめ、2 を流す。
--   dev6＝'00Dfd000002CDWc'／dev7＝'00Dff0000014yuf'（本番の org の行は消さない＝本物の与信は credit_line にあり、ここでは触らない）
-- 消すと: 試験の与信の行ごとに即時配信が動き（trg_sfx_credit_line_test）、その sandbox の取引先の与信は本物の値（多くは空）に戻る。
--         行が多いと配信が 1 行ずつ走る＝数十件なら数分。終わったら連携ログで失敗が無いかを見る。

-- 1. 確かめ
select 'credit_line_test' as t, org_label, count(*) from public.credit_line_test where org_id = '00Dff0000014yuf' group by org_label
union all
select 'credit_notice', org_label, count(*) from public.credit_notice where org_id = '00Dff0000014yuf' and is_prod = false group by org_label;

-- 2. 消す（試験の与信 → 試験の稟議の知らせ。知らせの状態の履歴は一緒に消える）
-- delete from public.credit_line_test where org_id = '00Dff0000014yuf';
-- delete from public.credit_notice where org_id = '00Dff0000014yuf' and is_prod = false;

-- 3. 1 社だけ消すとき
-- delete from public.credit_line_test where org_id = '00Dff0000014yuf' and company_id = '10487';
