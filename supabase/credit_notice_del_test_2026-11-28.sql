-- credit_notice_del_test_2026-11-28.sql（2026-11-28・一回きり）: dev6・dev7 の試験の稟議の知らせ 6 件を消す（坂本さん 11/28「案 1ですすめましょう」）
-- なぜ: 試験の稟議（与信 5・取引開始 1）の知らせが開いたまま残り、経理の普段の画面の「与信の稟議」の数と、本物の 4 社（会社番号 11456・11771・11837・12379）を
--       開いたときの窓に出ていた。あわせて画面は「試験の知らせは『テストのみ』のときだけ出す」に直した（js/views/torihikisaki.js・同じ日）。
-- 消すのは知らせ（credit_notice）の 6 行だけ。状態の履歴（credit_notice_event）は on delete cascade で一緒に消える。
--   会社（company）と本物の与信（credit_line）には触らない。SF へは何も送らない（credit_notice に配る仕組みは無い・
--   試験の与信 credit_line_test はこの 6 行とつながっていない＝配り直しも動かない）。
--   SF 側の承認待ち 4 件（dev6 YS-00015・YS-00044／dev7 YS-00000・YS-00003）は触らない＝承認・差し戻し・取り下げがあれば知らせは届き直す。
-- 使い方: SQL Editor で、まず [1] だけを流して 6 行を確かめる（本番でない・開いている・試験の与信のつながり 0・本物の与信の額）→ [2] と [3] を一緒に流す。
--         [2] は 6 行ぴったりのときだけ消す（閉じた行や試験の与信がつながった行が混ざっていたら、何も消さずに止まる）。
-- 試験: supabase/tests/credit_notice_del_test_2026-11-28.test.mjs（PGlite・本物の表の定義で）

-- [1] 確かめ（6 行のはず・is_prod＝false・done_at＝空・test_credit_links＝0・本物の 4 社は real_limit に額）
select n.id, n.org_label, n.kind, n.application_no, n.company_id, n.stage, n.is_prod, n.done_at,
       cl.limit_amount as real_limit, cl.limit_type as real_type, cl.valid_until as real_until,
       (select count(*) from public.credit_line c where c.company_id = n.company_id) as real_credit_rows,
       (select count(*) from public.credit_line_test t where t.notice_id = n.id) as test_credit_links
  from public.credit_notice n
  left join lateral (select c.limit_amount, c.limit_type, c.valid_until
                       from public.credit_line c
                      where c.company_id = n.company_id
                      order by c.credit_id desc
                      limit 1) cl on true
 where n.id in (6, 9, 13, 16, 18, 19)
 order by n.id;

-- [2] 消す（6 行ぴったりのときだけ・違えば何も消さずに止まる）
do $$
declare n integer;
begin
  delete from public.credit_notice c
   where c.id in (6, 9, 13, 16, 18, 19)
     and c.is_prod = false
     and c.done_at is null
     and (c.org_id, c.application_no) in (('00Dfd000002CDWc', 'YS-00034'), ('00Dfd000002CDWc', 'YS-00015'),
                                          ('00Dfd000002CDWc', 'YS-00040'), ('00Dff0000014yuf', 'YS-00000'),
                                          ('00Dfd000002CDWc', 'YS-00044'), ('00Dff0000014yuf', 'YS-00003'))
     and not exists (select 1 from public.credit_line_test t where t.notice_id = c.id);
  get diagnostics n = row_count;
  if n <> 6 then
    raise exception '消す知らせは 6 行のはずが % 行でした。何も消していません（[1] を流し直して確かめてください）', n;
  end if;
end $$;

-- [3] 確かめ（deleted_left＝0・events_left＝0・real_credit_rows＝4・real_limits は消す前と同じ・open_notices_now＝今開いている知らせの数）
select (select count(*) from public.credit_notice where id in (6, 9, 13, 16, 18, 19)) as deleted_left,
       (select count(*) from public.credit_notice_event where notice_id in (6, 9, 13, 16, 18, 19)) as events_left,
       (select count(*) from public.credit_line where company_id in ('11456', '11771', '11837', '12379')) as real_credit_rows,
       (select string_agg(company_id || ':' || limit_amount, ' ' order by company_id)
          from public.credit_line where company_id in ('11456', '11771', '11837', '12379')) as real_limits,
       (select count(*) from public.credit_notice where done_at is null) as open_notices_now;
