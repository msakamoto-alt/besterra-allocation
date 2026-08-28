-- =====================================================================
-- 取引先マスタ 本番昇格 ①スキーマ＋RLS（2026-08-26作成）
-- =====================================================================
-- 生成元: 学習用DDL（schema_learning_260825.sql＝塩田さん02_schemaと構造同一）から機械生成。
-- 変更点: DROP除去・IF NOT EXISTS化・RLSポリシー追加。テーブル構造は一切変えていない。
--
-- 実行: 本番Supabase（besterra-allocation本体と同じプロジェクト）の SQL Editor に
--       全文を貼り付けて Run（エディタは空にしてから貼ること）。
--
-- 🔴RLS設計（2026-08-26 坂本さん決定に基づく）
--   ・閲覧・書込とも admin ＋ accounting のみ（取引先マスタは経理管轄。口座・与信の機微情報を含む）
--   ・anon は一切読めない（画面はログイン必須のまま）
--   ・company_history（変更履歴）だけ特別扱い:
--       - UPDATE は承認記入（approved_by）のための経路として admin/accounting に許可
--       - DELETE は admin のみ（履歴は原則消さない。誤記録の整理は管理者に限定）
--   ・🔴既存の監査トリガー（audit_logs / log_audit()）は取引先18テーブルには掛けない
--     （履歴は company_history が正・混ぜない＝2026-08-26 坂本さん決定）
--   ・app_role() は既存（phaseE1a_roles.sql）を使う。このファイルでは作らない
-- =====================================================================

CREATE TABLE IF NOT EXISTS company (
  company_id VARCHAR(8) PRIMARY KEY,
  official_name VARCHAR(200) NOT NULL,
  name_kana VARCHAR(200),
  name_kana_half VARCHAR(200),
  name_half VARCHAR(200),
  corporate_number CHAR(13),
  representative_name VARCHAR(100),
  search_name_normalized VARCHAR(200),
  search_rep_normalized VARCHAR(100),
  established_on DATE,
  established_precision VARCHAR(10),
  capital_amount BIGINT,
  listing_class VARCHAR(20),
  listing_market VARCHAR(40),
  entity_class VARCHAR(20),
  domestic_class VARCHAR(20),
  parent_company_id VARCHAR(8) REFERENCES company(company_id),
  sansan_soc VARCHAR(40),
  industry_code VARCHAR(20),
  business_summary TEXT,
  employee_count INTEGER,
  annual_revenue BIGINT,
  fiscal_month SMALLINT CHECK (fiscal_month BETWEEN 1 AND 12),
  postal_code CHAR(7),
  prefecture VARCHAR(20),
  address_line VARCHAR(200),
  building VARCHAR(100),
  registered_address VARCHAR(300),
  phone VARCHAR(20),
  fax VARCHAR(20),
  website_url VARCHAR(255),
  invoice_reg_number CHAR(14),
  invoice_status VARCHAR(20),
  tax_status VARCHAR(20),
  antisocial_clause_status VARCHAR(30),
  antisocial_cleared BOOLEAN NOT NULL DEFAULT FALSE,
  credit_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  trade_status VARCHAR(20),
  major_class VARCHAR(20),
  construction_class VARCHAR(20),
  is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  suspend_reason VARCHAR(200),
  suspend_merged_into VARCHAR(8),
  trade_end_on DATE,
  last_trade_on DATE,
  registration_stage VARCHAR(10) NOT NULL DEFAULT 'temp',
  data_source VARCHAR(20),
  remarks TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  created_by VARCHAR(40),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_by VARCHAR(40)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_company_corpnum ON company(corporate_number) WHERE corporate_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_company_name ON company(official_name);
CREATE TABLE IF NOT EXISTS company_type (
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  type_code VARCHAR(20) NOT NULL,
  PRIMARY KEY (company_id, type_code)
);
CREATE TABLE IF NOT EXISTS branch (
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  branch_no SMALLINT NOT NULL,
  branch_name VARCHAR(200),
  postal_code CHAR(7),
  address VARCHAR(300),
  phone VARCHAR(20),
  fax VARCHAR(20),
  PRIMARY KEY (company_id, branch_no)
);
CREATE TABLE IF NOT EXISTS system_code (
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  system VARCHAR(20) NOT NULL,
  code VARCHAR(20) NOT NULL,
  PRIMARY KEY (company_id, system)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_system_code ON system_code(system, code);
CREATE TABLE IF NOT EXISTS bank_account (
  account_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  priority SMALLINT NOT NULL DEFAULT 1,
  bank_name VARCHAR(100),
  bank_code CHAR(4),
  branch_code VARCHAR(4),
  account_type VARCHAR(10),
  account_number VARCHAR(20),
  account_holder_kana VARCHAR(100),
  is_factoring BOOLEAN DEFAULT FALSE,
  payment_method VARCHAR(20) NOT NULL DEFAULT '振込',
  approved_by VARCHAR(40),
  approved_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_term (
  term_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  priority SMALLINT NOT NULL DEFAULT 1,
  order_class VARCHAR(20),
  term_code VARCHAR(40),
  closing_day SMALLINT,
  payment_day SMALLINT,
  site_months SMALLINT
);
CREATE TABLE IF NOT EXISTS company_billing (
  company_id VARCHAR(8) PRIMARY KEY REFERENCES company(company_id),
  closing_day SMALLINT,
  receipt_month_day VARCHAR(20),
  business_day_adjust VARCHAR(20),
  invoice_send_to JSONB,
  invoice_format VARCHAR(100),
  payment_notice_required BOOLEAN,
  designated_invoice VARCHAR(200),
  order_send_to JSONB
);
CREATE TABLE IF NOT EXISTS permit_license (
  permit_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  permit_type VARCHAR(30) NOT NULL,
  construction_types VARCHAR(200),
  permit_authority VARCHAR(40),
  permit_number VARCHAR(40),
  waste_prefecture VARCHAR(20),
  valid_from DATE,
  valid_until DATE,
  document_url VARCHAR(500)
);
CREATE INDEX IF NOT EXISTS ix_permit_expiry ON permit_license(valid_until);
CREATE TABLE IF NOT EXISTS compliance_check (
  check_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  checked_on DATE NOT NULL,
  result VARCHAR(20),
  valid_until DATE,
  checked_by VARCHAR(40),
  method VARCHAR(60),
  evidence_url VARCHAR(500),
  name_at_check VARCHAR(200),
  rep_at_check VARCHAR(100)
);
CREATE TABLE IF NOT EXISTS compliance_survey (
  survey_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  sent_on DATE,
  answered_on DATE,
  has_clause BOOLEAN,
  answers JSONB,
  document_url VARCHAR(500)
);
CREATE TABLE IF NOT EXISTS credit_line (
  credit_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  limit_amount BIGINT,
  limit_type VARCHAR(20),
  valid_until DATE,
  approved_on DATE,
  decided_by VARCHAR(40),
  use_parent_credit BOOLEAN DEFAULT FALSE,
  agency_score VARCHAR(20),
  used_amount BIGINT,
  document_url VARCHAR(500)
);
CREATE TABLE IF NOT EXISTS company_subcontractor (
  company_id VARCHAR(8) PRIMARY KEY REFERENCES company(company_id),
  specialty_work VARCHAR(200),
  service_areas VARCHAR(200),
  capacity VARCHAR(60),
  rating VARCHAR(20),
  safety_record TEXT,
  qualified_staff TEXT,
  equipment TEXT,
  outsourcing_class VARCHAR(20),
  accounting_contact VARCHAR(200),
  portal_url VARCHAR(255)
);
CREATE TABLE IF NOT EXISTS company_customer (
  company_id VARCHAR(8) PRIMARY KEY REFERENCES company(company_id),
  industry_sector VARCHAR(60)
);
CREATE TABLE IF NOT EXISTS company_scrap (
  company_id VARCHAR(8) PRIMARY KEY REFERENCES company(company_id),
  item_types VARCHAR(200),
  purchase_terms TEXT,
  weighing_terms TEXT,
  permits VARCHAR(200),
  ledger_ref VARCHAR(100),
  valuation_manual_ok BOOLEAN,
  trade_direction VARCHAR(20)
);
CREATE TABLE IF NOT EXISTS document (
  document_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  doc_type VARCHAR(30) NOT NULL,
  file_url VARCHAR(500) NOT NULL,
  valid_until DATE,
  uploaded_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS company_name_history (
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  changed_on DATE NOT NULL,
  old_name VARCHAR(200),
  new_name VARCHAR(200),
  PRIMARY KEY (company_id, changed_on)
);
CREATE TABLE IF NOT EXISTS company_history (
  history_id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(8) NOT NULL REFERENCES company(company_id),
  table_name VARCHAR(40) NOT NULL,
  column_name VARCHAR(40) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by VARCHAR(40) NOT NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT now(),
  approved_by VARCHAR(40)
);
CREATE INDEX IF NOT EXISTS ix_history_company ON company_history(company_id, changed_at DESC);
CREATE TABLE IF NOT EXISTS field_distribution (
  field_no INTEGER NOT NULL,
  system VARCHAR(20) NOT NULL,
  level VARCHAR(10) NOT NULL,
  PRIMARY KEY (field_no, system)
);

-- ===== RLS有効化＋ポリシー（admin/accounting限定） =====
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company','company_type','branch','system_code','bank_account','payment_term','company_billing','permit_license','compliance_check','compliance_survey','credit_line','company_subcontractor','company_customer','company_scrap','document','company_name_history','company_history','field_distribution'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- 冪等: 同名ポリシーがあれば作り直す
    EXECUTE format('DROP POLICY IF EXISTS tm_sel_%s ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS tm_ins_%s ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS tm_upd_%s ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS tm_del_%s ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY tm_sel_%s ON public.%I FOR SELECT TO authenticated USING (app_role() IN (''admin'',''accounting''))', t, t);
    EXECUTE format(
      'CREATE POLICY tm_ins_%s ON public.%I FOR INSERT TO authenticated WITH CHECK (app_role() IN (''admin'',''accounting''))', t, t);
    EXECUTE format(
      'CREATE POLICY tm_upd_%s ON public.%I FOR UPDATE TO authenticated USING (app_role() IN (''admin'',''accounting'')) WITH CHECK (app_role() IN (''admin'',''accounting''))', t, t);
    IF t = 'company_history' THEN
      -- 履歴のDELETEは admin のみ（原則消さない・誤記録の整理は管理者に限定）
      EXECUTE format(
        'CREATE POLICY tm_del_%s ON public.%I FOR DELETE TO authenticated USING (app_role() = ''admin'')', t, t);
    ELSE
      EXECUTE format(
        'CREATE POLICY tm_del_%s ON public.%I FOR DELETE TO authenticated USING (app_role() IN (''admin'',''accounting''))', t, t);
    END IF;
  END LOOP;
END $$;

-- 確認用: RLSが全テーブルで有効になっているか（結果が18行・全てtrueであること）
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND tablename IN ('company','company_type','branch','system_code','bank_account','payment_term','company_billing','permit_license','compliance_check','compliance_survey','credit_line','company_subcontractor','company_customer','company_scrap','document','company_name_history','company_history','field_distribution')
ORDER BY tablename;
