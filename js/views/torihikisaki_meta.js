/**
 * torihikisaki_meta.js - 取引先マスタ 項目メタデータ（機械生成・手編集しない）
 * 生成元: 塩田さん引き渡し一式 2026-08-12（画面モック DATA.fields ＋ 03_項目別_取得元と要件定義）
 * 再生成: Box torihikisaki-hub-test\実装_260825\scripts\gen_meta_js.py（モックHTMLを直接読む）
 * 内容はスキーマ定義のみ（実データなし＝コミット可）。
 */
const TM_META = {
  TYPES: ["得意先（顧客）", "協力会社", "スクラップ業者", "販管費先", "施主"],
  // DBのtype_code ⇔ 画面ラベル
  TYPE_CODES: {customer: '得意先（顧客）', subcontractor: '協力会社', scrap: 'スクラップ業者', sga: '販管費先', owner: '施主'},
  TYPE_BLOCKS: {
  "得意先（顧客）": [
    "与信",
    "請求・入金",
    "顧客情報",
    "入金・支払関連",
    "コンプラ・反社",
    "取引実績・履歴"
  ],
  "協力会社": [
    "協力会社情報",
    "支払関連",
    "入金・支払関連",
    "コンプラ・反社",
    "取引実績・履歴"
  ],
  "販管費先": [
    "支払関連",
    "入金・支払関連"
  ],
  "施主": [
    "顧客情報",
    "請求・入金",
    "与信",
    "コンプラ・反社"
  ],
  "スクラップ業者": [
    "スクラップ業者情報",
    "入金・支払関連",
    "支払関連",
    "コンプラ・反社",
    "取引実績・履歴"
  ]
},
  COMMON_BLOCKS: ["識別・基本", "連絡先・所在地", "インボイス・税務", "種別・状態", "各システムコード", "文書・ファイル", "管理・メタ"],
  BLOCK_ORDER: ["識別・基本", "連絡先・所在地", "インボイス・税務", "コンプラ・反社", "与信", "種別・状態", "各システムコード", "支払関連", "入金・支払関連", "請求・入金", "協力会社情報", "顧客情報", "スクラップ業者情報", "取引実績・履歴", "文書・ファイル", "管理・メタ"],
  FIELDS: [
 {
  "no": 1,
  "block": "識別・基本",
  "name": "会社マスタID",
  "must": "必須",
  "must3": "①常時必須",
  "col": "company.company_id",
  "dtype": "VARCHAR(8)",
  "source": "会社マスタが採番",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 2,
  "block": "識別・基本",
  "name": "正式社名",
  "must": "必須",
  "must3": "①常時必須",
  "col": "company.official_name",
  "dtype": "VARCHAR(200)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 3,
  "block": "識別・基本",
  "name": "社名カナ",
  "must": "推奨",
  "must3": "任意",
  "col": "company.name_kana / name_kana_half / name_half",
  "dtype": "VARCHAR(200) / VARCHAR(200) / VARCHAR(200)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 5,
  "block": "識別・基本",
  "name": "旧社名・社名変更履歴",
  "must": "推奨",
  "must3": "任意",
  "col": "company_name_history.old_name",
  "dtype": "VARCHAR(200)",
  "source": "国税庁API",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 6,
  "block": "識別・基本",
  "name": "法人番号(13桁)",
  "must": "必須",
  "must3": "①常時必須",
  "col": "company.corporate_number",
  "dtype": "CHAR(13)",
  "source": "移行データ（済）＋国税庁 法人番号API",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 7,
  "block": "識別・基本",
  "name": "代表者名",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.representative_name",
  "dtype": "VARCHAR(100)",
  "source": "gBizINFO/Sansan",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 9,
  "block": "識別・基本",
  "name": "設立年月日",
  "must": "推奨",
  "must3": "任意",
  "col": "company.established_on",
  "dtype": "DATE",
  "source": "Sansanデータハブ(条件付)",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 11,
  "block": "識別・基本",
  "name": "資本金",
  "must": "推奨",
  "must3": "任意",
  "col": "company.capital_amount",
  "dtype": "BIGINT",
  "source": "Sansanデータハブ(条件付)",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 12,
  "block": "識別・基本",
  "name": "上場区分",
  "must": "推奨",
  "must3": "任意",
  "col": "company.listing_class",
  "dtype": "VARCHAR(20)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 13,
  "block": "識別・基本",
  "name": "上場市場",
  "must": "推奨",
  "must3": "任意",
  "col": "company.listing_market",
  "dtype": "VARCHAR(40)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 14,
  "block": "識別・基本",
  "name": "法人/個人区分",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.entity_class",
  "dtype": "VARCHAR(20)",
  "source": "国税庁API",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 15,
  "block": "識別・基本",
  "name": "国内/海外区分",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.domestic_class",
  "dtype": "VARCHAR(20)",
  "source": "国税庁API",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 16,
  "block": "識別・基本",
  "name": "親会社・資本関係(親会社参照)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.parent_company_id",
  "dtype": "VARCHAR(8)",
  "source": "Sansanデータハブ(条件付)",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 18,
  "block": "識別・基本",
  "name": "SOC(Sansan Organization Code)",
  "must": "推奨",
  "must3": "任意",
  "col": "company.sansan_soc",
  "dtype": "VARCHAR(40)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 19,
  "block": "識別・基本",
  "name": "業種(大分類/中分類)",
  "must": "推奨",
  "must3": "任意",
  "col": "company.industry_code",
  "dtype": "VARCHAR(20)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 20,
  "block": "識別・基本",
  "name": "事業内容・会社概要",
  "must": "推奨",
  "must3": "任意",
  "col": "company.business_summary",
  "dtype": "TEXT",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 21,
  "block": "識別・基本",
  "name": "従業員数",
  "must": "推奨",
  "must3": "任意",
  "col": "company.employee_count",
  "dtype": "INTEGER",
  "source": "Sansanデータハブ(条件付)",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 22,
  "block": "識別・基本",
  "name": "売上高",
  "must": "推奨",
  "must3": "任意",
  "col": "company.annual_revenue",
  "dtype": "BIGINT",
  "source": "Sansanデータハブ(条件付)",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 23,
  "block": "識別・基本",
  "name": "決算月",
  "must": "推奨",
  "must3": "任意",
  "col": "company.fiscal_month",
  "dtype": "SMALLINT",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 24,
  "block": "連絡先・所在地",
  "name": "本社郵便番号",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.postal_code",
  "dtype": "CHAR(7)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 25,
  "block": "連絡先・所在地",
  "name": "本社住所",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.prefecture / address_line / building",
  "dtype": "VARCHAR(20) / VARCHAR(200) / VARCHAR(100)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 26,
  "block": "連絡先・所在地",
  "name": "本店所在地(登記簿)",
  "must": "推奨",
  "must3": "任意",
  "col": "company.registered_address",
  "dtype": "VARCHAR(300)",
  "source": "国税庁API",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 27,
  "block": "連絡先・所在地",
  "name": "支店・拠点(複数)",
  "must": "推奨",
  "must3": "任意",
  "col": "branch.*",
  "dtype": "-",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 28,
  "block": "連絡先・所在地",
  "name": "電話番号",
  "must": "推奨",
  "must3": "任意",
  "col": "company.phone",
  "dtype": "VARCHAR(20)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 29,
  "block": "連絡先・所在地",
  "name": "FAX番号",
  "must": "推奨",
  "must3": "任意",
  "col": "company.fax",
  "dtype": "VARCHAR(20)",
  "source": "Sansanデータハブ(条件付)",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 31,
  "block": "連絡先・所在地",
  "name": "URL(HP)",
  "must": "推奨",
  "must3": "任意",
  "col": "company.website_url",
  "dtype": "VARCHAR(255)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 33,
  "block": "インボイス・税務",
  "name": "適格請求書発行事業者 登録番号(T番号)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.invoice_reg_number",
  "dtype": "CHAR(14)",
  "source": "移行データ（済）＋国税庁インボイスAPI",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 34,
  "block": "インボイス・税務",
  "name": "適格請求書 該当/非該当",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.invoice_status",
  "dtype": "VARCHAR(20)",
  "source": "国税庁インボイスAPIで自動判定",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 35,
  "block": "インボイス・税務",
  "name": "課税/免税事業者区分",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.tax_status",
  "dtype": "VARCHAR(20)",
  "source": "国税庁インボイスAPI(自動判定)",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 37,
  "block": "コンプラ・反社",
  "name": "反社チェック実施日",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "compliance_check.checked_on",
  "dtype": "DATE",
  "source": "移行データ（予備監査完了日）",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": true
 },
 {
  "no": 38,
  "block": "コンプラ・反社",
  "name": "反社チェック結果",
  "must": "推奨",
  "must3": "③段階必須（取引開始前）",
  "col": "compliance_check.result",
  "dtype": "VARCHAR(20)",
  "source": "反社チェックAPI（RoboRobo）",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": true
 },
 {
  "no": 39,
  "block": "コンプラ・反社",
  "name": "反社チェック有効期限(1年)",
  "must": "推奨",
  "must3": "③段階必須（取引開始前）",
  "col": "compliance_check.valid_until",
  "dtype": "DATE",
  "source": "手入力(顧客先は与信期限と同期)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": true
 },
 {
  "no": 41,
  "block": "コンプラ・反社",
  "name": "反社条項 締結状況",
  "must": "推奨",
  "must3": "③段階必須（契約締結時）",
  "col": "company.antisocial_clause_status",
  "dtype": "VARCHAR(30)",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": true
 },
 {
  "no": 43,
  "block": "コンプラ・反社",
  "name": "調査票 回収状況",
  "must": "推奨",
  "must3": "任意",
  "col": "compliance_survey.collected_on",
  "dtype": "DATE",
  "source": "届出(調査票の回答)",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 131,
  "block": "コンプラ・反社",
  "name": "反社検索用 正規化名(社名/代表者名)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.search_name_normalized / search_rep_normalized",
  "dtype": "VARCHAR(200) / VARCHAR(100)",
  "source": "社名・代表者名から自動生成",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "協力会社",
   "スクラップ業者",
   "施主"
  ],
  "approval": true
 },
 {
  "no": 45,
  "block": "与信",
  "name": "与信限度額",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "credit_line.limit_amount",
  "dtype": "BIGINT",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 46,
  "block": "与信",
  "name": "与信種類(普通/臨時)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "credit_line.limit_type",
  "dtype": "VARCHAR(20)",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 47,
  "block": "与信",
  "name": "与信有効期限(1年)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "credit_line.valid_until",
  "dtype": "DATE",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 48,
  "block": "与信",
  "name": "与信決裁日/決裁者",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "credit_line.approved_on",
  "dtype": "DATE",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 49,
  "block": "与信",
  "name": "与信不要先フラグ",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.credit_exempt",
  "dtype": "BOOLEAN",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 50,
  "block": "与信",
  "name": "一括手続先(親会社で与信)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "credit_line.use_parent_credit",
  "dtype": "BOOLEAN",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 51,
  "block": "与信",
  "name": "信用調査機関 評点",
  "must": "推奨",
  "must3": "任意",
  "col": "credit_line.agency_score",
  "dtype": "VARCHAR(20)",
  "source": "移行データ（予備監査依頼番号）",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 53,
  "block": "種別・状態",
  "name": "種別フラグ",
  "must": "必須",
  "must3": "①常時必須",
  "col": "company_type.type_code",
  "dtype": "VARCHAR(20)",
  "source": "勘定奉行の仕訳から自動判定（実装済み）",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 54,
  "block": "種別・状態",
  "name": "取引状態フラグ",
  "must": "推奨",
  "must3": "③段階必須（状態遷移時）",
  "col": "company.trade_status",
  "dtype": "VARCHAR(20)",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 55,
  "block": "種別・状態",
  "name": "取引先大区分",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.major_class",
  "dtype": "VARCHAR(20)",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 56,
  "block": "種別・状態",
  "name": "工事/非工事 区分",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.construction_class",
  "dtype": "VARCHAR(20)",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 58,
  "block": "種別・状態",
  "name": "取引停止・使用不可フラグ",
  "must": "推奨",
  "must3": "③段階必須（取引停止時）",
  "col": "company.is_suspended",
  "dtype": "BOOLEAN",
  "source": "移行データ（使用不可ｺｰﾄﾞ）",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 132,
  "block": "種別・状態",
  "name": "使用不可の理由(欠番にした理由)",
  "must": "推奨",
  "must3": "③段階必須（取引停止時）",
  "col": "company.suspend_reason / suspend_merged_into",
  "dtype": "VARCHAR(200) / VARCHAR(8)",
  "source": "移行データ（使用不可の理由・統合先）",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 59,
  "block": "種別・状態",
  "name": "取引終了日",
  "must": "推奨",
  "must3": "③段階必須（取引終了時）",
  "col": "company.trade_end_on",
  "dtype": "DATE",
  "source": "社内判断(経理)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 60,
  "block": "各システムコード",
  "name": "teraServation取引先コード(旧4桁)",
  "must": "推奨",
  "must3": "③段階必須（移行時）",
  "col": "system_code.code",
  "dtype": "VARCHAR(20)",
  "source": "移行データ（取引先コード）",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 61,
  "block": "各システムコード",
  "name": "勘定奉行オンプレ 取引先コード",
  "must": "推奨",
  "must3": "③段階必須（移行時）",
  "col": "system_code.code",
  "dtype": "VARCHAR(20)",
  "source": "移行データ（取引先コード）と同じ番号",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 62,
  "block": "各システムコード",
  "name": "勘定奉行クラウド 取引先コード(補助科目)",
  "must": "推奨",
  "must3": "③段階必須（奉行登録時）",
  "col": "system_code.code",
  "dtype": "VARCHAR(20)",
  "source": "未定",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 63,
  "block": "各システムコード",
  "name": "Salesforce 取引先コード",
  "must": "推奨",
  "must3": "③段階必須（SF登録時）",
  "col": "system_code.code",
  "dtype": "VARCHAR(20)",
  "source": "システム(採番/実績)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 64,
  "block": "各システムコード",
  "name": "新ERP(どっと原価/ZAC)取引先コード",
  "must": "推奨",
  "must3": "③段階必須（ERP登録時）",
  "col": "system_code.code",
  "dtype": "VARCHAR(20)",
  "source": "システム(採番/実績)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 128,
  "block": "各システムコード",
  "name": "バクラク取引先コード",
  "must": "推奨",
  "must3": "任意",
  "col": "system_code.code",
  "dtype": "VARCHAR(20)",
  "source": "システム(採番/実績)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 129,
  "block": "各システムコード",
  "name": "Bill One取引先コード",
  "must": "推奨",
  "must3": "任意",
  "col": "system_code.code",
  "dtype": "VARCHAR(20)",
  "source": "システム(採番/実績)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 66,
  "block": "支払関連",
  "name": "振込先 銀行名",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "bank_account.bank_name",
  "dtype": "VARCHAR(100)",
  "source": "移行データ（銀行名）",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": true
 },
 {
  "no": 67,
  "block": "支払関連",
  "name": "振込先 銀行/支店コード",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "bank_account.bank_code",
  "dtype": "CHAR(4)",
  "source": "移行データ（銀行/支店コード）",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": true
 },
 {
  "no": 68,
  "block": "支払関連",
  "name": "振込先 預金種別",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "bank_account.account_type",
  "dtype": "VARCHAR(10)",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": true
 },
 {
  "no": 69,
  "block": "支払関連",
  "name": "振込先 口座番号",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "bank_account.account_number",
  "dtype": "CHAR(7)",
  "source": "移行データ（口座番号）",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": true
 },
 {
  "no": 70,
  "block": "支払関連",
  "name": "振込先 口座名義(カナ)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "bank_account.account_holder_kana",
  "dtype": "VARCHAR(30)",
  "source": "移行データ（口座名義人）",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": true
 },
 {
  "no": 71,
  "block": "支払関連",
  "name": "複数口座",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "bank_account.priority",
  "dtype": "SMALLINT",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 74,
  "block": "支払関連",
  "name": "支払条件(締日/支払日/サイト)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "payment_term.term_code",
  "dtype": "VARCHAR(40)",
  "source": "社内システムの注文書（未着手）",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 75,
  "block": "支払関連",
  "name": "発注分類区分ごとの支払条件",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "payment_term.order_class",
  "dtype": "VARCHAR(20)",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 130,
  "block": "支払関連",
  "name": "注文書送付先(企業名/住所/電話/FAX/メール)",
  "must": "推奨",
  "must3": "任意",
  "col": "company_billing.order_send_to",
  "dtype": "JSONB",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 76,
  "block": "入金・支払関連",
  "name": "支払通知書 発行有無",
  "must": "推奨",
  "must3": "任意",
  "col": "company_billing.payment_notice_required",
  "dtype": "BOOLEAN",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 77,
  "block": "入金・支払関連",
  "name": "指定請求書の有無(特記)",
  "must": "推奨",
  "must3": "任意",
  "col": "company_billing.designated_invoice",
  "dtype": "VARCHAR(200)",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "協力会社",
   "販管費先",
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 79,
  "block": "請求・入金",
  "name": "請求書 締日",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_billing.closing_day",
  "dtype": "SMALLINT",
  "source": "社内システムの注文書（未着手）",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 80,
  "block": "請求・入金",
  "name": "入金基準 月/日",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_billing.receipt_month_day",
  "dtype": "VARCHAR(20)",
  "source": "社内システムの注文書（未着手）",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 81,
  "block": "請求・入金",
  "name": "営業日調整区分",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_billing.business_day_adjust",
  "dtype": "VARCHAR(20)",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 82,
  "block": "請求・入金",
  "name": "請求書送付先(部門/担当/住所/メール)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_billing.invoice_send_to",
  "dtype": "JSONB",
  "source": "社内システムの注文書（未着手）",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 83,
  "block": "請求・入金",
  "name": "指定請求書フォーマット/送付方法",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_billing.invoice_format",
  "dtype": "VARCHAR(100)",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 86,
  "block": "協力会社情報",
  "name": "建設業許可 業種(29業種)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "permit_license.construction_types",
  "dtype": "VARCHAR(200)",
  "source": "移行データ（29業種の列）",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 87,
  "block": "協力会社情報",
  "name": "建設業許可 大臣/知事・般特",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "permit_license.permit_authority",
  "dtype": "VARCHAR(40)",
  "source": "移行データ（大臣知事・般特）",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 88,
  "block": "協力会社情報",
  "name": "建設業許可 番号・有効期限",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "permit_license.permit_number",
  "dtype": "VARCHAR(40)",
  "source": "許可証の写し／gBizINFOの許認可情報",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 89,
  "block": "協力会社情報",
  "name": "解体工事業登録",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "permit_license.demolition_reg",
  "dtype": "VARCHAR(40)",
  "source": "届出(許可証)",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 90,
  "block": "協力会社情報",
  "name": "産業廃棄物収集運搬許可(固有番号・有効期限)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "permit_license.waste_permit_number",
  "dtype": "VARCHAR(40)",
  "source": "届出(許可証)",
  "sansan": "×",
  "types": [
   "協力会社",
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 91,
  "block": "協力会社情報",
  "name": "派遣免許",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "permit_license.dispatch_license",
  "dtype": "VARCHAR(40)",
  "source": "届出(許可証)",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 92,
  "block": "協力会社情報",
  "name": "得意工種",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_subcontractor.specialty_work",
  "dtype": "VARCHAR(200)",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 93,
  "block": "協力会社情報",
  "name": "対応地域(47都道府県)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_subcontractor.service_areas",
  "dtype": "VARCHAR(200)",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 94,
  "block": "協力会社情報",
  "name": "対応可能件数・キャパ",
  "must": "推奨",
  "must3": "任意",
  "col": "company_subcontractor.capacity",
  "dtype": "VARCHAR(60)",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 95,
  "block": "協力会社情報",
  "name": "評価・ランク",
  "must": "推奨",
  "must3": "任意",
  "col": "company_subcontractor.rating",
  "dtype": "VARCHAR(20)",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 96,
  "block": "協力会社情報",
  "name": "安全成績・事故歴",
  "must": "推奨",
  "must3": "任意",
  "col": "company_subcontractor.safety_record",
  "dtype": "TEXT",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 97,
  "block": "協力会社情報",
  "name": "有資格者・人数",
  "must": "推奨",
  "must3": "任意",
  "col": "company_subcontractor.qualified_staff",
  "dtype": "TEXT",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 98,
  "block": "協力会社情報",
  "name": "保有重機・設備",
  "must": "推奨",
  "must3": "任意",
  "col": "company_subcontractor.equipment",
  "dtype": "TEXT",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 99,
  "block": "協力会社情報",
  "name": "外注/常用区分",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_subcontractor.outsourcing_class",
  "dtype": "VARCHAR(20)",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "協力会社"
  ],
  "approval": false
 },
 {
  "no": 100,
  "block": "顧客情報",
  "name": "業界・セクター",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_customer.industry_sector",
  "dtype": "VARCHAR(60)",
  "source": "Sansanデータハブ(条件付)",
  "sansan": "〇",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 105,
  "block": "スクラップ業者情報",
  "name": "取扱品目(鉄/非鉄/種類)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_scrap.item_types",
  "dtype": "VARCHAR(200)",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 106,
  "block": "スクラップ業者情報",
  "name": "買取条件・単価",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_scrap.purchase_terms",
  "dtype": "TEXT",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 107,
  "block": "スクラップ業者情報",
  "name": "計量・引取条件",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_scrap.weighing_terms",
  "dtype": "TEXT",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 108,
  "block": "スクラップ業者情報",
  "name": "古物・産廃等 許可",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company_scrap.permits",
  "dtype": "VARCHAR(200)",
  "source": "届出(許可証)",
  "sansan": "×",
  "types": [
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 109,
  "block": "スクラップ業者情報",
  "name": "スクラップ台帳 連携(参照)",
  "must": "推奨",
  "must3": "任意",
  "col": "company_scrap.ledger_ref",
  "dtype": "VARCHAR(100)",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 110,
  "block": "スクラップ業者情報",
  "name": "有価物見積マニュアル(KG-15-2)整合",
  "must": "推奨",
  "must3": "任意",
  "col": "company_scrap.valuation_manual_ok",
  "dtype": "BOOLEAN",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 111,
  "block": "取引実績・履歴",
  "name": "取引履歴(発注/受注/支払/入金) / 工事情報データ(参照) / 取引累計額(発注/受注) / クレーム/トラブル履歴",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "-.-",
  "dtype": "-",
  "source": "システム(採番/実績)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 113,
  "block": "取引実績・履歴",
  "name": "最終取引日",
  "must": "推奨",
  "must3": "任意",
  "col": "company.last_trade_on",
  "dtype": "DATE",
  "source": "勘定奉行の仕訳（日付の最大値）",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 114,
  "block": "取引実績・履歴",
  "name": "与信使用状況(残高)",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "credit_line.used_amount",
  "dtype": "BIGINT",
  "source": "システム(採番/実績)",
  "sansan": "×",
  "types": [
   "得意先（顧客）",
   "施主"
  ],
  "approval": false
 },
 {
  "no": 115,
  "block": "文書・ファイル",
  "name": "許可証PDF(Box)",
  "must": "推奨",
  "must3": "任意",
  "col": "document.file_url",
  "dtype": "VARCHAR(500)",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "協力会社",
   "スクラップ業者"
  ],
  "approval": false
 },
 {
  "no": 116,
  "block": "文書・ファイル",
  "name": "契約書PDF(Box)",
  "must": "推奨",
  "must3": "任意",
  "col": "document.file_url",
  "dtype": "VARCHAR(500)",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 117,
  "block": "文書・ファイル",
  "name": "反社調査票(Box)",
  "must": "推奨",
  "must3": "任意",
  "col": "document.file_url",
  "dtype": "VARCHAR(500)",
  "source": "届出(取引先から)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": true
 },
 {
  "no": 118,
  "block": "文書・ファイル",
  "name": "名刺画像(Sansan)",
  "must": "推奨",
  "must3": "任意",
  "col": "document.file_url",
  "dtype": "VARCHAR(500)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 120,
  "block": "管理・メタ",
  "name": "登録日/登録者",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.created_at / created_by",
  "dtype": "TIMESTAMP / VARCHAR(40)",
  "source": "システム(採番/実績)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 121,
  "block": "管理・メタ",
  "name": "最終更新日/更新者",
  "must": "必須",
  "must3": "②種別別必須",
  "col": "company.updated_at / updated_by",
  "dtype": "TIMESTAMP / VARCHAR(40)",
  "source": "システム(採番/実績)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 122,
  "block": "管理・メタ",
  "name": "データ出所(Sansan/手入力/移行)",
  "must": "推奨",
  "must3": "任意",
  "col": "company.data_source",
  "dtype": "VARCHAR(20)",
  "source": "Sansanデータハブ",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 125,
  "block": "管理・メタ",
  "name": "備考(自由記述・最小限)",
  "must": "推奨",
  "must3": "任意",
  "col": "company.remarks",
  "dtype": "TEXT",
  "source": "システム(採番/実績)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 126,
  "block": "協力会社情報",
  "name": "経理担当者連絡先",
  "must": "推奨",
  "must3": "任意",
  "col": "company_subcontractor.accounting_contact",
  "dtype": "VARCHAR(200)",
  "source": "Sansanデータハブ(条件付)",
  "sansan": "〇",
  "types": [
   "*"
  ],
  "approval": false
 },
 {
  "no": 127,
  "block": "協力会社情報",
  "name": "取引先の専用システム情報（URLとか）",
  "must": "推奨",
  "must3": "任意",
  "col": "company_subcontractor.portal_url",
  "dtype": "VARCHAR(255)",
  "source": "手入力(工事/調達)",
  "sansan": "×",
  "types": [
   "*"
  ],
  "approval": false
 }
],
};
