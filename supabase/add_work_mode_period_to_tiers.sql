-- 稼働形態（派遣・専従）の色帯表示期間を持たせるための列追加
--
-- employee_tiers に work_mode_start / work_mode_end（YYYY/MM/DD のテキスト）を追加。
-- 空＝従来どおり全期間に色帯。期間を入れるとガントでその期間だけ色帯を表示。
-- 配置可否・空き計算には影響しない（色帯の表示範囲のみ）。
-- 使い方：Supabase SQL Editor に貼り付け → Run（admin で）。冪等。

alter table public.employee_tiers add column if not exists work_mode_start text;
alter table public.employee_tiers add column if not exists work_mode_end text;
