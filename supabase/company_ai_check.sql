-- company_ai_check.sql（2026-11-02）: 取引先の「AIの点検」の記録＝［AIで点検］を押したときに Claude が点検した結果を会社ごとに残す
-- なぜ: 坂本さん 11/02「AIチェックは AI が本当に稼働しているのか」→ 今の「AIチェック」は決まった 3 つの規則だけだった。
--       規則の分は画面で「入力チェック」に改め、その下に Claude の点検（社名の揺れ・住所の食い違い・重複しそうな会社・種別と中身の矛盾）を足す。
--       鍵は坂本さんの Claude API（個人の org）＝本番の会社でも動かす。動かすのは手動（［AIで点検］・11/02 坂本さん）。
--       AI は値を書き換えない。直す値が決まる指摘は［案を入れる］で未保存の変更に入れ、経理が「💾 保存」で確定する。
-- 書くのは関数 torihikisaki-aicheck だけ（service role）。画面は読むだけ＝insert/update のポリシーは作らない。
-- 時刻は DB が付ける（requested_at＝行を作った時刻・finished_at＝状態が running から変わった時刻）。
-- 使い方: SQL Editor で実行（本番ハブ）。何度流しても同じ。
-- 戻し方: ファイルの末尾。

create table if not exists public.company_ai_check (
  id             bigserial primary key,
  company_id     varchar(8) not null references public.company(company_id) on delete cascade,
  requested_at   timestamptz not null default now(),
  finished_at    timestamptz,
  status         varchar(10) not null default 'running' check (status in ('running', 'done', 'error')),
  trigger        varchar(10) not null default 'manual' check (trigger in ('manual', 'retry')),
  requested_by   varchar(80),                -- 押した人（ログインのメール）
  company_updated_at timestamp,              -- 点検した時点の company.updated_at（あとで「保存した時点の点検か」を見分ける）
  model          varchar(40),
  findings       jsonb,                      -- [{level:'warn'|'err', field, why, fix, path?, value?}]（指摘なしは []）
  input_tokens   integer,
  output_tokens  integer,
  error          varchar(300)
);
comment on table public.company_ai_check is '取引先の AIの点検（Claude）の記録。［AIで点検］で関数 torihikisaki-aicheck が書く（2026-11-02）';
comment on column public.company_ai_check.findings is '指摘の配列 [{level, field, why, fix, path?, value?}]。path・value は［案を入れる］の案＝確定は経理の保存';
create index if not exists ix_company_ai_check_company on public.company_ai_check (company_id, requested_at desc);

-- 終わった時刻は DB が付ける
create or replace function public.company_ai_check_finish() returns trigger language plpgsql as $$
begin
  if old.status = 'running' and new.status <> 'running' then
    new.finished_at := now();
  end if;
  new.requested_at := old.requested_at;   -- 作った時刻は書き換えさせない
  return new;
end $$;
drop trigger if exists trg_company_ai_check_finish on public.company_ai_check;
create trigger trg_company_ai_check_finish before update on public.company_ai_check
  for each row execute function public.company_ai_check_finish();

alter table public.company_ai_check enable row level security;
drop policy if exists tm_sel_company_ai_check on public.company_ai_check;
create policy tm_sel_company_ai_check on public.company_ai_check for select to authenticated using (app_role() in ('admin', 'accounting'));
revoke all on public.company_ai_check from anon;
grant select on public.company_ai_check to authenticated;

-- 確かめ（0 行・RLS が true）
select count(*) as rows from public.company_ai_check;
select relrowsecurity from pg_class where oid = 'public.company_ai_check'::regclass;

-- 戻し方:
-- drop table if exists public.company_ai_check;
-- drop function if exists public.company_ai_check_finish();
