-- credit_notice_del_ys00029.sql（2026-10-31・一回きり）: dev6 の通しで会社を引けなかった知らせ YS-00029 を消す（坂本さんの OK 済み・反映のときに一緒に流す）
-- なぜ: dev6 の【テスト】鑑で与信を出す会社は、取引先番号が古い試験の帯 00004 のまま（ハブの試験の帯は 10/29 に片付け済み）＝知らせが会社を引けなかった。
--       ［入れずに済み］は作らない（10/31 坂本さん）ので、試験の行は管理者が SQL で消す。dev6 の古い試験の取引先 16 社（00001〜00017）の番号は今回は直さない。
-- 使い方: SQL Editor で、まず 1 の SELECT で 1 行（dev6・YS-00029・会社が空）を確かめてから 2 を流す。

-- 1. 確かめ（1 行のはず）
select id, org_label, application_no, kind, company_id, account_name, done_at, received_at
  from public.credit_notice
 where org_id = '00Dfd000002CDWc' and application_no = 'YS-00029';

-- 2. 消す（状態の履歴 credit_notice_event は on delete cascade で一緒に消える）
delete from public.credit_notice
 where org_id = '00Dfd000002CDWc' and application_no = 'YS-00029' and company_id is null;

-- 3. 確かめ（0 行）
select count(*) from public.credit_notice where org_id = '00Dfd000002CDWc' and application_no = 'YS-00029';
