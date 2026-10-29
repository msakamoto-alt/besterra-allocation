-- parent_code_04_test_seq.sql（2026-10-29）: 試験の帯（00001〜09999）の番号を使い回さない＝順序（sequence）で振る
-- なぜ: 試験の会社を消すと next_parent_code('test') が「最大＋1」で同じ番号を振り直し、
--       dev6 の取引先（HubCompanyId__c＝消した番号）に別の会社の配信が上書きで当たる（dev7 を足すときの掃除で起きる）。
-- 使い方: SQL Editor で実行（parent_code_03_delete_test.sql の前でも後でもよい）。
--        起点は「今ある試験の会社の最大」と「dev6 で使った最大（00017）」の大きい方＝消したあとも 00018 から続く。
-- 本物の帯（10001〜・parent_code_seq）は触らない。

begin;

create sequence if not exists parent_code_test_seq;
select setval('parent_code_test_seq',
              greatest((select coalesce(max(company_id::int), 0) from company where company_id between '00001' and '09999'), 17));

create or replace function next_parent_code(p_band text) returns text
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_band = 'real' then
    n := nextval('parent_code_seq');
    if n > 99999 then raise exception '取引先番号の帯（10001〜99999）を使い切りました'; end if;
    return lpad(n::text, 5, '0');
  elsif p_band = 'test' then
    n := nextval('parent_code_test_seq');
    if n > 9999 then raise exception '試験の帯（00001〜09999）を使い切りました。試験の会社を消してから setval(''parent_code_test_seq'', 0) で戻してください'; end if;
    return lpad(n::text, 5, '0');
  else
    raise exception '帯は real か test です: %', p_band;
  end if;
end $$;
revoke all on function next_parent_code(text) from public;
grant execute on function next_parent_code(text) to authenticated, service_role;

commit;

-- 確かめ: 次に振られる試験の番号（nextval は進むので、見るだけなら currval ではなく last_value）
select last_value as test_last, is_called from parent_code_test_seq;
