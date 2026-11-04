-- credit_group_wording_tantai.sql（2026-11-04）: DB のエラー文と列の説明の表記を「自分で与信」から「単体で与信」に（坂本さん 11/04）
-- 変えるのは関数 company_group_guard の文言と、列 credit_holder_id の説明だけ。決まりの動きとデータは変えない。credit_group.sql 本体も同じ文言に直してある
-- 流す順: 学習用 → 本番ハブ（何度流しても同じ）。流す前の確かめ＝supabase/tests/credit_group.test.mjs（本体の関数と同じことも確かめる）

comment on column public.company.credit_holder_id is '与信先。この会社の与信を、どの会社の限度額でまかなうか（同じグループの上の会社・単体で与信を取っている会社に限る）。空＝単体の与信。規程 KG-10 第20条の一括手続先';

create or replace function public.company_group_guard() returns trigger
language plpgsql as $$
declare
  cur varchar(8);
  hops int;
  holder_found boolean := false;  -- found は plpgsql の予約の変数なので使わない
  holder_holder varchar(8);
  n_members int;
begin
  if new.parent_company_id is not null and new.parent_company_id = new.company_id then
    raise exception '親会社に自分自身（%）は指定できません', new.company_id;
  end if;
  -- 輪の検査: 新しい親から上へたどって自分に戻らない
  cur := new.parent_company_id; hops := 0;
  while cur is not null loop
    if cur = new.company_id then
      raise exception '親会社の指定が輪になります（% の上に % が既にあります）', new.parent_company_id, new.company_id;
    end if;
    hops := hops + 1;
    if hops > 50 then raise exception '親会社の階層が深すぎます（50 段超）'; end if;
    select parent_company_id into cur from public.company where company_id = cur;
  end loop;
  if new.credit_holder_id is not null then
    if new.credit_holder_id = new.company_id then raise exception '与信先に自分自身は指定できません'; end if;
    if new.credit_exempt then raise exception '与信不要先にはグループの与信（与信先）を付けられません。与信の取り方は 1 つにしてください'; end if;
    -- 与信先は親をたどった先にある
    cur := new.parent_company_id; hops := 0;
    while cur is not null loop
      if cur = new.credit_holder_id then holder_found := true; exit; end if;
      hops := hops + 1; exit when hops > 50;
      select parent_company_id into cur from public.company where company_id = cur;
    end loop;
    if not holder_found then
      raise exception '与信先（%）は、この会社（%）の親会社をたどった先にありません。先に親会社を入れるか、親を変えるなら先にグループの与信を外してください', new.credit_holder_id, new.company_id;
    end if;
    -- 与信先は単体で与信を取っている会社（2 段で借りない）
    select credit_holder_id into holder_holder from public.company where company_id = new.credit_holder_id;
    if holder_holder is not null then
      raise exception '与信先（%）自身がグループの与信（与信先 %）です。与信先は単体で与信を取っている会社にしてください', new.credit_holder_id, holder_holder;
    end if;
    -- 自分が誰かの与信先なら、グループの与信にはなれない
    select count(*) into n_members from public.company where credit_holder_id = new.company_id and company_id <> new.company_id;
    if n_members > 0 then
      raise exception 'この会社（%）は % 社の与信先です。先にその会社の与信先を変えてください', new.company_id, n_members;
    end if;
  end if;
  return new;
end $$;

-- 確かめ（SQL Editor は最後の結果だけを出す）
select (to_regproc('public.app_role') is not null) as prod_form,                                                   -- 本番ハブ true／学習用 false
       (select prosrc like '%単体で与信%' and prosrc not like '%自分で与信%'
          from pg_proc where oid = 'public.company_group_guard'::regproc) as new_wording;                          -- true
