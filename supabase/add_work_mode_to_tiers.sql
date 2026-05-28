-- 稼働形態（work_mode）を employee_tiers に追加
-- 監督派遣（送出）/ 事務所専従 / 構内専従 を社員ごとに保持する。
-- tier（監督職/準監督職…）とは独立。空/NULL = 通常（現場配置可）。
-- 監督ダッシュボードのプルダウンから admin/editor が upsert（RLS は既存の employee_tiers ポリシーを踏襲）。
-- 実行は SQL Editor（admin）。冪等。
alter table public.employee_tiers
  add column if not exists work_mode text;

comment on column public.employee_tiers.work_mode is
  '稼働形態: 監督派遣 / 事務所専従 / 構内専従。空=通常（現場配置可）。tierと独立。';
