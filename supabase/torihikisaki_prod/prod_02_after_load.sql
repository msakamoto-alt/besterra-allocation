-- =====================================================================
-- 取引先マスタ 本番昇格 ③データ投入後のシーケンス調整
-- =====================================================================
-- promote_to_prod.py は学習用のID値（account_id等）をそのまま入れる。
-- BIGSERIALのシーケンスが追いつかないと、次のINSERTで主キー重複が起きるため、
-- 🔴データ投入が終わったあとに必ずこのファイルを SQL Editor で実行すること。
-- =====================================================================

SELECT setval(pg_get_serial_sequence('bank_account', 'account_id'), COALESCE((SELECT MAX(account_id) FROM bank_account), 1));
SELECT setval(pg_get_serial_sequence('payment_term', 'term_id'), COALESCE((SELECT MAX(term_id) FROM payment_term), 1));
SELECT setval(pg_get_serial_sequence('permit_license', 'permit_id'), COALESCE((SELECT MAX(permit_id) FROM permit_license), 1));
SELECT setval(pg_get_serial_sequence('compliance_check', 'check_id'), COALESCE((SELECT MAX(check_id) FROM compliance_check), 1));
SELECT setval(pg_get_serial_sequence('compliance_survey', 'survey_id'), COALESCE((SELECT MAX(survey_id) FROM compliance_survey), 1));
SELECT setval(pg_get_serial_sequence('credit_line', 'credit_id'), COALESCE((SELECT MAX(credit_id) FROM credit_line), 1));
SELECT setval(pg_get_serial_sequence('document', 'document_id'), COALESCE((SELECT MAX(document_id) FROM document), 1));
SELECT setval(pg_get_serial_sequence('company_history', 'history_id'), COALESCE((SELECT MAX(history_id) FROM company_history), 1));
