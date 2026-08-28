/**
 * torihikisaki.js - 取引先管理タブ（取引先マスタ）
 *
 * 画面＝塩田さん画面モック（04_取引先マスタ_画面モック_260812.html）を実DB接続で再現:
 *   左サイド（会社一覧／新規登録・編集／システム連携／変更履歴）＋トップバー（検索 Ctrl K／CSV出力／CSV取込／＋新規登録）
 *   一覧＝表示列の自由選択（106項目・localStorage保存）・50社/ページ
 *   詳細＝ページ遷移型。基本情報（入力形式5種）／取引履歴／変更履歴タブ＋右パネル（AIチェック・支店・口座・連携状況）
 *
 * モックとの意図的な差分（実DBの安全機構・開発ブリーフ§3の要件）:
 *   - モックの即時保存（localStorage）ではなく「未保存バー→💾 保存」で確定（履歴を先に書き、本体失敗時は取り消す）
 *   - 口座5項目・反社は承認制（変更すると未承認へ・本人以外の admin/accounting が承認）＝入力欄はロックし専用カードから申請
 *   - 新規登録は registration_stage='temp'（申請中）で入り、本人以外の承認で 'full'
 *   - 変更履歴は取引先マスタ専用の company_history（統合管理ツールの audit_logs とは別建て・混ぜない）
 *
 * データ＝18テーブル（塩田さん設計 2026-08-12）。閲覧・書込とも admin＋accounting のみ（TAB_ROLES＋RLS）。
 * 開発中は config.local.js の Sync.TORIHIKISAKI_DB で学習用Supabaseへ。未設定なら本体と同じ（本番の形）。
 */
const TorihikisakiView = {
  // ===== データ =====
  rows: null,           // company 全列（初回取得でキャッシュ・一覧と表示列解決の源）
  typesByCid: {},       // company_id -> [type_code]
  codesByCid: {},       // company_id -> {system: code}
  detail: null,         // 詳細で開いている会社のテーブル束
  histAll: null,        // 変更履歴（グローバル）ビューのキャッシュ

  // ===== 画面状態 =====
  view: 'list',         // list / detail / new / sys / history
  sel: null,            // 詳細の company_id
  dtab: 'basic',        // 詳細タブ: basic / tx / hist
  fmt: '単票フォーム',   // 入力形式（localStorage）
  fmtFocus: 0,
  listCols: null,       // 一覧の表示列（項目No配列・localStorage）
  filtQ: '',
  page: 0,
  PER: 50,
  colPopOpen: false,
  stateFilter: 'active',   // active / suspended / temp / all（実装側の追加機能・モックには無い）
  pending: {},          // 詳細の未保存編集 col -> 入力文字列
  autoPaths: {},        // そのうち「自動判定」で入れたパス（履歴のchanged_byに印を付ける）
  autoWhy: {},          // その判定理由（画面の注記に出す） path -> 理由
  autoNew: {},          // 新規登録フォームで自動判定が入れた値 path -> val
  bankEdit: null,       // 口座の申請フォーム（account_id / 'new' / null）
  busy: false,          // 書込中（二重送信の防止）
  isNew: false,
  newMethod: null,
  newVals: {},          // 新規フォームの入力 col -> 文字列
  newTypes: [],         // 新規フォームの種別（ラベル）
  dupFrom: null,
  dupSeed: null,        // 複製元の値（col -> 生値）
  enrichNotice: null,   // API取得の確からしさを人に伝える文言（名刺の枚数・住所の揺れ）

  LS: { cols: 'tmk_cols', fmt: 'tmk_fmt', theme: 'tmk_theme' },
  FORMATS: ['単票フォーム', '2カラム', 'カード', 'フォーカス', 'Excel風グリッド'],
  NAV: [['list', '▦', '会社一覧'], ['new', '＋', '新規登録・編集'], ['apichk', '🔄', 'API更新チェック'],
    ['sys', '⇄', 'システム連携'], ['history', '🕘', '変更履歴']],
  TITLES: { list: '会社一覧', new: '新規登録・編集', apichk: 'API更新チェック', sys: 'システム連携', history: '変更履歴', detail: '' },

  // ===== Box 埋め込み（2026-08-28 坂本さん指示） =====
  // 対象＝Box `030_財務経理課 / 00_取引先コード`。
  // 🔴実測した構造（2026-08-28・Box Driveのメタデータを全走査）:
  //   ここは**書類の種類ごとの親フォルダ**であり、取引先ごとのフォルダではない。直下は
  //   参考／取引先マスタ構築／取引口座申請書 修正案／取引口座申請書依頼状／取引口座申請書PDF(空)／
  //   回覧済 取引口座申請書他登録資料一式(PDF)／得意先・客先・外注先等の新規取引開始書類／
  //   新規取引開始の際に協力会社等に送付するもの の8つ。
  //   **取引先ごとのフォルダは例外的にしか無い**（コード付きの1社と、社名だけの7社のみ）。
  //   大半の原本は「<取引先コード><社名>　<日付>取引口座申請書.pdf」のように
  //   **ファイル名の先頭に取引先コードを付けて平置き**されている。
  //   → だから「会社ごとにフォルダを埋め込む」設計は成り立たない。フォルダを見せて人が辿るか、
  //     コード/社名で検索するかの2本立てにする。
  // 🔴フォルダIDはBox Driveのローカルメタデータ（sync.db の box_item）から実測して確定（推測していない）。
  //   埋め込みURLは公式の Box Embed 形式（developer.box.com/guides/embed/box-embed）。
  //   実測: /embed/folder/<id> は 200・X-Frame-Options も CSP frame-ancestors も無し＝iframe可。
  //   未サインインでもiframe内にBox専用サインインが出るだけで、親フレームは乗っ取られない。
  //   認証はBox側に委ねる（ツールにBoxの資格情報を持たせない）。
  BOX_FOLDER_ID: '396249381466',
  BOX_FOLDER_PATH: '030_財務経理課 / 00_取引先コード',
  // 原本が集まっている主要な子フォルダ（実測: 直下20件＋会社フォルダ1件）。既定の表示先にする
  BOX_SUBS: [
    ['396249381466', '00_取引先コード（親フォルダ）'],
    ['396250370293', '回覧済 取引口座申請書他登録資料一式(PDF)'],
    ['396256447110', '参考 / 送付済取引口座申請書'],
    ['396247580885', '新規取引開始書類（得意先・客先・外注先等）'],
    ['396249157739', '新規取引開始の際に協力会社等に送付するもの'],
  ],
  boxEmbedUrl(fid) {
    return `https://app.box.com/embed/folder/${fid || this.BOX_FOLDER_ID}` +
      '?view=list&sortColumn=name&sortDirection=ASC&showParentPath=true';
  },
  boxFolderUrl(fid) { return `https://app.box.com/folder/${fid || this.BOX_FOLDER_ID}`; },
  // 会社の資料を探すリンク。原本のファイル名は「<取引先コード><社名>　<日付>取引口座申請書.pdf」のように
  // **取引先コードで始まる**ため、コードでフォルダ内検索すればその会社の資料に辿り着ける（実データで確認）。
  boxSearchUrl(q) {
    return `https://app.box.com/folder/${this.BOX_FOLDER_ID}/search?query=${encodeURIComponent(String(q || ''))}`;
  },
  NEW_METHOD_LABELS: { sansan: '名刺・Sansan取込で登録', hojin: '法人番号で登録', dup: '既存社を複製して登録', quick: '名前だけ先行登録' },

  SYSTEM_BY_NO: { 60: 'tera', 61: 'obc_onpre', 62: 'obc_cloud', 63: 'salesforce', 64: 'new_erp', 128: 'bakuraku', 129: 'bill_one' },
  SYSTEM_LABEL: { tera: 'teraServation', obc_onpre: '勘定奉行(オンプレ)', obc_cloud: '勘定奉行クラウド', salesforce: 'Salesforce', new_erp: '新ERP', bakuraku: 'バクラク', bill_one: 'Bill One' },
  // システム連携状況。
  // 🔴実態＝自動連携しているシステムは現時点で一つも無い（2026-08-26 坂本さん指摘で訂正）。
  //   tera と 勘定奉行(オンプレ) は同じ取引先コードを共有しているが、各システムへの登録は人が手で転記している。
  //   モックの「連携済（緑）」表記は自動同期と誤読されるため廃止し、コード保有の実測＋転記方法で表す。
  // mode: manual=コード共有・手動転記 / planned=今後の配信対象（API配信は今回スコープ外）
  SYSLINK: [
    { name: 'teraServation', sys: 'tera', mode: 'manual' },
    { name: '勘定奉行(オンプレ)', sys: 'obc_onpre', mode: 'manual' },
    { name: 'Bill One', sys: 'bill_one', mode: 'manual' },
    { name: '勘定奉行(クラウド)', sys: 'obc_cloud', mode: 'planned' },
    { name: 'Salesforce', sys: 'salesforce', mode: 'planned' },
    { name: '新ERP(どっと原価/ZAC)', sys: 'new_erp', mode: 'planned' },
    { name: 'バクラク', sys: 'bakuraku', mode: 'planned' },
  ],

  // コード保有の実測と mode から、その系の状態を決める（画面2箇所で同じ判定を使う）
  sysState(sys, mode, count) {
    if (count > 0) return { badge: '手動転記', cls: 'b-amber', note: mode === 'manual' ? '取引先コードは共通・登録は手作業' : 'コードあり（自動配信なし）' };
    if (mode === 'manual') return { badge: '未採番', cls: 'b-slate', note: 'このシステム用のコードはマスタ未保持' };
    return { badge: '未接続', cls: 'b-slate', note: '今後の採番・配信対象（今回スコープ外）' };
  },

  // 1社1行として扱うテーブル（editPlan の kind:'single' の対象）。
  // credit_line / compliance_survey は BIGSERIAL PK だが実データは1社1行（2026-08-26確認: 与信28社・調査票0件）
  // ＝company_billing と同じ「無ければinsert・あればupdate」で扱う。
  EDITABLE_TABLES: ['company', 'company_billing', 'company_subcontractor', 'company_customer', 'company_scrap',
    'credit_line', 'compliance_survey'],
  LOCKED_COLS: ['company.company_id', 'company.created_at', 'company.created_by', 'company.updated_at', 'company.updated_by'],
  BANK_COLS: ['bank_name', 'bank_code', 'branch_code', 'account_type', 'account_number', 'account_holder_kana', 'payment_method', 'is_factoring'],
  BANK_LABELS: { bank_name: '銀行名', bank_code: '銀行コード', branch_code: '支店コード', account_type: '預金種別', account_number: '口座番号', account_holder_kana: '口座名義(カナ)', payment_method: '支払方法', is_factoring: 'ファクタリング' },

  // ===== 編集パス基盤（2026-08-26 未実装項目の実装で導入） =====
  // 編集の最小単位を「パス」で表す。pending / newVals のキーはすべてパス。
  //   company.name_kana                      … 通常の1列
  //   system_code[tera].code                 … キー付きテーブル（system列の値で行が決まる）
  //   permit_license[construction].permit_number
  //   company_billing.invoice_send_to#dept   … JSONB列の中の1キー
  KEY_COL: { system_code: 'system', permit_license: 'permit_type' },

  // 許認可: 項目No → [permit_type, 実列]。モックの仮想列（demolition_reg等）はDDLに無く、
  // permit_type で行を分けて permit_number に入れるのが実データの設計（construction 279行等で確認）
  PERMIT_BY_NO: { 86: ['construction', 'construction_types'], 87: ['construction', 'permit_authority'],
    89: ['demolition', 'permit_number'], 91: ['dispatch', 'permit_number'] },
  PERMIT_TYPE_LABEL: { construction: '建設業許可', demolition: '解体工事業登録', waste: '産廃収集運搬許可', dispatch: '派遣免許' },
  PERMIT_COL_LABEL: { construction_types: '業種', permit_authority: '許可区分', permit_number: '番号', valid_until: '有効期限', waste_prefecture: '自治体', valid_from: '許可日' },
  JSONB_KEY_LABEL: { dept: '部門', person: '担当', address: '住所', email: 'メール', company: '企業名', phone: '電話', fax: 'FAX' },
  DOC_BY_NO: { 115: 'permit', 116: 'contract', 118: 'meishi' },
  DOC_TYPE_LABEL: { permit: '許可証PDF', contract: '契約書PDF', meishi: '名刺画像', survey: '反社調査票' },

  // 複数欄に分解して編集する項目（項目No → サブ欄定義）。
  // gen: 'halfKana'=全角カナから自動変換 / 'nameHalf'=正式社名から半角社名の候補を作る（人が手直しできる）
  SUBFIELDS: {
    3: [
      { path: 'company.name_kana', label: '全角カナ', dtype: 'VARCHAR(200)' },
      { path: 'company.name_kana_half', label: '半角カナ', dtype: 'VARCHAR(200)', gen: 'halfKana', genLabel: '全角から変換' },
      { path: 'company.name_half', label: '半角社名', dtype: 'VARCHAR(200)', gen: 'nameHalf', genLabel: '社名から候補' },
    ],
    25: [
      { path: 'company.prefecture', label: '都道府県', dtype: 'VARCHAR(20)', optionsFrom: 'PREFS' },
      { path: 'company.address_line', label: '番地', dtype: 'VARCHAR(200)' },
      { path: 'company.building', label: '建物', dtype: 'VARCHAR(100)' },
    ],
    43: [
      { path: 'compliance_survey.sent_on', label: '送付日', dtype: 'DATE' },
      { path: 'compliance_survey.answered_on', label: '回答日', dtype: 'DATE' },
    ],
    48: [
      { path: 'credit_line.approved_on', label: '決裁日', dtype: 'DATE' },
      { path: 'credit_line.decided_by', label: '決裁者', dtype: 'VARCHAR(40)' },
    ],
    82: [
      { path: 'company_billing.invoice_send_to#dept', label: '部門', dtype: 'VARCHAR(100)' },
      { path: 'company_billing.invoice_send_to#person', label: '担当', dtype: 'VARCHAR(100)' },
      { path: 'company_billing.invoice_send_to#address', label: '住所', dtype: 'VARCHAR(300)' },
      { path: 'company_billing.invoice_send_to#email', label: 'メール', dtype: 'VARCHAR(200)' },
    ],
    88: [
      { path: 'permit_license[construction].permit_number', label: '許可番号', dtype: 'VARCHAR(40)' },
      { path: 'permit_license[construction].valid_until', label: '有効期限', dtype: 'DATE' },
    ],
    90: [
      { path: 'permit_license[waste].permit_number', label: '固有番号', dtype: 'VARCHAR(40)' },
      { path: 'permit_license[waste].waste_prefecture', label: '許可自治体', dtype: 'VARCHAR(20)' },
      { path: 'permit_license[waste].valid_until', label: '有効期限', dtype: 'DATE' },
    ],
    130: [
      { path: 'company_billing.order_send_to#company', label: '企業名', dtype: 'VARCHAR(200)' },
      { path: 'company_billing.order_send_to#address', label: '住所', dtype: 'VARCHAR(300)' },
      { path: 'company_billing.order_send_to#phone', label: '電話', dtype: 'VARCHAR(20)' },
      { path: 'company_billing.order_send_to#fax', label: 'FAX', dtype: 'VARCHAR(20)' },
      { path: 'company_billing.order_send_to#email', label: 'メール', dtype: 'VARCHAR(200)' },
    ],
    // 🔴移行データでは正規化名＝社名・代表者名の**そのままの写し**（2,563社/1,736社で実測）。
    //   「正規化」の実際の規則（株式会社の除去・空白の扱い等）は設計書に無く未確定＝塩田さん確認事項。
    //   推測でルールを作らず、写すだけのボタンにしてある（人が手直しできる）。
    131: [
      { path: 'company.search_name_normalized', label: '社名（検索用）', dtype: 'VARCHAR(200)', gen: 'searchName', genLabel: '社名から写す' },
      { path: 'company.search_rep_normalized', label: '代表者名（検索用）', dtype: 'VARCHAR(100)', gen: 'searchRep', genLabel: '代表者名から写す' },
    ],
    132: [
      { path: 'company.suspend_reason', label: '理由', dtype: 'VARCHAR(200)' },
      { path: 'company.suspend_merged_into', label: '統合先(マスタ番号)', dtype: 'VARCHAR(8)', norm: 'cid' },
    ],
  },

  // ===== 選択式の項目（プルダウン）2026-08-26 坂本さん指示 =====
  // 🔴選択肢を勝手に作らない。ここに載せるのは根拠があるものだけ:
  //   (a) 設計書03に値が明記されている  (b) 項目名そのものが選択肢の定義になっている
  //   (c) 実データの分布で確定している
  //   根拠の無い区分（取引状態・大区分・営業日調整・評価ランク・業種・上場区分・許可行政庁ほか）は
  //   自由入力のまま残し、塩田さん確認リストに載せる。推測で選択肢を作ると誤った値で運用が固まる。
  // 🔴選択肢に無い既存値は inputByDtype が「（現在値・選択肢外）」として必ず残す（値を消さない）。
  CHOICES: {
    34: ['該当', '登録なし(確認済)', '未確認'],   // 設計書03★「BOOLEANではなく3値」＋実データ2,563件が完全一致
    14: ['法人', '個人'],                        // 項目名「法人/個人区分」＝定義そのもの（取得元=国税庁API）
    15: ['国内', '海外'],                        // 項目名「国内/海外区分」
    35: ['課税事業者', '免税事業者'],              // 項目名「課税/免税事業者区分」
    46: ['普通', '臨時'],                        // 項目名「与信種類(普通/臨時)」
    56: ['工事', '非工事'],                      // 項目名「工事/非工事 区分」
    99: ['外注', '常用'],                        // 項目名「外注/常用区分」
    12: ['上場', '非上場'],                       // 坂本さん指示(2026-08-28)。実データは「上場」9社のみで
                                                //  「非上場」の実例は無いが、区分の対として運用で使う
    122: ['migration', 'sansan', 'hojin', 'dup', 'quick'],   // 実装の作成経路（NEW_METHOD_LABELS＋移行）
  },
  // データ出所は内部コードで持つため、表示名を別に持つ（#122）
  CHOICE_LABELS: {
    122: { migration: '移行(棚卸2026)', sansan: '名刺・Sansan取込', hojin: '法人番号で登録', dup: '既存社を複製', quick: '名前だけ先行登録' },
  },
  // 口座カード側の選択肢（メタ項目ではなく bank_account の列）。実データ1,740〜1,768件の分布で確定
  BANK_CHOICES: {
    account_type: ['普', '当'],                          // 普1,220 / 当520（🔴他に不正値1件あり=移行の取り違え）
    payment_method: ['振込', '口座振替', 'カード決済'],     // 振込1,749 / カード決済14 / 口座振替5
  },

  // ===== #86 建設業許可 業種(29業種) チェック式入力（2026-08-28 坂本さん指示） =====
  // 保存形式は移行データと同じ「略号=般;略号=特;…」の文字列（DB・履歴・CSVは従来のまま）。
  // t=保存トークン（移行データの略号が正。🔴タイルは漢字の「夕」=移行元Excel準拠。カタカナ「タ」も読取は受ける）
  // n=表示名／full=正式名（title表示）。並びは経審の29業種順（土建大左と…清解）。経審コード01〜29は扱わない。
  K29: [
    { t: '土', n: '土木', full: '土木工事業' },
    { t: '建', n: '建築', full: '建築工事業' },
    { t: '大', n: '大工', full: '大工工事業' },
    { t: '左', n: '左官', full: '左官工事業' },
    { t: 'と', n: 'とび・土工', full: 'とび・土工・コンクリート工事業' },
    { t: '石', n: '石', full: '石工事業' },
    { t: '屋', n: '屋根', full: '屋根工事業' },
    { t: '電', n: '電気', full: '電気工事業' },
    { t: '管', n: '管', full: '管工事業' },
    { t: '夕', n: 'タイル', full: 'タイル・れんが・ブロック工事業' },
    { t: '鋼', n: '鋼構造物', full: '鋼構造物工事業' },
    { t: '筋', n: '鉄筋', full: '鉄筋工事業' },
    { t: '舗', n: '舗装', full: '舗装工事業' },
    { t: 'しゅ', n: 'しゅんせつ', full: 'しゅんせつ工事業' },
    { t: '板', n: '板金', full: '板金工事業' },
    { t: 'ガ', n: 'ガラス', full: 'ガラス工事業' },
    { t: '塗', n: '塗装', full: '塗装工事業' },
    { t: '防', n: '防水', full: '防水工事業' },
    { t: '内', n: '内装仕上', full: '内装仕上工事業' },
    { t: '機', n: '機械器具', full: '機械器具設置工事業' },
    { t: '絶', n: '熱絶縁', full: '熱絶縁工事業' },
    { t: '通', n: '電気通信', full: '電気通信工事業' },
    { t: '園', n: '造園', full: '造園工事業' },
    { t: '井', n: 'さく井', full: 'さく井工事業' },
    { t: '具', n: '建具', full: '建具工事業' },
    { t: '水', n: '水道施設', full: '水道施設工事業' },
    { t: '消', n: '消防施設', full: '消防施設工事業' },
    { t: '清', n: '清掃施設', full: '清掃施設工事業' },
    { t: '解', n: '解体', full: '解体工事業' },
  ],
  // 移行の旧列（学習用153/153行で現行「と」「解」と完全重複を実測）。元の値に存在した場合のみ
  // 現行トークンと同値で連動保存する（新規入力では作らない）。塩田さんへ列廃止の確認事項あり。
  K29_LEGACY: { 'とび土工(旧列)': 'と', '解体(旧列)': '解' },

  // 「略号=般;…」→ { map: {トークン: '般'|'特'}, legacy: {旧列名: true}, extra: [選択肢外トークン] }
  k29Parse(val) {
    const map = {}, legacy = {}, extra = [];
    String(val || '').split(';').forEach(tok => {
      const t = tok.trim();
      if (!t) return;
      const i = t.indexOf('=');
      const k = i < 0 ? t : t.slice(0, i);
      const v = i < 0 ? '' : t.slice(i + 1);
      if (this.K29_LEGACY[k] !== undefined) { legacy[k] = true; return; }
      const key = k === 'タ' ? '夕' : k;
      if (this.K29.some(x => x.t === key) && (v === '般' || v === '特')) { map[key] = v; return; }
      extra.push(t);   // 🔴選択肢外の値は消さない（既存プルダウンと同じ原則）
    });
    return { map, legacy, extra };
  },
  k29Serialize(map, legacy, extra) {
    const parts = this.K29.filter(k => map[k.t]).map(k => `${k.t}=${map[k.t]}`);
    Object.keys(this.K29_LEGACY).forEach(name => {
      const cur = map[this.K29_LEGACY[name]];
      if (legacy[name] && cur) parts.push(`${name}=${cur}`);
    });
    return parts.concat(extra || []).join(';');
  },

  // ===== 自動判定（2026-08-28 坂本さん指示） =====
  // 社名・法人番号・住所から機械的に決まる区分を、**根拠がある場合だけ**埋める。
  // 🔴材料が無ければ「判定しない」＝空欄のまま人に委ねる。無いものを推測で埋めると、
  //   もっともらしい誤りが静かに広がる（Sansanの名刺住所を本社住所にしかけた反省と同じ）。
  // 実データ2,563社での実測（この設計の根拠。#14/#15は2,562社が空欄＝必須なのに丸ごと未入力だった）:
  //   #14 法人番号あり2,210社 ∪ 社名に法人格2,396社 → **2,424社**を「法人」と言い切れる。
  //       残り139社（江東西税務署・東京都水道局・○○協力会・個人名など）は材料ゼロ＝空欄のまま。
  //       🔴「法人格が無い＝個人」とはしない（税務署や水道局が個人になってしまう）。
  //   #15 都道府県あり2,302社 ∪ 住所文字列に都道府県名58社 → **2,360社**を「国内」と言い切れる。
  //       🔴「海外」は自動判定しない（英字社名でも日本法人はある＝社名は根拠にならない）。
  CORP_FORMS: ['株式会社', '有限会社', '合同会社', '合資会社', '合名会社', '相互会社',
    '㈱', '㈲', '(株)', '（株）', '(有)', '（有）',
    '一般社団法人', '公益社団法人', '一般財団法人', '公益財団法人', '社団法人', '財団法人',
    '医療法人', '学校法人', '宗教法人', '社会福祉法人', '特定非営利活動法人', 'NPO法人',
    '独立行政法人', '国立大学法人', '地方独立行政法人',
    '監査法人', '税理士法人', '弁護士法人', '弁理士法人', '司法書士法人', '行政書士法人',
    '社会保険労務士法人',
    '生活協同組合', '農業協同組合', '協同組合', '有限責任事業組合', '共済組合', '組合',
    '信用金庫', '信用組合', '労働金庫'],
  AUTO_BY_NO: { 14: 'entity', 15: 'domestic' },

  // ===== 他の項目の値で入力できなくなる項目（2026-08-28 坂本さん指示） =====
  // 例: 上場区分が「非上場」なら 上場市場 は入れられない（矛盾した値を作らせない）。
  // 🔴既に入っている値は消さない（グレーにするだけ）。値を消すかどうかは人が決めること。
  //   ただし**その場で入力中だった未保存の変更は取り消す**（入力できない欄の編集を保存させないため）。
  LINKED_DISABLE: {
    13: { by: 'company.listing_class', when: ['非上場'], why: '上場区分が「非上場」のため入力できません' },
  },
  // その項目がいま入力できない状態か（api.get で「未保存を重ねた現在値」を見る）
  linkedOff(f, api) {
    const d = this.LINKED_DISABLE[f.no];
    if (!d) return null;
    const cur = String(api.get(d.by) === undefined || api.get(d.by) === null ? '' : api.get(d.by)).trim();
    return d.when.indexOf(cur) >= 0 ? d : null;
  },

  // ===== 承認制の印はあるが「手入力を許す」項目（2026-08-28 坂本さん指示） =====
  // 🔴口座（#66-70）は入れない。口座は承認フロー（本人以外のadmin/accountingが承認）を維持する。
  //   反社系は確定手段（RoboRobo等の反社チェックAPI）が未契約で、
  //   #39は設計上の取得元が「手入力」、#41は「社内判断(経理)」＝人が入れる前提なのに欄が無かった。
  //   誰が変えたかは変更履歴（changed_by）に残るので、履歴で追跡できる。
  //   ⚠️API自動補完の対象外である点は変えていない（torihikisaki_enrich.js は f.approval で独立に除外）。
  MANUAL_OK: { 37: 1, 38: 1, 39: 1, 41: 1, 117: 1, 131: 1 },

  // 自動判定の本体。get(path)=その時点の値。判定できなければ null（＝埋めない）
  //   戻り値 {val, why}: why はボタンのtitleとトーストで人に理由を見せるため
  autoJudge(no, get) {
    const g = p => { const v = get(p); return String(v === undefined || v === null ? '' : v).trim(); };
    const kind = this.AUTO_BY_NO[no];
    if (kind === 'entity') {
      if (g('company.corporate_number').replace(/[^0-9]/g, '').length === 13)
        return { val: '法人', why: '法人番号（13桁）が登録されているため' };
      const name = g('company.official_name');
      const hit = name && this.CORP_FORMS.find(x => name.includes(x));
      if (hit) return { val: '法人', why: `社名に「${hit}」が含まれるため` };
      return null;   // 個人とは決めつけない
    }
    if (kind === 'domestic') {
      const pref = g('company.prefecture');
      if (this.PREFS.indexOf(pref) >= 0) return { val: '国内', why: `本社住所が${pref}のため` };
      const addr = g('company.address_line') + ' ' + g('company.registered_address');
      const p2 = addr.trim() && this.PREFS.find(x => addr.includes(x));
      if (p2) return { val: '国内', why: `住所に「${p2}」が含まれるため` };
      return null;   // 海外とは決めつけない
    }
    return null;
  },

  // 編集はカードで行う項目（フォーム側は読み取り表示＋案内だけ）
  CARD_NOTE: {
    5: '右の「旧社名」カードで追加・変更できます',
    27: '右の「支店・枝番管理」カードで編集できます',
    71: '右の「振込先口座」カードで追加できます（承認制）',
    74: '右の「支払条件」カードで追加・変更できます',
    75: '右の「支払条件」カードで発注分類ごとに追加できます',
    111: '基幹（teraServation／Salesforce等）からの参照です（「取引履歴」タブ）',
    115: '右の「文書（Boxリンク）」カードで追加できます',
    116: '右の「文書（Boxリンク）」カードで追加できます',
    117: '右の「文書（Boxリンク）」カードで追加できます（種類＝反社調査票）',
    118: '右の「文書（Boxリンク）」カードで追加できます',
    120: 'システムが自動記録します',
    121: 'システムが自動記録します',
  },

  // パス文字列 → {table, keyCol, keyVal, column, jsonKey}
  parsePath(path) {
    const m = String(path || '').match(/^(\w+)(?:\[([^\]]+)\])?\.([\w]+)(?:#([\w]+))?$/);
    if (!m) return null;
    return { table: m[1], keyCol: m[2] ? this.KEY_COL[m[1]] : null, keyVal: m[2] || null,
      column: m[3], jsonKey: m[4] || null };
  },

  // パスの生値（DBの値そのまま）
  rawByPath(path, d) {
    const p = this.parsePath(path);
    if (!p || !d) return null;
    let row;
    if (p.table === 'company') row = d.company;
    else if (p.keyCol) row = (d[p.table] || []).find(r => r[p.keyCol] === p.keyVal);
    else row = (d[p.table] || [])[0];
    if (!row) return null;
    let v = row[p.column];
    if (p.jsonKey) v = (v && typeof v === 'object') ? v[p.jsonKey] : null;
    return v === undefined ? null : v;
  },

  // パス → 変更履歴の column_name（40字以内）。キー付きは「キー.列」・JSONBは「列.キー」
  histColName(p) {
    if (p.keyVal) return `${p.keyVal}.${p.column}`;
    if (p.jsonKey) return `${p.column}.${p.jsonKey}`;
    return p.column;
  },

  // 項目の編集計画。null=編集不可（承認制・システム記録・未定義）
  //   {kind:'single', path, dtype} / {kind:'multi', subs} / {kind:'type'} / {kind:'card', note}
  editPlan(f) {
    if (f.approval && !this.MANUAL_OK[f.no]) return null;
    if (this.CARD_NOTE[f.no]) return { kind: 'card', note: this.CARD_NOTE[f.no] };
    if (this.SUBFIELDS[f.no]) return { kind: 'multi', subs: this.SUBFIELDS[f.no] };
    if (f.no === 53) return { kind: 'type' };
    const sys = this.SYSTEM_BY_NO[f.no];
    if (sys) return { kind: 'single', path: `system_code[${sys}].code`, dtype: 'VARCHAR(20)' };
    const pm = this.PERMIT_BY_NO[f.no];
    // #86 業種(29業種)はチェック式（般/特チップ）。パス・保存形式はsingle時代と同一
    if (pm && f.no === 86) return { kind: 'kyoka29', path: `permit_license[${pm[0]}].${pm[1]}`, dtype: f.dtype || 'VARCHAR(200)' };
    if (pm) return { kind: 'single', path: `permit_license[${pm[0]}].${pm[1]}`, dtype: f.dtype || 'VARCHAR(40)' };
    if (this.isFormEditable(f)) {
      return { kind: 'single', path: f.col, dtype: f.dtype,
        options: this.CHOICES[f.no], optionLabels: this.CHOICE_LABELS[f.no],
        auto: !!this.AUTO_BY_NO[f.no] };
    }
    return null;
  },

  // 項目が持つ編集パスの一覧（出所バッジ・pending判定に使う）。#53は擬似パス 'company_type'
  fieldPaths(f) {
    const plan = this.editPlan(f);
    if (!plan) return [];
    if (plan.kind === 'single' || plan.kind === 'kyoka29') return [plan.path];
    if (plan.kind === 'multi') return plan.subs.map(s => s.path);
    if (plan.kind === 'type') return ['company_type'];
    return [];
  },

  // パスの人間向けラベル（エラー表示・履歴用）
  pathLabel(f, path) {
    const plan = this.editPlan(f);
    if (plan && plan.kind === 'multi') {
      const sub = plan.subs.find(s => s.path === path);
      if (sub) return `${f.name}（${sub.label}）`;
    }
    return f.name;
  },

  // 正式社名 → 半角社名の候補（㈱表記・カナと英数を半角化。「有限責任」等の扱いは人の判断＝手直し前提）
  genNameHalf(name) {
    let s = String(name || '').trim()
      .replace(/株式会社/g, '㈱').replace(/有限会社/g, '㈲').replace(/合同会社/g, '(同)').replace(/合資会社/g, '(資)')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ');
    return this.toHalfKana(s);
  },

  // ===== 小道具 =====
  el(id) { return document.getElementById(id); },
  esc(text) { return Util.esc(text); },
  norm(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s　-]+/g, ''); },
  whoAmI() { return String((typeof Sync !== 'undefined' && (Sync.displayName || Sync.email)) || '(不明)').slice(0, 40); },
  fieldByNo(no) { return TM_META.FIELDS.find(f => f.no === no); },
  toast(m) {
    const t = this.el('tmk-toast');
    if (!t) return;
    t.textContent = m;
    t.classList.add('on');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('on'), 2500);
  },
  isActive() {
    const p = this.el('tab-torihikisaki');
    return p && !p.classList.contains('hidden');
  },

  // 開発中は学習用Supabase・本番は本体と同じクライアント
  getClient() {
    if (this._client) return this._client;
    const cfg = Sync.TORIHIKISAKI_DB;
    this._client = (cfg && cfg.url && cfg.anonKey)
      ? supabase.createClient(cfg.url, cfg.anonKey)
      : Sync.getSupabase();
    return this._client;
  },

  // PostgRESTは1リクエスト最大1,000行 → rangeでページング全件取得
  async fetchAll(table, cols, orderCol) {
    const sb = this.getClient();
    const out = [];
    const PAGE = 1000;
    for (let start = 0; ; start += PAGE) {
      let q = sb.from(table).select(cols).range(start, start + PAGE - 1);
      if (orderCol) q = q.order(orderCol);
      const res = await q;
      if (res.error) throw new Error(`${table}: ${res.error.message}`);
      out.push(...(res.data || []));
      if ((res.data || []).length < PAGE) return out;
    }
  },

  // ===== 初期化（トップバー・サイドナビ・Ctrl+K・テーマ・CSV） =====
  init() {
    const panel = this.el('tab-torihikisaki');
    if (!panel) return;
    // localStorage の復元
    try { this.listCols = JSON.parse(localStorage.getItem(this.LS.cols)); } catch (e) { /* 破損は既定値 */ }
    if (!Array.isArray(this.listCols) || !this.listCols.length) this.listCols = [2, 6, 53, 25, 28];
    this.fmt = localStorage.getItem(this.LS.fmt) || '単票フォーム';
    if (this.FORMATS.indexOf(this.fmt) < 0) this.fmt = '単票フォーム';
    if (localStorage.getItem(this.LS.theme) === 'd') panel.setAttribute('data-theme', 'dark');

    // サイドナビ
    const snav = this.el('tmk-snav');
    snav.innerHTML = this.NAV.map(([v, i, t]) => `<a data-v="${v}"><span class="i">${i}</span>${t}</a>`).join('');
    snav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => this.go(a.dataset.v)));

    // トップバー
    const q = this.el('tmk-q');
    let timer = null;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.filtQ = q.value;
        this.page = 0;
        if (this.view !== 'list') this.go('list'); else this.renderList();
      }, 200);
    });
    this.el('tmk-kbd').textContent = navigator.platform.toLowerCase().includes('mac') ? '⌘ K' : 'Ctrl K';
    this.el('tmk-new').addEventListener('click', () => this.openChooser());
    this.el('tmk-exp').addEventListener('click', () => this.expCSV());
    this.el('tmk-imp').addEventListener('click', () => this.el('tmk-impf').click());
    this.el('tmk-impf').addEventListener('change', e => {
      if (e.target.files[0]) this.impCSV(e.target.files[0]);
      e.target.value = '';
    });
    this.el('tmk-theme').addEventListener('click', () => {
      const dark = panel.getAttribute('data-theme') !== 'dark';
      if (dark) panel.setAttribute('data-theme', 'dark'); else panel.removeAttribute('data-theme');
      localStorage.setItem(this.LS.theme, dark ? 'd' : 'l');
    });

    // オーバーレイの閉じる（背景クリック・✕）
    panel.querySelectorAll('.ov').forEach(ov => ov.addEventListener('click', e => {
      if (e.target === ov || e.target.closest('[data-tmk-ovclose]')) ov.classList.remove('on');
    }));

    // 表示列ポップ: 外側クリックで閉じる
    document.addEventListener('click', e => {
      if (this.colPopOpen && !e.target.closest('#tmk-colpop') && !e.target.closest('#tmk-colbtn')) {
        this.colPopOpen = false;
        const p = this.el('tmk-colpop');
        if (p) p.classList.remove('on');
      }
    });

    // Ctrl+K・Escape（タブ表示中のみ）
    document.addEventListener('keydown', e => {
      if (!this.isActive()) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.openCmd(); return; }
      if (e.key === 'Escape') {
        const open = panel.querySelector('.ov.on');
        if (open) { open.classList.remove('on'); return; }
      }
      const cmdOv = this.el('tmk-ov-cmd');
      if (cmdOv && cmdOv.classList.contains('on')) this.cmdKey(e);
    });
  },

  async refresh() {
    // タブ表示中はメインコンテナをフル幅化（モックのフル幅レイアウトのため）
    this.setFullBleed(true);
    if (this.rows === null) {
      const wrap = this.el('tmk-wrap');
      if (wrap) wrap.innerHTML = '<p class="mf" style="padding:20px">取引先マスタを読み込み中…</p>';
      try {
        const [companies, types, codes] = await Promise.all([
          this.fetchAll('company', '*', 'company_id'),
          this.fetchAll('company_type', 'company_id,type_code'),
          this.fetchAll('system_code', 'company_id,system,code'),
        ]);
        this.typesByCid = {};
        types.forEach(t => (this.typesByCid[t.company_id] = this.typesByCid[t.company_id] || []).push(t.type_code));
        this.codesByCid = {};
        codes.forEach(c => (this.codesByCid[c.company_id] = this.codesByCid[c.company_id] || {})[c.system] = c.code);
        // 取引先コード順（数値→英字→コード無し）で固定
        companies.sort((a, b) => {
          const ca = (this.codesByCid[a.company_id] || {}).tera || '', cb = (this.codesByCid[b.company_id] || {}).tera || '';
          const na = /^\d+$/.test(ca) ? +ca : Infinity, nb = /^\d+$/.test(cb) ? +cb : Infinity;
          return na !== nb ? na - nb : String(ca).localeCompare(String(cb));
        });
        this.rows = companies;
        const fc = this.el('tmk-foot-count');
        if (fc) fc.textContent = companies.length.toLocaleString();
      } catch (e) {
        const wrap = this.el('tmk-wrap');
        if (wrap) wrap.innerHTML = `<div class="alert warn">取引先マスタの読み込みに失敗しました: ${this.esc(String(e.message || e))}</div>`;
        return;
      }
    }
    this.go(this.view === 'detail' && !this.detail ? 'list' : this.view);
  },

  setFullBleed(on) {
    const m = document.querySelector('#main-screen main');
    if (!m) return;
    ['max-w-7xl', 'mx-auto', 'p-3', 'sm:p-6'].forEach(c => m.classList.toggle(c, !on));
  },

  // ===== ビュー切替 =====
  go(v) {
    if (v === 'new') { this.openChooser(); return; }
    // 未保存の編集・新規入力の取りこぼし防止
    if (!this.guardUnsaved()) return;
    this.view = v;
    this.markNav();
    this.el('tmk-title').textContent = this.TITLES[v] || '';
    if (v === 'list') this.renderList();
    else if (v === 'apichk') this.renderApiCheck();
    else if (v === 'sys') this.renderSysGlobal();
    else if (v === 'history') this.renderHistGlobal();
    else if (v === 'detail') this.renderDetail();
  },

  markNav() {
    const cur = this.view === 'detail' ? 'list' : (this.isNew ? 'new' : this.view);
    this.el('tmk-snav').querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.v === cur));
  },

  guardUnsaved() {
    if (this.isNew && (Object.keys(this.newVals).some(k => String(this.newVals[k]).trim() !== '') || this.newTypes.length)) {
      if (!confirm('入力中の新規登録が保存されていません。破棄して移動しますか？')) return false;
      this.isNew = false; this.newVals = {}; this.autoNew = {}; this.newTypes = []; this.newMethod = null; this.dupFrom = null; this.dupSeed = null;
    }
    const keys = Object.keys(this.pending);
    // 自動判定だけ（人は何も触っていない）なら黙って捨てる。見ただけで毎回聞かれるのを避ける
    if (keys.length && !keys.every(k => this.autoPaths[k])) {
      if (!confirm('未保存の変更があります。破棄して移動しますか？')) return false;
    }
    this.pending = {}; this.autoPaths = {}; this.autoWhy = {};
    return true;
  },

  // ===== 一覧の値解決（company全列キャッシュ＋種別＋システムコードから） =====
  fmtVal(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v === true) return 'はい';
    if (v === false) return 'いいえ';
    if (typeof v === 'number') return v.toLocaleString();
    const s = String(v);
    // 日時（#120登録日時・#121最終更新日など）はUTC保存なので日本時間に直す。日付だけの値は触らない
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return this.jstStamp(s);
    return s;
  },

  getListVal(row, f) {
    if (f.no === 1) return String(+row.company_id);                       // 取引先マスタ番号（通し番号）
    if (this.SYSTEM_BY_NO[f.no]) return (this.codesByCid[row.company_id] || {})[this.SYSTEM_BY_NO[f.no]] || null;
    if (f.col === 'company_type.type_code')
      return (this.typesByCid[row.company_id] || []).map(t => TM_META.TYPE_CODES[t] || t).join('・') || null;
    const m = (f.col || '').match(/^company\.(.+)$/);
    if (!m) return null;                                                  // 1対多テーブルの項目は一覧では出せない（詳細で確認）
    const vals = m[1].split('/').map(s => this.fmtVal(row[s.trim()])).filter(Boolean);
    return vals.length ? vals.join(' ') : null;
  },

  matches(r, q) {
    if (this.stateFilter === 'active' && r.is_suspended) return false;
    if (this.stateFilter === 'suspended' && !r.is_suspended) return false;
    if (this.stateFilter === 'temp' && (r.registration_stage !== 'temp' || r.is_suspended)) return false;
    if (!q) return true;
    const code = (this.codesByCid[r.company_id] || {}).tera || '';
    return this.norm(r.official_name).includes(q) || this.norm(r.name_kana).includes(q)
      || this.norm(r.name_half).includes(q) || this.norm(r.corporate_number).includes(q)
      || this.norm(code).includes(q) || this.norm(String(+r.company_id)).includes(q);
  },

  filtered() {
    const q = this.norm(this.filtQ);
    return (this.rows || []).filter(r => this.matches(r, q));
  },

  // ===== 会社一覧 =====
  renderList() {
    const wrap = this.el('tmk-wrap');
    if (!wrap || this.rows === null) return;
    this.el('tmk-title').textContent = '会社一覧';
    const a = this.filtered();
    const pages = Math.max(1, Math.ceil(a.length / this.PER));
    if (this.page >= pages) this.page = pages - 1;
    if (this.page < 0) this.page = 0;
    const cols = this.listCols.map(no => this.fieldByNo(no)).filter(Boolean);

    let html = `<div class="sub">棚卸で洗い出した <b>${this.rows.length.toLocaleString()}社</b>を全件収載（50社/ページ）。表示列は「表示列」で自由に選択。取引先マスタ番号＝通し番号（1〜）、コード＝teraServation／勘定奉行／Bill One 共通のシステムコード（マスタ番号とは別物）。</div>
    <div class="tool">
      <button class="btn" id="tmk-colbtn">▤ 表示列（${cols.length}）</button>
      <select class="inp" id="tmk-state" title="状態で絞り込み">
        <option value="active"${this.stateFilter === 'active' ? ' selected' : ''}>有効のみ</option>
        <option value="suspended"${this.stateFilter === 'suspended' ? ' selected' : ''}>欠番のみ</option>
        <option value="temp"${this.stateFilter === 'temp' ? ' selected' : ''}>申請中のみ</option>
        <option value="all"${this.stateFilter === 'all' ? ' selected' : ''}>すべて</option>
      </select>
      <span class="count">${a.length.toLocaleString()} 社</span>
      <div class="pop ${this.colPopOpen ? 'on' : ''}" id="tmk-colpop"></div>
    </div>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>取引先マスタ番号</th>${cols.map(f => `<th>${this.esc(f.name)}</th>`).join('')}</tr></thead><tbody>`;
    a.slice(this.page * this.PER, (this.page + 1) * this.PER).forEach(r => {
      const stateB = r.is_suspended ? '<span class="badge b-red" style="margin-left:5px">欠番</span>'
        : r.registration_stage === 'temp' ? '<span class="draftb">申請中</span>' : '';
      html += `<tr data-cid="${this.esc(r.company_id)}"><td class="num">${+r.company_id}</td>` +
        cols.map((f, i) => {
          const v = this.getListVal(r, f);
          const nm = i === 0 || f.no === 2 ? 'nm' : '';
          return `<td class="${nm}">${f.no === 2 ? this.esc(v || '') + stateB : (this.esc(v || '') || '<span class="mf">—</span>')}</td>`;
        }).join('') + '</tr>';
    });
    html += `</tbody></table></div>
    <div class="pager"><button class="btn" id="tmk-pgp" ${this.page === 0 ? 'disabled' : ''}>← 前へ</button><span class="mf tnum">${this.page + 1} / ${pages}</span><button class="btn" id="tmk-pgn" ${this.page >= pages - 1 ? 'disabled' : ''}>次へ →</button></div>`;
    wrap.innerHTML = html;

    this.el('tmk-colbtn').onclick = e => { e.stopPropagation(); this.colPopOpen = !this.colPopOpen; this.renderList(); };
    if (this.colPopOpen) this.renderColPop();
    this.el('tmk-state').onchange = e => { this.stateFilter = e.target.value; this.page = 0; this.renderList(); };
    wrap.querySelectorAll('tr[data-cid]').forEach(tr => tr.onclick = () => this.openDetail(tr.dataset.cid));
    this.el('tmk-pgp').onclick = () => { this.page--; this.renderList(); };
    this.el('tmk-pgn').onclick = () => { this.page++; this.renderList(); };
  },

  renderColPop() {
    const pop = this.el('tmk-colpop');
    if (!pop) return;
    let h = '<div style="font-size:11px;color:var(--mf);margin-bottom:6px">一覧に表示する項目を選択（会社の項目・種別・システムコードが一覧に出せます。一覧形式の項目は詳細で確認）</div>';
    TM_META.BLOCK_ORDER.forEach(b => {
      const fs = TM_META.FIELDS.filter(f => f.block === b && f.no !== 1);
      if (!fs.length) return;
      h += `<h5>${this.esc(b)}</h5>`;
      fs.forEach(f => {
        h += `<label class="ck"><input type="checkbox" data-col="${f.no}" ${this.listCols.includes(f.no) ? 'checked' : ''}>${this.esc(f.name)}</label>`;
      });
    });
    pop.innerHTML = h;
    pop.querySelectorAll('input[data-col]').forEach(cb => cb.onchange = () => {
      const no = +cb.dataset.col;
      if (cb.checked) { if (!this.listCols.includes(no)) this.listCols.push(no); }
      else this.listCols = this.listCols.filter(x => x !== no);
      this.listCols.sort((a, b) => a - b);
      localStorage.setItem(this.LS.cols, JSON.stringify(this.listCols));
      this.renderList();
    });
    pop.onclick = e => e.stopPropagation();
  },

  // ===== 詳細（ページ遷移型） =====
  async openDetail(cid) {
    if (!this.guardUnsaved()) return;
    const wrap = this.el('tmk-wrap');
    if (wrap) wrap.innerHTML = '<p class="mf" style="padding:20px">読み込み中…</p>';
    try {
      const sb = this.getClient();
      const one = t => sb.from(t).select('*').eq('company_id', cid);
      const [co, ty, sc, ba, bi, pl, cc, cl, st, cu, sp, br, hi, pt, nh, dc, cs] = await Promise.all([
        one('company'), one('company_type'), one('system_code'), one('bank_account'),
        one('company_billing'), one('permit_license'),
        sb.from('compliance_check').select('*').eq('company_id', cid).order('checked_on', { ascending: false }),
        one('credit_line'), one('company_subcontractor'), one('company_customer'), one('company_scrap'),
        sb.from('branch').select('*').eq('company_id', cid).order('branch_no'),
        sb.from('company_history').select('*').eq('company_id', cid).order('changed_at', { ascending: false }).limit(1000),
        sb.from('payment_term').select('*').eq('company_id', cid).order('priority'),
        sb.from('company_name_history').select('*').eq('company_id', cid).order('changed_on'),
        sb.from('document').select('*').eq('company_id', cid).order('document_id'),
        one('compliance_survey'),
      ]);
      const err = [co, ty, sc, ba, bi, pl, cc, cl, st, cu, sp, br, hi, pt, nh, dc, cs].find(r => r.error);
      if (err) throw new Error(err.error.message);
      this.detail = {
        company: (co.data || [])[0] || {},
        company_type: ty.data || [], system_code: sc.data || [], bank_account: ba.data || [],
        company_billing: bi.data || [], permit_license: pl.data || [],
        compliance_check: cc.data || [], credit_line: cl.data || [],
        company_subcontractor: st.data || [], company_customer: cu.data || [], company_scrap: sp.data || [],
        branch: br.data || [], company_history: hi.data || [],
        payment_term: pt.data || [], company_name_history: nh.data || [],
        document: dc.data || [], compliance_survey: cs.data || [],
      };
      this.sel = cid;
      this.dtab = 'basic';
      this.fmtFocus = 0;
      this.pending = {}; this.autoPaths = {}; this.autoWhy = {};
      this.bankEdit = null;
      this.rowEdit = null;
      this.branchEdit = null;
      this.isNew = false;
      this.enrichNotice = null;
      this.view = 'detail';
      this.markNav();
      this.applyAutoJudgeDetail();
      this.renderDetail();
      const scroller = document.scrollingElement || document.documentElement;
      scroller.scrollTop = 0;
    } catch (e) {
      if (wrap) wrap.innerHTML = `<div class="alert warn">詳細の読み込みに失敗しました: ${this.esc(String(e.message || e))}</div>`;
    }
  },

  // 項目の適用判定（モックのapplicable: 共通(*)＋種別のブロック）
  applicable(f, types) {
    if (f.types.includes('*')) return true;
    const blocks = new Set();
    (types || []).forEach(t => (TM_META.TYPE_BLOCKS[t] || []).forEach(b => blocks.add(b)));
    return blocks.has(f.block);
  },
  appFields(types) { return TM_META.FIELDS.filter(f => this.applicable(f, types)); },
  isRequired(f, types) {
    return f.must === '必須' && (f.types.includes('*') || (types || []).some(t => f.types.includes(t)));
  },

  detailTypes() {
    return ((this.detail && this.detail.company_type) || []).map(t => TM_META.TYPE_CODES[t.type_code]).filter(Boolean);
  },

  // DBの生値（表示用の resolveField と違い、加工しない）
  rawValue(f, d) {
    const m = (f.col || '').match(/^(\w+)\.([^/]+)$/);
    if (!m) return null;
    const row = m[1] === 'company' ? d.company : (d[m[1]] || [])[0];
    if (!row) return null;
    const v = row[m[2].trim()];
    return v === undefined ? null : v;
  },

  // 項目の値をDBから解決（閲覧表示用・複数行は改行）
  resolveField(f, d) {
    if (!f.col || f.col === '-.-') return null;
    if (f.no === 1) return d.company.company_id ? String(+d.company.company_id) : null;
    const m = f.col.match(/^(\w+)\.(.+)$/);
    if (!m) return null;
    const table = m[1];
    const cols = m[2].split('/').map(s => s.trim()).filter(c => c && c !== '*');
    if (table === 'system_code') {
      const sys = this.SYSTEM_BY_NO[f.no];
      const row = (d.system_code || []).find(r => r.system === sys);
      return row ? row.code : null;
    }
    if (table === 'company_type') {
      return (d.company_type || []).map(t => TM_META.TYPE_CODES[t.type_code] || t.type_code).join('・') || null;
    }
    if (table === 'permit_license') {
      const typeByNo = { 86: 'construction', 87: 'construction', 88: 'construction', 89: 'demolition', 90: 'waste', 91: 'dispatch' };
      const rows = (d.permit_license || []).filter(r => !typeByNo[f.no] || r.permit_type === typeByNo[f.no]);
      const vals = rows.map(r => cols.map(c => this.fmtVal(r[c] !== undefined ? r[c] : r.permit_number)).filter(Boolean).join(' ／ ')).filter(Boolean);
      return vals.length ? vals.join('\n') : null;
    }
    if (table === 'payment_term') {
      // 構造化列（締日/支払日/サイト）から読める要約を組む。term_code は名称・備考
      const vals = (d.payment_term || []).slice().sort((a, b) => (a.priority || 1) - (b.priority || 1))
        .map(r => this.termSummary(r)).filter(Boolean);
      return vals.length ? vals.join('\n') : null;
    }
    if (table === 'document') {
      const dt = this.DOC_BY_NO[f.no] || (f.no === 117 ? 'survey' : null);
      const vals = (d.document || []).filter(r => !dt || r.doc_type === dt)
        .map(r => [r.file_url, r.valid_until ? `（期限 ${r.valid_until}）` : ''].join('')).filter(Boolean);
      return vals.length ? vals.join('\n') : null;
    }
    if (table === 'compliance_survey' && f.no === 43) {
      // モックの仮想列 collected_on はDDLに無い＝送付日/回答日で回収状況を表す
      const r = (d.compliance_survey || [])[0];
      if (!r || (!r.sent_on && !r.answered_on)) return null;
      return [r.sent_on ? `送付 ${r.sent_on}` : null, r.answered_on ? `回答 ${r.answered_on}` : '未回答'].filter(Boolean).join(' ／ ');
    }
    let rows;
    if (table === 'company') rows = d.company ? [d.company] : [];
    else rows = d[table] || [];
    if (table === 'compliance_check') rows = rows.slice(0, 1);
    const vals = rows.map(r => cols.map(c => this.fmtVal(r[c])).filter(Boolean).join(' ／ ')).filter(Boolean);
    return vals.length ? vals.join('\n') : null;
  },

  // 編集できる項目か（1社1行テーブル・承認不要・非ロック・非JSONB・単一列）
  // フォーム内で編集できるか。承認制でも MANUAL_OK の項目（反社系）は通す。
  // 🔴isEditable() 自体は緩めない＝CSV取込の対象列判定にも使われており、
  //   承認制の項目がCSVで一括更新できるようになるのは意図しないため。
  MANUAL_TABLES: ['company', 'compliance_check'],
  isFormEditable(f) {
    if (this.isEditable(f)) return true;
    if (!this.MANUAL_OK[f.no]) return false;
    if (!f.col || f.col === '-.-' || f.col.includes('/')) return false;
    if (this.LOCKED_COLS.includes(f.col)) return false;
    if ((f.dtype || '').toUpperCase().includes('JSONB')) return false;
    return this.MANUAL_TABLES.includes(f.col.split('.')[0]);
  },

  isEditable(f) {
    if (!f.col || f.col === '-.-') return false;
    if (f.approval) return false;
    if (f.col.includes('/')) return false;
    if (this.LOCKED_COLS.includes(f.col)) return false;
    if ((f.dtype || '').toUpperCase().includes('JSONB')) return false;
    return this.EDITABLE_TABLES.includes(f.col.split('.')[0]);
  },

  // 入力文字列 → DB値（dtype文字列で判定。f.dtype でも sub.dtype でも使えるよう分離）
  normInDt(dtype, s, norm) {
    const dt = (dtype || '').toUpperCase();
    let t = String(s == null ? '' : s).trim();
    if (t === '') return null;
    if (norm === 'cid' && /^\d{1,8}$/.test(t)) t = t.padStart(8, '0');   // マスタ番号は8桁ゼロ埋めで保持
    if (dt.startsWith('BOOLEAN')) return t === 'true' || t === 'はい';
    if (/^(BIGINT|INTEGER|SMALLINT)/.test(dt)) {
      const n = Number(t.replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    return t;
  },
  normIn(f, s) { return this.normInDt(f.dtype, s); },

  inputErrorDt(dtype, s) {
    const dt = (dtype || '').toUpperCase();
    const t = String(s == null ? '' : s).trim();
    if (t === '') return null;
    if (/^(BIGINT|INTEGER|SMALLINT)/.test(dt) && !/^-?[\d,]+$/.test(t)) return '数値で入力してください';
    const m = dt.match(/^(VARCHAR|CHAR)\((\d+)\)/);
    if (m) {
      const len = [...t].length, max = +m[2];
      if (m[1] === 'CHAR' && len !== max) return `${max}桁で入力してください（現在${len}桁）`;
      if (len > max) return `${max}文字以内で入力してください（現在${len}文字）`;
    }
    return null;
  },
  inputError(f, s) { return this.inputErrorDt(f.dtype, s); },

  sameVal(a, b) {
    const n = v => (v === null || v === undefined || v === '') ? null : v;
    const x = n(a), y = n(b);
    if (x === null && y === null) return true;
    if (x === null || y === null) return false;
    return String(x) === String(y);
  },

  // ※モックの「入力元→配布先」表示（SRC/srcKey/ioPill/背景色）は 2026-08-26 坂本さん指示で廃止。
  //   設計上の取得元は各項目の f.source（メタデータ）に残っており、必要になれば再表示できる。

  // 凡例＝データの出所（値の右のバッジの読み方）。設計上の入力元凡例は廃止（坂本さん指示で整理）
  ioLegend() {
    return '<div style="font-size:11px;color:var(--mf2);margin-bottom:12px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;background:var(--muted);border:1px solid var(--border);border-radius:8px;padding:7px 12px">' +
      '<b>データの出所:</b>' +
      '<span><span class="src mig">移行</span> 棚卸2026の移行データのまま</span>' +
      '<span><span class="src edit">手入力</span> 画面・CSVで人が入力</span>' +
      '<span><span class="src api">gBizINFO API</span> 外部APIから取得（人が採用）</span>' +
      '<span><span class="src code">コード</span> 会社マスタIDの採番・各システム側のコード</span>' +
      '<span class="mf">🔒＝承認が必要な項目（右の口座カードから申請）</span></div>';
  },

  // ===== 出所バッジ  // ===== 出所バッジ＝「この値が実際どこから来たか」（坂本さん指示 2026-08-26・再改訂） =====
  // 🔴設計上の取得元（モックのsrcKey）ではなく、**実際の出所**を表示する。
  //   判定材料: company_history（項目ごとの変更記録・changed_byに経路の印）＋ data_source（作成時の経路）。
  //   現状はほぼ全て移行データ（2,563社=data_source'migration'）＝既定は「移行」で正しい（坂本さん確認済み）。
  //   履歴が付いた項目から「手入力」「gBizINFO API」等に変わっていく。

  // changed_by の文字列 → バッジ。API経路は applyCsv の sourceTag で「(gBizINFO)」の形の印が残る
  provenanceOf(changedBy) {
    const s = String(changedBy || '');
    if (/\(gBizINFO\)/i.test(s)) return ['api', 'gBizINFO API'];
    if (/\(Sansan/i.test(s)) return ['api', 'Sansan API'];
    if (/\(国税庁|\(invoice/i.test(s)) return ['api', '国税庁API'];
    if (/\(自動判定\)/.test(s)) return ['auto', '自動判定'];
    if (/migration/i.test(s)) return ['mig', '移行'];
    return ['edit', '手入力'];   // 人名（画面編集・手動CSV取込）
  },

  // 項目に対応する履歴の最新行を引く。
  //   編集パスがある項目 → 各パスの histColName（キー付き='key.col'・JSONB='col.key'）で照合
  //   それ以外（承認制・カード系）→ 従来どおり col の '/' 分解で照合
  latestHistoryFor(f, d) {
    const paths = this.fieldPaths(f);
    const cands = [];   // {table, col}
    if (f.no === 53) cands.push({ table: 'company_type', col: 'type_code' });
    if (paths.length) {
      paths.forEach(path => {
        const p = this.parsePath(path);
        if (p) cands.push({ table: p.table, col: this.histColName(p) });
      });
    } else if (!cands.length) {
      const m = (f.col || '').match(/^(\w+)\.(.+)$/);
      if (!m) return null;
      m[2].split('/').map(c => c.trim()).forEach(c => cands.push({ table: m[1], col: c }));
    }
    // company_history は changed_at 降順で取得済み → 最初に見つかった行が最新
    return (d.company_history || []).find(h =>
      cands.some(c => h.table_name === c.table && h.column_name === c.col)) || null;
  },

  srcOf(f) {
    if (f.approval) return ['lock', '🔒承認'];
    const d = this.detail;
    const pend = this.fieldPaths(f).filter(p => this.pending[p] !== undefined);
    // 自動判定で入った（人が触っていない）未保存値は「自動判定」と見せる。人が触れば「編集中」
    if (pend.length) return pend.every(p => this.autoPaths[p]) ? ['auto', '自動判定'] : ['edit', '編集中'];
    if (f.no === 1) return ['code', 'コード'];
    const v = this.fieldDisplay(f, d);
    if (v === null || String(v).trim() === '') return ['none', '—'];
    // 値がある → 実際の出所を履歴から判定。履歴が無ければ移行データのまま
    const h = this.latestHistoryFor(f, d);
    if (h) return this.provenanceOf(h.changed_by);
    if (this.SYSTEM_BY_NO[f.no]) return ['code', 'コード'];   // 移行で入った各システムコード
    return ['mig', (d.company.data_source || '') === 'migration' ? '移行' : '手入力'];
  },

  // 項目の表示値（読み取り用）。編集パスがある項目は各パスの生値・無ければ resolveField
  fieldDisplay(f, d) {
    const plan = this.editPlan(f);
    if (plan && plan.kind === 'single') return this.fmtVal(this.rawByPath(plan.path, d));
    if (plan && plan.kind === 'multi') {
      const vals = plan.subs.map(s => this.fmtVal(this.rawByPath(s.path, d))).filter(Boolean);
      return vals.length ? vals.join(' ／ ') : null;
    }
    return this.resolveField(f, d);
  },

  // ===== AIチェック（モックのロジック・実データ） =====
  aiChecks(getv, types) {
    const out = [];
    const hj = getv(this.fieldByNo(6)) || '';
    if (!String(hj).trim()) out.push(['warn', '法人番号が未入力']);
    else if (!/^\d{13}$/.test(String(hj))) out.push(['err', '法人番号が13桁でない（' + String(hj).length + '文字）']);
    else out.push(['ok', '法人番号OK（T' + hj + ' 生成可）']);
    if (!String(getv(this.fieldByNo(7)) || '').trim()) out.push(['warn', '代表者名が未入力']);
    const missing = TM_META.FIELDS.filter(f => this.isRequired(f, types) && !String(getv(f) || '').trim());
    missing.slice(0, 8).forEach(f => out.push(['warn', '必須未入力: ' + f.name]));
    if (missing.length > 8) out.push(['warn', `…ほか必須未入力 ${missing.length - 8}件`]);
    if (!out.some(x => x[0] !== 'ok')) out.push(['ok', '点検OK']);
    return out;
  },
  aiHtml(getv, types) {
    return this.aiChecks(getv, types).map(([k, m]) => `<div class="airow ${k}">${k === 'ok' ? '✓' : k === 'err' ? '✕' : '⚠'} ${this.esc(m)}</div>`).join('');
  },

  // ===== フィールドレンダラ（モックの5形式・共有） =====
  // api = {
  //   get(path)          → 入力欄の現在値（未保存の編集を含む・文字列）
  //   set(f, path, val)  → 編集の反映（pending / newVals へ）
  //   val(f)             → 読み取り表示の文字列（編集不可・カード系の項目）
  //   srcOf(f)           → 出所バッジ [cls, label]
  //   types()            → 現在の種別ラベル配列（#53の表示に使う）
  //   setTypes(codes)    → #53チェックボックスの反映。新規画面は種別チップで選ぶため null
  // }
  // 🔴背景色（入力元の色分け）は廃止（坂本さん指示 2026-08-26）。
  //   色は「設計上の取得元」を表していたが、実際の出所は右の出所バッジが正となったため、
  //   二重の表現をやめて入力欄は白に統一する。
  inputByDtype(path, dtype, val, opts, off) {
    const dt = (dtype || '').toUpperCase();
    const p = this.esc(path);
    const v = val === null || val === undefined ? '' : String(val);
    const o = opts || {};
    // 連動グレーアウト（他項目の値で入力できない）。値は残したまま操作だけ止める
    const dis = off ? ' disabled' : '';
    if (dt.startsWith('BOOLEAN')) {
      const cur = v === 'true' || v === 'はい' ? 'true' : (v === 'false' || v === 'いいえ' ? 'false' : '');
      return `<select data-path="${p}"${dis}>` +
        `<option value=""${cur === '' ? ' selected' : ''}>（未設定）</option>` +
        `<option value="true"${cur === 'true' ? ' selected' : ''}>はい</option>` +
        `<option value="false"${cur === 'false' ? ' selected' : ''}>いいえ</option></select>`;
    }
    if (dt.startsWith('DATE') && !dt.startsWith('DATETIME')) return `<input type="date" data-path="${p}" value="${this.esc(v.slice(0, 10))}"${dis}>`;
    if (o.options) {
      // 🔴選択肢に無い既存値は必ず option として残す。消すと編集した瞬間に元の値が失われる
      //   （移行データには不正値も混じっている＝見えるようにして人が直せる状態にする）
      const lbl = x => (o.optionLabels && o.optionLabels[x]) || x;
      const unknown = v !== '' && o.options.indexOf(v) < 0;
      return `<select data-path="${p}"${dis}><option value=""${v === '' ? ' selected' : ''}>（未設定）</option>` +
        (unknown ? `<option value="${this.esc(v)}" selected>${this.esc(v)}（現在値・選択肢外）</option>` : '') +
        o.options.map(x => `<option value="${this.esc(x)}"${v === x ? ' selected' : ''}>${this.esc(lbl(x))}</option>`).join('') + '</select>';
    }
    const m = dt.match(/^(?:VARCHAR|CHAR)\((\d+)\)/);
    return `<input type="text" data-path="${p}" value="${this.esc(v)}" ${m ? `maxlength="${m[1]}"` : ''}${dis}>`;
  },
  // 🔴DBの日時列は TIMESTAMP（タイムゾーンなし）で、Supabaseの now() は **UTC** で入る。
  //   そのまま出すと9時間前にずれる（2026-08-28に坂本さん指摘→実測で確認）ため、
  //   UTCとみなして日本時間に直して表示する。
  //   将来 timestamptz に移行したらオフセット付きで来るので、その場合は素直に解釈する。
  jstStamp(v) {
    const raw = String(v === null || v === undefined ? '' : v).trim();
    if (!raw) return '';
    const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
    const d = new Date(hasTz ? raw : raw.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return raw.replace('T', ' ').slice(0, 16);
    const p = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  },

  roInput(text) {
    return `<input type="text" value="${this.esc(text === null || text === undefined ? '' : String(text))}" disabled>`;
  },

  // 🔴詳細を開いた時点で、空欄の #14/#15 に判定値を流し込む（2026-08-28 坂本さん指示＝ボタンを押させない）。
  //   ・空欄のときだけ＝人が入れた値・移行値は絶対に上書きしない
  //   ・未保存の変更として積むので、保存を押せば履歴に「自動判定」の印つきで残る
  //   ・人が触っていない自動判定だけの状態なら、離脱時に確認せず黙って捨てる（guardUnsaved）
  applyAutoJudgeDetail() {
    Object.keys(this.AUTO_BY_NO).forEach(noStr => {
      const no = Number(noStr);
      const f = this.fieldByNo(no);
      const plan = f && this.editPlan(f);
      if (!plan || !plan.path) return;
      if (String(this.editValOf(plan.path) || '').trim() !== '') return;   // 既に値がある＝触らない
      const j = this.autoJudge(no, p => this.editValOf(p));
      if (!j) return;
      this.pending[plan.path] = j.val;
      this.autoPaths[plan.path] = true;
      this.autoWhy[plan.path] = j.why;
    });
  },

  // #86 29業種チェックグリッド。値は hidden input（data-path）に「略号=般;…」で持ち、
  // チップ操作のたびに再直列化して input イベントを発火＝既存の pending/保存/出所バッジ機構に乗る
  k29ControlHtml(path, val) {
    const st = this.k29Parse(val);
    const v = val === null || val === undefined ? '' : String(val);
    const cells = this.K29.map(k => {
      const cur = st.map[k.t] || '';
      return `<div class="k29c${cur ? ' sel' : ''}" data-k29t="${this.esc(k.t)}" title="${this.esc(k.full)}">` +
        `<span class="k29n">${this.esc(k.n)}</span>` +
        ['般', '特'].map(x => `<button type="button" class="k29b${cur === x ? ' on' : ''}" data-k29v="${x}">${x}</button>`).join('') +
        '</div>';
    }).join('');
    const notes = [];
    if (Object.keys(st.legacy).length) notes.push('移行の旧列（とび土工/解体）は「と」「解」と連動して保存されます');
    if (st.extra.length) notes.push(`選択肢外の値（そのまま保持）: ${this.esc(st.extra.join(';'))}`);
    return `<div class="k29" data-k29-legacy="${this.esc(JSON.stringify(st.legacy))}" data-k29-extra="${this.esc(JSON.stringify(st.extra))}">` +
      `<input type="hidden" data-path="${this.esc(path)}" value="${this.esc(v)}">` +
      `<div class="k29g">${cells}</div>` +
      `<div class="k29f"><span class="k29cnt"></span>${notes.length ? `<span class="k29lg">${notes.join(' ／ ')}</span>` : ''}</div></div>`;
  },

  // 項目の値エリア（編集計画に応じて出し分け）
  fieldControl(f, api) {
    const plan = this.editPlan(f);
    if (!plan) return this.roInput(api.val(f));
    if (plan.kind === 'card') return this.roInput(api.val(f)) + `<div class="mf subnote">${this.esc(plan.note)}</div>`;
    if (plan.kind === 'single') {
      const off = this.linkedOff(f, api);
      const inp = this.inputByDtype(plan.path, plan.dtype, api.get(plan.path),
        plan.options ? { options: plan.options, optionLabels: plan.optionLabels } : null, off);
      // 自動判定の説明は出所バッジ「自動判定」だけでよい（坂本さん指示 2026-08-28）
      return off ? inp + `<div class="mf subnote">${this.esc(off.why)}</div>` : inp;
    }
    if (plan.kind === 'kyoka29') return this.k29ControlHtml(plan.path, api.get(plan.path));
    if (plan.kind === 'multi') {
      return '<div class="subs">' + plan.subs.map(s => {
        const opts = s.optionsFrom ? { options: this[s.optionsFrom] } : {};
        const gen = s.gen ? `<button type="button" class="btn btn-sm sgen" data-gen="${this.esc(s.gen)}" data-gtarget="${this.esc(s.path)}" title="自動生成した値を入れます（手直しできます）">⚙ ${this.esc(s.genLabel)}</button>` : '';
        return `<div class="subrow"><span class="sublbl">${this.esc(s.label)}</span>${this.inputByDtype(s.path, s.dtype, api.get(s.path), opts)}${gen}</div>`;
      }).join('') + '</div>';
    }
    if (plan.kind === 'type') {
      if (!api.setTypes) return this.roInput((api.types() || []).join('・')) + '<div class="mf subnote">上の「取引先種別」チップで選びます</div>';
      const cur = api.types() || [];
      return '<div class="typeck">' + TM_META.TYPES.map(t => {
        const code = Object.keys(TM_META.TYPE_CODES).find(c => TM_META.TYPE_CODES[c] === t);
        return `<label class="ck"><input type="checkbox" data-tmk-type="${this.esc(code)}" ${cur.includes(t) ? 'checked' : ''}>${this.esc(t)}</label>`;
      }).join('') + '</div><div class="mf subnote">外した種別の入力値は消えませんが、画面に表示されなくなります（保存で確定）</div>';
    }
    return this.roInput(api.val(f));
  },

  renderFieldsGeneric(host, fields, api) {
    const blocks = [];
    fields.forEach(f => { if (!blocks.includes(f.block)) blocks.push(f.block); });
    const inputFor = f => {
      const [sc, sl] = api.srcOf(f);
      return `<div class="row">${this.fieldControl(f, api)}<span class="src ${sc}" data-src="${this.esc(f.col)}">${sl}</span></div>`;
    };
    // 項目名の横は 必須マークのみ。設計上の「入力元→配布先」タグ(ioPill)は撤去
    //（実際の出所は値の右のバッジが示す。二重表示は混乱の元＝坂本さん指示で整理）
    const ff = f => `<div class="ff"><label>${this.esc(f.name)}${f.must === '必須' ? '<span class="req">*</span>' : ''}</label>${inputFor(f)}</div>`;
    let html = this.fmt === 'フォーカス' ? '' : this.ioLegend();
    if (this.fmt === '単票フォーム' || this.fmt === '2カラム') {
      const grid = this.fmt === '2カラム' ? 'fgrid2' : 'fgrid1';
      blocks.forEach(b => {
        html += `<div class="blkh">${this.esc(b)}</div><div class="${grid}">` + fields.filter(f => f.block === b).map(ff).join('') + '</div>';
      });
    } else if (this.fmt === 'カード') {
      html += '<div class="cards">' + blocks.map(b => `<div class="fcard"><h4>${this.esc(b)}</h4>` + fields.filter(f => f.block === b).map(ff).join('') + '</div>').join('') + '</div>';
    } else if (this.fmt === 'Excel風グリッド') {
      html += '<div class="tblwrap"><table class="xl"><thead><tr><th>項目</th><th>値</th><th style="width:74px;text-align:center">出所</th></tr></thead><tbody>' +
        fields.map(f => {
          const [sc, sl] = api.srcOf(f);
          return `<tr><td class="lbl"><span class="no">${f.no}</span>${this.esc(f.name)}${f.must === '必須' ? ' <span style="color:var(--accent)">*</span>' : ''}</td>` +
            `<td>${this.fieldControl(f, api)}</td>` +
            `<td class="sc"><span class="src ${sc}" data-src="${this.esc(f.col)}">${sl}</span></td></tr>`;
        }).join('') + '</tbody></table></div>';
    } else if (this.fmt === 'フォーカス') {
      if (this.fmtFocus >= fields.length) this.fmtFocus = fields.length - 1;
      if (this.fmtFocus < 0) this.fmtFocus = 0;
      const f = fields[this.fmtFocus];
      const [sc, sl] = api.srcOf(f);
      html += `<div class="focus"><div class="fno">${this.esc(f.block)}</div><div class="flabel">${this.esc(f.name)}${f.must === '必須' ? ' <span style="color:var(--accent)">*</span>' : ''} <span class="src ${sc}" data-src="${this.esc(f.col)}" style="vertical-align:middle">${sl}</span></div>` +
        this.fieldControl(f, api) +
        `<div class="navr"><button class="btn" id="tmk-fprev" ${this.fmtFocus === 0 ? 'disabled' : ''}>← 前</button><span class="prog">${this.fmtFocus + 1} / ${fields.length}</span><button class="btn btn-primary" id="tmk-fnext">${this.fmtFocus === fields.length - 1 ? '完了' : '次 →'}</button></div>` +
        '<div class="mf" style="font-size:11px;margin-top:8px">Enterで次へ。1項目ずつ集中して入力できます。</div></div>';
    }
    host.innerHTML = html;
    this.wireFieldInputs(host, fields, api);
    if (this.fmt === 'フォーカス') {
      const fi = host.querySelector('[data-path]');
      if (fi) fi.focus();
      const go = d => { this.fmtFocus += d; if (this.fmtFocus < 0) this.fmtFocus = 0; if (this.fmtFocus >= fields.length) { this.fmtFocus = fields.length - 1; this.toast('最後の項目です'); } this.renderFieldsGeneric(host, fields, api); };
      const fp = host.querySelector('#tmk-fprev'), fn = host.querySelector('#tmk-fnext');
      if (fp) fp.onclick = () => go(-1);
      if (fn) fn.onclick = () => go(1);
      if (fi) fi.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(1); } });
    }
  },

  // 入力欄の配線（パス方式）。data-path=編集値・data-gen=自動生成・data-tmk-type=種別チェック
  wireFieldInputs(host, fields, api) {
    const ownerOf = {};
    fields.forEach(f => this.fieldPaths(f).forEach(p => { ownerOf[p] = f; }));
    const refreshBadge = f => {
      const badge = host.querySelector(`.src[data-src="${CSS.escape(f.col)}"]`);
      if (badge) { const [sc, sl] = api.srcOf(f); badge.className = 'src ' + sc; badge.textContent = sl; }
    };
    // 連動グレーアウトの反映。再描画せずDOMだけ触る（入力中のフォーカスを奪わないため）
    const syncLinked = () => {
      fields.forEach(f => {
        if (!this.LINKED_DISABLE[f.no]) return;
        const plan = this.editPlan(f);
        if (!plan || plan.kind !== 'single') return;
        const el = host.querySelector(`[data-path="${CSS.escape(plan.path)}"]`);
        if (!el) return;
        const off = this.linkedOff(f, api);
        if (!!el.disabled === !!off) return;                 // 変化なし
        el.disabled = !!off;
        if (off) {
          // 入力できない欄の未保存の編集は取り消す（保存に乗せない）。保存済みの値は消さない。
          // 新規登録フォームには「保存済みの値」が無いので空に戻す
          const back = this.isNew ? '' : (this.editValOf(plan.path) || '');
          api.set(f, plan.path, back);
          el.value = back;
        }
        refreshBadge(f);
        const row = el.closest('.ff') || el.parentElement;
        const note = row && row.querySelector('.subnote');
        if (off && !note && row) {
          const dv = document.createElement('div');
          dv.className = 'mf subnote';
          dv.textContent = off.why;
          (el.parentElement || row).appendChild(dv);
        } else if (!off && note) { note.remove(); }
      });
    };

    host.querySelectorAll('[data-path]').forEach(inp => {
      const f = ownerOf[inp.dataset.path];
      if (!f) return;
      const handler = () => {
        api.set(f, inp.dataset.path, inp.value); refreshBadge(f);
        syncLinked();                       // 連動でグレーになる欄をその場で切り替える
      };
      inp.addEventListener('input', handler);
      if (inp.tagName === 'SELECT') inp.addEventListener('change', handler);
      if (this.fmt === 'Excel風グリッド') inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const rows = [...host.querySelectorAll('[data-path]')];
          const i = rows.indexOf(inp);
          const nx = rows[e.key === 'ArrowUp' ? i - 1 : i + 1];
          if (nx) { e.preventDefault(); nx.focus(); if (nx.setSelectionRange) nx.setSelectionRange(nx.value.length, nx.value.length); }
        }
      });
    });
    // 自動生成: 半角カナ=全角カナから機械変換（99.2%一致を実測済み）・半角社名=正式社名から候補
    host.querySelectorAll('[data-gen]').forEach(btn => {
      btn.onclick = () => {
        const targetPath = btn.dataset.gtarget;
        const f = ownerOf[targetPath];
        let out;
        if (btn.dataset.gen === 'searchName' || btn.dataset.gen === 'searchRep') {
          const srcPath = btn.dataset.gen === 'searchName' ? 'company.official_name' : 'company.representative_name';
          let src = api.get(srcPath);
          if (!String(src || '').trim() && this.detail && this.detail.company) {
            src = this.detail.company[srcPath.replace('company.', '')];
          }
          if (!String(src || '').trim()) { this.toast(btn.dataset.gen === 'searchName' ? '正式社名が空です' : '代表者名が空です'); return; }
          out = String(src).trim();
        } else if (btn.dataset.gen === 'halfKana') {
          const src = api.get('company.name_kana');
          if (!String(src || '').trim()) { this.toast('先に全角カナを入れてください'); return; }
          out = this.toHalfKana(src);
        } else {
          let src = api.get('company.official_name');
          if (!String(src || '').trim() && this.detail && this.detail.company) src = this.detail.company.official_name;
          if (!String(src || '').trim()) { this.toast('正式社名が空です'); return; }
          out = this.genNameHalf(src);
        }
        const inp = host.querySelector(`[data-path="${CSS.escape(targetPath)}"]`);
        if (inp) inp.value = out;
        if (f) { api.set(f, targetPath, out); refreshBadge(f); }
      };
    });
    host.querySelectorAll('[data-tmk-type]').forEach(cb => {
      cb.addEventListener('change', () => {
        const codes = [...host.querySelectorAll('[data-tmk-type]')].filter(x => x.checked).map(x => x.dataset.tmkType);
        if (api.setTypes) api.setTypes(codes);
        const f = fields.find(x => x.no === 53);
        if (f) refreshBadge(f);
      });
    });
    // #86 29業種チェックグリッド（般/特チップ。同じチップ再クリックで解除）
    host.querySelectorAll('.k29').forEach(box => {
      const inp = box.querySelector('input[data-path]');
      const count = () => {
        const n = box.querySelectorAll('.k29b.on').length;
        const c = box.querySelector('.k29cnt');
        if (c) c.textContent = n ? `選択中: ${n}業種` : '未選択';
      };
      box.querySelectorAll('.k29b').forEach(b => b.addEventListener('click', () => {
        const was = b.classList.contains('on');
        const cell = b.closest('.k29c');
        cell.querySelectorAll('.k29b').forEach(x => x.classList.remove('on'));
        if (!was) b.classList.add('on');
        const map = {};
        box.querySelectorAll('.k29c').forEach(c => {
          const on = c.querySelector('.k29b.on');
          c.classList.toggle('sel', !!on);
          if (on) map[c.dataset.k29t] = on.dataset.k29v;
        });
        let legacy = {}, extra = [];
        try { legacy = JSON.parse(box.dataset.k29Legacy || '{}'); extra = JSON.parse(box.dataset.k29Extra || '[]'); } catch (e) { /* 属性破損時は空扱い */ }
        inp.value = this.k29Serialize(map, legacy, extra);
        count();
        inp.dispatchEvent(new Event('input'));   // 既存の[data-path]ハンドラ（api.set→pending）に乗せる
      }));
      count();
    });
  },

  fmtBarHtml() {
    return `<div class="fmtbar"><span class="lb">入力形式</span>${this.FORMATS.map(f => `<button class="seg ${f === this.fmt ? 'on' : ''}" data-fmt="${this.esc(f)}">${this.esc(f)}</button>`).join('')}<span class="fmthint">好みの形式で入力できます（選択は保存されます）</span></div>`;
  },
  wireFmtBar(host, rerender) {
    host.querySelectorAll('.seg[data-fmt]').forEach(s => s.onclick = () => {
      this.fmt = s.dataset.fmt;
      localStorage.setItem(this.LS.fmt, this.fmt);
      this.fmtFocus = 0;
      host.querySelectorAll('.seg').forEach(x => x.classList.toggle('on', x.dataset.fmt === this.fmt));
      rerender();
    });
  },

  // ===== 詳細ページ本体 =====
  renderDetail() {
    const wrap = this.el('tmk-wrap');
    const d = this.detail;
    if (!wrap || !d) { this.go('list'); return; }
    const c = d.company;
    this.el('tmk-title').textContent = c.official_name || '';
    const code = ((d.system_code || []).find(r => r.system === 'tera') || {}).code || '';
    const me = this.whoAmI();

    const stateB = c.is_suspended
      ? `<span class="badge b-red" style="margin-left:8px;vertical-align:middle">欠番${c.suspend_reason ? '：' + this.esc(c.suspend_reason) : ''}</span>`
      : c.registration_stage === 'temp'
      ? '<span class="badge b-amber" style="margin-left:8px;vertical-align:middle">申請中（承認待ち）</span>'
      : '<span class="badge b-green" style="margin-left:8px;vertical-align:middle">有効</span>';
    const approveBtn = c.registration_stage === 'temp'
      ? ((c.created_by || null) !== me
        ? '<button class="btn btn-success btn-sm" id="tmk-approve-reg" style="margin-left:10px">✓ 登録を承認</button>'
        : '<span class="mf" style="margin-left:10px;font-size:11px" title="登録した本人は承認できません">本人以外の承認待ち</span>')
      : '';

    wrap.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="tmk-back" style="margin-bottom:10px">← 一覧へ戻る</button>
    <div class="grid2">
     <div>
      <div class="dhead">
        <h2>${this.esc(c.official_name || '')}</h2>${stateB}${approveBtn}
        <button class="btn btn-sm" id="tmk-dup" style="float:right" title="この会社の枠組みを複製して新規登録">⧉ 複製</button>
        <div class="codes"><span>取引先マスタ番号 <b>${+c.company_id || '—'}</b></span>
          <span>取引先コード <b>${this.esc(code || '未採番')}</b> <span class="mf">（teraServation・勘定奉行オンプレで共通。各システムへは手動転記）</span></span>
          <span>データ出所 <b>${this.esc(c.data_source === 'migration' ? '移行(棚卸2026)' : (this.NEW_METHOD_LABELS[c.data_source] || c.data_source || '—'))}</b></span></div>
      </div>
      <div class="tabbar">
        <button class="tb ${this.dtab === 'basic' ? 'on' : ''}" data-t="basic">基本情報（項目）</button>
        <button class="tb ${this.dtab === 'tx' ? 'on' : ''}" data-t="tx">取引履歴</button>
        <button class="tb ${this.dtab === 'box' ? 'on' : ''}" data-t="box">Box資料</button>
        <button class="tb ${this.dtab === 'hist' ? 'on' : ''}" data-t="hist">変更履歴</button>
      </div>
      <div id="tmk-dbody"></div>
     </div>
     <div>
      <div class="sec" style="position:sticky;top:64px"><h3>🤖 AIチェック</h3><div id="tmk-aiside"></div></div>
      <div class="sec"><h3>支店・枝番管理</h3><div class="mf" style="font-size:11px;margin-bottom:8px">本社=枝番000。支店は枝番を自動連番（マスタ番号‑枝番）。⚙で住所・電話も入れられます</div>
        <div id="tmk-branches"></div>
        <button class="btn btn-sm" id="tmk-addbranch" style="margin-top:6px">＋ 支店を追加</button></div>
      <div class="sec"><h3>振込先口座 <span class="badge b-amber">承認フロー</span></h3>
        <div class="mf" style="font-size:11px;margin-bottom:8px">変更・登録すると未承認になり、<b>本人以外</b>の admin/accounting の承認で有効になります（詐欺対策）</div>
        <div id="tmk-banks"></div></div>
      <div class="sec"><h3>支払条件</h3>
        <div class="mf" style="font-size:11px;margin-bottom:8px">発注分類区分ごとに複数持てます。締日・支払日は「月末=31」で入力</div>
        <div id="tmk-rc-payment_term"></div></div>
      <div class="sec"><h3>旧社名・社名変更履歴</h3><div id="tmk-rc-company_name_history"></div></div>
      <div class="sec"><h3>Boxの原本</h3>
        <div class="mf" style="font-size:11px;margin-bottom:8px">取引口座申請書・履歴事項全部証明書・建設業許可証などの原本は
          経理の <b>${this.esc(this.BOX_FOLDER_PATH)}</b> にあります</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" id="tmk-goto-box">📁 Box資料タブを開く</button>
          <a class="btn btn-sm" href="${this.boxFolderUrl()}" target="_blank" rel="noopener">↗ Boxで開く</a>
        </div></div>
      <div class="sec"><h3>文書（Boxリンク）</h3>
        <div class="mf" style="font-size:11px;margin-bottom:8px">許可証PDF・契約書PDF・名刺画像のBox共有リンクを登録します（ファイル本体はBoxに置く）</div>
        <div id="tmk-rc-document"></div></div>
      <div class="sec"><h3>外部APIで補完</h3>
        <div class="mf" style="font-size:11px;margin-bottom:8px">法人番号（国税庁・gBizINFO）／社名（Sansan名刺）で照会します。<b>空欄だけ</b>を候補として提示し、既存の値は上書きしません</div>
        <button class="btn btn-sm" id="tmk-enrich-run" ${(c.corporate_number || c.official_name) ? '' : 'disabled title="法人番号も社名も無いため照会できません"'}>🔎 APIで補完</button>
        <div id="tmk-enrich-result" style="margin-top:8px"></div></div>
      <div class="sec"><h3>システム連携状況</h3><div class="mf" style="font-size:11px;margin-bottom:8px">人は編集不可・システム側の状態</div>${this.slinkHtml()}</div>
     </div>
    </div>`;

    this.el('tmk-back').onclick = () => this.go('list');
    this.el('tmk-dup').onclick = () => this.startDup();
    const ap = this.el('tmk-approve-reg');
    if (ap) ap.onclick = () => this.approveRegistration();
    wrap.querySelectorAll('.tb').forEach(b => b.onclick = () => { this.dtab = b.dataset.t; this.renderDbody(); });
    this.el('tmk-addbranch').onclick = () => this.addBranch();
    const er = this.el('tmk-enrich-run');
    if (er) er.onclick = () => this.runEnrich();
    const gb = this.el('tmk-goto-box');
    if (gb) gb.onclick = () => { this.dtab = 'box'; this.renderDbody(); };
    this.renderDbody();
    this.renderBranches();
    this.renderBanks();
    this.renderRowCards();
    this.refreshAiSide();
  },

  refreshAiSide() {
    const a = this.el('tmk-aiside');
    if (!a || !this.detail) return;
    a.innerHTML = this.aiHtml(f => this.fieldValueWithPending(f), this.detailTypes());
  },

  // 項目の値（未保存の編集を重ねた状態）。AIチェック・必須判定に使う
  fieldValueWithPending(f) {
    if (f.no === 53) return this.pendingTypeCodes().map(c => TM_META.TYPE_CODES[c]).filter(Boolean).join('・');
    const paths = this.fieldPaths(f);
    if (paths.length) {
      const vals = paths.map(p => this.pending[p] !== undefined ? this.pending[p] : this.editValOf(p))
        .filter(v => String(v).trim() !== '');
      return vals.length ? vals.join(' ／ ') : (this.fieldDisplay(f, this.detail) || '');
    }
    return this.fieldDisplay(f, this.detail) || '';
  },

  // パス → {f, dtype, label, norm}（保存時の検証・履歴ラベルに使う）
  pathMeta(path) {
    for (const f of TM_META.FIELDS) {
      const plan = this.editPlan(f);
      if (!plan) continue;
      if ((plan.kind === 'single' || plan.kind === 'kyoka29') && plan.path === path) return { f, dtype: plan.dtype, label: f.name };
      if (plan.kind === 'multi') {
        const s = plan.subs.find(x => x.path === path);
        if (s) return { f, dtype: s.dtype, label: `${f.name}（${s.label}）`, norm: s.norm };
      }
    }
    return null;
  },

  // この会社が各システムのコードを持っているか。「連携済」ではなく実態（手動転記）で表す。
  slinkHtml() {
    const d = this.detail;
    const codes = {};
    (d.system_code || []).forEach(r => codes[r.system] = r.code);
    const sansanOn = !!d.company.sansan_soc;
    let html = `<div class="slink"><span class="nm2">Sansan（名刺）</span>${sansanOn ? '<span class="badge b-sansan">取得あり</span>' : '<span class="badge b-slate">未接続</span>'}</div>`;
    html += this.SYSLINK.map(s => {
      const code = codes[s.sys];
      const badge = code
        ? `<span class="tnum mf" style="font-size:11px">${this.esc(code)}</span><span class="badge b-amber">手動</span>`
        : `<span class="badge b-slate">${s.mode === 'manual' ? '未採番' : '未接続'}</span>`;
      return `<div class="slink"><span class="nm2">${this.esc(s.name)}</span>${badge}</div>`;
    }).join('');
    return html;
  },

  renderDbody() {
    const wrap = this.el('tmk-wrap');
    wrap.querySelectorAll('.tb').forEach(b => b.classList.toggle('on', b.dataset.t === this.dtab));
    const b = this.el('tmk-dbody');
    if (!b) return;
    if (this.dtab === 'tx') return this.renderTx(b);
    if (this.dtab === 'hist') return this.renderHistTab(b);
    if (this.dtab === 'box') return this.renderBoxTab(b);
    // 基本情報: 入力形式バー＋フィールド（常時編集可・未保存バーで確定）
    b.innerHTML = this.fmtBarHtml() + '<div id="tmk-fields"></div><div id="tmk-savebar"></div>';
    const host = this.el('tmk-fields');
    const render = () => this.renderFieldsGeneric(host, this.appFields(this.detailTypes()), this.detailApi());
    this.wireFmtBar(b, render);
    render();
    this.renderSavebar();
  },

  // パスの現在値を入力欄用の文字列にする
  editValOf(path) {
    const v = this.rawByPath(path, this.detail);
    return v === null || v === undefined ? '' : (v === true ? 'true' : v === false ? 'false' : String(v));
  },
  // 保存済みの種別コード（ソート済み）と、未保存編集を含む種別コード
  savedTypeCodes() { return ((this.detail && this.detail.company_type) || []).map(t => t.type_code).sort(); },
  pendingTypeCodes() {
    if (this.pending['company_type'] !== undefined) { try { return JSON.parse(this.pending['company_type']); } catch (e) { /* fallthrough */ } }
    return this.savedTypeCodes();
  },

  // 詳細画面の編集api（pending連動）
  detailApi() {
    return {
      get: p => this.pending[p] !== undefined ? this.pending[p] : this.editValOf(p),
      set: (f, p, val) => {
        // 自動判定ボタン経由なら印を付ける。人が触ったら印を外す＝出所が「手入力」に戻る
        if (this._autoSet) this.autoPaths[p] = true;
        else { delete this.autoPaths[p]; delete this.autoWhy[p]; }
        if (String(val) === this.editValOf(p)) delete this.pending[p];
        else this.pending[p] = val;
        this.renderSavebar();
        this.refreshAiSide();
      },
      val: f => this.fieldDisplay(f, this.detail),
      srcOf: f => this.srcOf(f),
      types: () => this.pendingTypeCodes().map(c => TM_META.TYPE_CODES[c]).filter(Boolean),
      setTypes: codes => {
        const next = codes.slice().sort();
        if (JSON.stringify(next) === JSON.stringify(this.savedTypeCodes())) delete this.pending['company_type'];
        else this.pending['company_type'] = JSON.stringify(next);
        this.renderSavebar();
      },
    };
  },

  renderSavebar() {
    const bar = this.el('tmk-savebar');
    if (!bar) return;
    const keys = Object.keys(this.pending);
    const n = keys.length;
    if (!n) { bar.innerHTML = ''; return; }
    const auto = keys.filter(k => this.autoPaths[k]).length;
    const note = auto === n ? `自動判定で入れた${auto}件です。保存すると確定します（違っていれば選び直してください）`
      : auto ? `うち自動判定 ${auto}件。変わった項目だけが変更履歴に記録されます`
        : '変わった項目だけが変更履歴に記録されます';
    bar.innerHTML = `<div class="savebar"><span>未保存の変更 <b>${n}件</b>（${note}）</span><span style="flex:1"></span>` +
      `<button class="btn" id="tmk-discard" ${this.busy ? 'disabled' : ''}>破棄</button>` +
      `<button class="btn btn-primary" id="tmk-save" ${this.busy ? 'disabled' : ''}>${this.busy ? '保存中…' : '💾 保存'}</button></div>`;
    this.el('tmk-discard').onclick = () => {
      if (!confirm('未保存の変更を破棄しますか？')) return;
      this.pending = {}; this.autoPaths = {}; this.autoWhy = {};
      this.renderDbody();
      this.refreshAiSide();
    };
    this.el('tmk-save').onclick = () => this.savePending();
  },

  // 保存: 変更履歴を先に書き、本体更新が失敗したらその分の履歴を取り消す（段階Aの確定パターン）
  // 2026-08-26拡張: パス方式（キー付きテーブル・JSONB・複数欄）と種別フラグを同じ経路で保存する
  async savePending() {
    if (this.busy || !this.detail) return;
    const d = this.detail;
    const cid = d.company.company_id;
    const types = this.detailTypes();
    const errs = [];
    const changes = [];   // {path, p, f, label, oldV, newV, group}

    // ① 種別フラグ（擬似パス company_type）
    let typeChange = null;
    if (this.pending['company_type'] !== undefined) {
      const now = this.savedTypeCodes();
      const next = this.pendingTypeCodes();
      if (!next.length) { alert('取引先種別は1つ以上必要です。'); return; }
      const add = next.filter(c => !now.includes(c));
      const rem = now.filter(c => !next.includes(c));
      if (add.length || rem.length) {
        const lbl = cs => cs.map(c => TM_META.TYPE_CODES[c] || c).join('・');
        typeChange = { add, rem, oldL: lbl(now), newL: lbl(next), next };
      }
    }

    // ② パスの変更を集める
    Object.keys(this.pending).forEach(path => {
      if (path === 'company_type') return;
      const meta = this.pathMeta(path);
      if (!meta) return;
      const p = this.parsePath(path);
      const msg = this.inputErrorDt(meta.dtype, this.pending[path]);
      if (msg) { errs.push(`・${meta.label}: ${msg}`); return; }
      const oldV = this.rawByPath(path, d);
      const newV = this.normInDt(meta.dtype, this.pending[path], meta.norm);
      if (this.sameVal(oldV, newV)) return;
      changes.push({ path, p, f: meta.f, label: meta.label, oldV, newV });
    });
    // 🔴compliance_check.checked_on は NOT NULL。行がまだ無い会社で「結果」「有効期限」だけを
    //   保存しようとすると insert が失敗するため、保存前に分かる言葉で止める。
    const ccCh = changes.filter(c => c.p.table === 'compliance_check');
    if (ccCh.length && !(this.detail.compliance_check || []).length
        && !ccCh.some(c => c.p.column === 'checked_on' && c.newV)) {
      errs.push('・反社チェック: 先に「反社チェック実施日」を入れてください（実施日がないと記録を作れません）');
    }
    if (errs.length) { alert('入力を確認してください。\n\n' + errs.join('\n')); return; }
    if (!changes.length && !typeChange) { this.pending = {}; this.autoPaths = {}; this.autoWhy = {}; this.renderSavebar(); return; }

    const clearing = changes.filter(c => c.newV === null && this.isRequired(c.f, types));
    if (clearing.length && !confirm('必須項目を空にしようとしています。\n\n' + clearing.map(c => '・' + c.label).join('\n') + '\n\nこのまま保存しますか？')) return;
    if (typeChange && typeChange.rem.length &&
      !confirm(`種別「${typeChange.rem.map(c => TM_META.TYPE_CODES[c] || c).join('・')}」を外します。\nその種別専用の入力値は消えませんが、画面に表示されなくなります。\n\nよろしいですか？`)) return;
    // 法人番号の二重登録ガード
    const cn = changes.find(c => c.p.table === 'company' && c.p.column === 'corporate_number' && !c.p.jsonKey);
    if (cn && cn.newV) {
      const dup = (this.rows || []).find(r => r.corporate_number === cn.newV && r.company_id !== cid);
      if (dup) { alert(`この法人番号は登録済みです：${dup.official_name}\n二重登録はできません。`); return; }
    }

    // ③ 書込グループを組み立てる
    //   plain … 1社1行テーブル（JSONBはキーをマージしてオブジェクトごと更新）
    //   keyed … system_code / permit_license（キー値で行が決まる・無ければinsert）
    const plainPatch = {};    // table -> {col: val}
    const keyedPatch = {};    // 'table|keyVal' -> {table, keyCol, keyVal, patch}
    const jsonBuf = {};       // 'table|column' -> マージ後オブジェクト
    changes.forEach(c => {
      if (c.p.jsonKey) {
        const k = `${c.p.table}|${c.p.column}`;
        if (!jsonBuf[k]) {
          const cur = this.rawByPath(`${c.p.table}.${c.p.column}`, d);
          jsonBuf[k] = Object.assign({}, (cur && typeof cur === 'object') ? cur : {});
        }
        if (c.newV === null) delete jsonBuf[k][c.p.jsonKey];
        else jsonBuf[k][c.p.jsonKey] = c.newV;
        c.group = c.p.table;
      } else if (c.p.keyVal) {
        const k = `${c.p.table}|${c.p.keyVal}`;
        keyedPatch[k] = keyedPatch[k] || { table: c.p.table, keyCol: c.p.keyCol, keyVal: c.p.keyVal, patch: {} };
        keyedPatch[k].patch[c.p.column] = c.newV;
        c.group = k;
      } else {
        (plainPatch[c.p.table] = plainPatch[c.p.table] || {})[c.p.column] = c.newV;
        c.group = c.p.table;
      }
    });
    Object.keys(jsonBuf).forEach(k => {
      const kk = k.split('|');
      (plainPatch[kk[0]] = plainPatch[kk[0]] || {})[kk[1]] = Object.keys(jsonBuf[k]).length ? jsonBuf[k] : null;
    });

    const who = this.whoAmI();
    const sb = this.getClient();
    this.busy = true;
    this.renderSavebar();
    const histRows = changes.map(c => ({
      company_id: cid, table_name: c.p.table, column_name: this.histColName(c.p),
      old_value: c.oldV === null || c.oldV === undefined ? null : String(c.oldV),
      new_value: c.newV === null ? null : String(c.newV),
      // 自動判定で入れた値は印を残す → 出所バッジが「自動判定」になる（人が直せば次は印なし＝手入力）
      changed_by: this.autoPaths[c.path] ? who + '(自動判定)' : who,
    }));
    if (typeChange) histRows.push({
      company_id: cid, table_name: 'company_type', column_name: 'type_code',
      old_value: typeChange.oldL, new_value: typeChange.newL, changed_by: who,
    });
    const idByKey = {};
    const done = [];      // 書き終えたグループ
    try {
      const ins = await sb.from('company_history').insert(histRows).select('history_id,table_name,column_name');
      if (ins.error) throw new Error('変更履歴の記録に失敗しました: ' + ins.error.message);
      (ins.data || []).forEach(r => { idByKey[`${r.table_name}.${r.column_name}`] = r.history_id; });

      // plain（company / 1社1行テーブル）
      for (const table of Object.keys(plainPatch)) {
        const patch = plainPatch[table];
        let res;
        if (table === 'company') {
          patch.updated_at = new Date().toISOString();
          patch.updated_by = who;
          res = await sb.from('company').update(patch).eq('company_id', cid);
        } else if ((d[table] || []).length) {
          res = await sb.from(table).update(patch).eq('company_id', cid);
        } else {
          res = await sb.from(table).insert(Object.assign({ company_id: cid }, patch));
        }
        if (res.error) throw new Error(`${table} の保存に失敗しました: ${res.error.message}`);
        done.push(table);
      }
      // keyed（system_code / permit_license）
      for (const k of Object.keys(keyedPatch)) {
        const g = keyedPatch[k];
        const row = (d[g.table] || []).find(r => r[g.keyCol] === g.keyVal);
        let res;
        if (g.table === 'system_code' && g.patch.code === null) {
          // code は NOT NULL ＝ 空にする＝行ごと消す（採番の取り消し）
          res = row ? await sb.from('system_code').delete().eq('company_id', cid).eq('system', g.keyVal) : { error: null };
        } else if (row) {
          res = await sb.from(g.table).update(g.patch).eq('company_id', cid).eq(g.keyCol, g.keyVal);
        } else {
          const ins2 = Object.assign({ company_id: cid }, g.patch);
          ins2[g.keyCol] = g.keyVal;
          res = await sb.from(g.table).insert(ins2);
        }
        if (res.error) {
          const msg = /duplicate|23505/i.test(res.error.message || '')
            ? `このコードは既に他の会社で使われています（${this.SYSTEM_LABEL[g.keyVal] || g.keyVal}）` : res.error.message;
          throw new Error(`${g.table} の保存に失敗しました: ${msg}`);
        }
        done.push(k);
      }
      // 種別フラグ（削除→追加。行が消えても入力値は各サブテーブルに残る＝再チェックで戻る）
      if (typeChange) {
        for (const c of typeChange.rem) {
          const res = await sb.from('company_type').delete().eq('company_id', cid).eq('type_code', c);
          if (res.error) throw new Error('種別の削除に失敗しました: ' + res.error.message);
        }
        if (typeChange.add.length) {
          const res = await sb.from('company_type').insert(typeChange.add.map(c => ({ company_id: cid, type_code: c })));
          if (res.error) throw new Error('種別の追加に失敗しました: ' + res.error.message);
        }
        done.push('@type');
      }
    } catch (e) {
      // 書けなかったグループの履歴だけ取り消す
      const orphanIds = [];
      changes.filter(c => done.indexOf(c.group) < 0)
        .forEach(c => { const id = idByKey[`${c.p.table}.${this.histColName(c.p)}`]; if (id !== undefined) orphanIds.push(id); });
      if (typeChange && done.indexOf('@type') < 0 && idByKey['company_type.type_code'] !== undefined) {
        orphanIds.push(idByKey['company_type.type_code']);
      }
      let cleanupNg = false;
      if (orphanIds.length) {
        const del = await sb.from('company_history').delete().in('history_id', orphanIds);
        cleanupNg = !!del.error;
      }
      this.busy = false;
      this.renderSavebar();
      alert('保存に失敗しました。\n\n' + (e.message || e) +
        (done.length ? '\n\n※ 一部は保存済みです（変更履歴で確認できます）。' : '\n\n※ 変更は反映されていません。') +
        (cleanupNg ? '\n\n🔴 変更履歴の取り消しにも失敗しました。company_history を確認してください。' : ''));
      return;
    }
    // 一覧キャッシュへ反映
    const row = (this.rows || []).find(r => r.company_id === cid);
    if (row) changes.filter(c => c.p.table === 'company' && !c.p.jsonKey).forEach(c => { row[c.p.column] = c.newV; });
    changes.filter(c => c.p.table === 'system_code').forEach(c => {
      const m = (this.codesByCid[cid] = this.codesByCid[cid] || {});
      if (c.newV === null) delete m[c.p.keyVal]; else m[c.p.keyVal] = c.newV;
    });
    if (typeChange && this.typesByCid) this.typesByCid[cid] = typeChange.next.slice();
    const n = changes.length + (typeChange ? 1 : 0);
    this.busy = false;
    this.pending = {}; this.autoPaths = {}; this.autoWhy = {};
    this.toast(`保存しました（${n}項目・変更履歴に記録）`);
    await this.openDetail(cid);
  },

  // ===== 取引履歴タブ（基幹からの参照＝未接続の案内＋わかる範囲） =====
  renderTx(b) {
    const c = this.detail.company;
    let html = '<div class="alert info">ℹ 取引実績は基幹（teraServation／Salesforce／Bill One）からの<b>参照</b>です。取引先マスタには保持しません。基幹との参照接続は今後の連携スコープです。</div>';
    const cr = (this.detail.credit_line || [])[0];
    if (cr && cr.limit_amount) {
      const lim = cr.limit_amount, use = cr.used_amount || 0;
      const rate = Math.min(100, Math.round(use / lim * 100)), over = use > lim;
      html += `<div class="fcard" style="margin-bottom:10px"><h4>与信使用状況 ${over ? '<span class="badge b-red">限度超過</span>' : ''}</h4>
       <div style="height:10px;border-radius:5px;background:var(--muted);overflow:hidden"><div style="height:100%;width:${rate}%;background:${over ? 'var(--accent)' : 'var(--sansan)'}"></div></div>
       <div class="mf tnum" style="font-size:11px;margin-top:4px">限度 ${lim.toLocaleString()} ・ 使用 ${use.toLocaleString()} ・ ${rate}%</div></div>`;
    }
    html += `<div class="fcard"><h4>マスタが持つ取引情報</h4>
      <div class="slink"><span class="nm2">最終取引日</span><b class="tnum">${this.esc(c.last_trade_on || '—')}</b></div>
      <div class="slink"><span class="nm2">取引状況</span><b>${this.esc(c.trade_status || '—')}</b></div>
      <div class="slink"><span class="nm2">取引終了日</span><b class="tnum">${this.esc(c.trade_end_on || '—')}</b></div></div>`;
    b.innerHTML = html;
  },

  // ===== 変更履歴タブ（この会社・実 company_history） =====
  BRANCH_COL_LABEL: { branch_name: '名称', postal_code: '郵便番号', address: '住所', phone: '電話', fax: 'FAX' },
  fieldLabel(table, column) {
    if (column === '(新規作成)') return '(新規作成)';
    let m;
    if (table === 'branch') {
      m = column.match(/^branch_(\d+)(?:\.(\w+))?$/);
      if (m) return `支店${m[1]}` + (m[2] ? `（${this.BRANCH_COL_LABEL[m[2]] || m[2]}）` : '');
      return '支店（' + column + '）';
    }
    if (table === 'system_code' && (m = column.match(/^(\w+)\.code$/)) && this.SYSTEM_LABEL[m[1]]) {
      return this.SYSTEM_LABEL[m[1]] + ' 取引先コード';
    }
    if (table === 'permit_license' && (m = column.match(/^(\w+)\.(\w+)$/)) && this.PERMIT_TYPE_LABEL[m[1]]) {
      return this.PERMIT_TYPE_LABEL[m[1]] + ' ' + (this.PERMIT_COL_LABEL[m[2]] || m[2]);
    }
    if (table === 'company_type' && column === 'type_code') return '種別フラグ';
    if (table === 'company_billing' && (m = column.match(/^(invoice_send_to|order_send_to)\.(\w+)$/))) {
      return (m[1] === 'invoice_send_to' ? '請求書送付先' : '注文書送付先') + '（' + (this.JSONB_KEY_LABEL[m[2]] || m[2]) + '）';
    }
    if (table === 'payment_term' && (m = column.match(/^term#(\d+)$/))) return `支払条件（優先${m[1]}）`;
    if (table === 'company_name_history' && (m = column.match(/^rename_(.+)$/))) return `旧社名（${m[1]}）`;
    if (table === 'document' && (m = column.match(/^doc_(\w+)$/))) return `文書（${this.DOC_TYPE_LABEL[m[1]] || m[1]}）`;
    if (table === 'bank_account' && (m = column.match(/^(\w+)#p(\d+)$/)) && this.BANK_LABELS[m[1]]) {
      return `振込先 ${this.BANK_LABELS[m[1]]}（第${m[2]}口座）`;
    }
    const f = TM_META.FIELDS.find(x => x.col === `${table}.${column}`);
    if (f) return f.name;
    if (table === 'bank_account' && this.BANK_LABELS[column]) return '振込先 ' + this.BANK_LABELS[column];
    // 複数欄項目の実列（company.name_kana 等）はメタのcolに一致しない → SUBFIELDS から引く
    for (const no in this.SUBFIELDS) {
      const s = this.SUBFIELDS[no].find(x => x.path === `${table}.${column}`);
      if (s) return `${(this.fieldByNo(+no) || {}).name || ''}（${s.label}）`;
    }
    return `${table}.${column}`;
  },

  histRowsHtml(rows) {
    return '<div class="tl">' + rows.map(r => {
      const isCreate = r.column_name === '(新規作成)';
      const dot = isCreate ? 'create' : (r.approved_by ? 'approve' : 'human');
      const label = this.fieldLabel(r.table_name, r.column_name);
      const diff = isCreate
        ? `<b>${this.esc(r.new_value || '')}</b> を作成`
        : `<b>${this.esc(label)}</b> を <span class="old">${this.esc(r.old_value === null ? '（空）' : r.old_value)}</span> → <b>${this.esc(r.new_value === null ? '（空）' : r.new_value)}</b>`;
      const appr = !isCreate && r.approved_by ? ` <span class="badge b-green">承認: ${this.esc(r.approved_by)}</span>` : '';
      return `<div class="tlrow"><div class="tldot ${dot}"></div><div><b>${this.esc(r.changed_by)}</b> ${diff}${appr}<div class="ts tnum">${this.esc(this.jstStamp(r.changed_at))}</div></div></div>`;
    }).join('') + '</div>';
  },

  renderHistTab(b) {
    const rows = (this.detail.company_history || []);
    if (!rows.length) {
      b.innerHTML = '<div class="fcard mf">この取引先はまだ編集されていません。項目を編集すると「誰が・いつ・何を」が1項目ずつここに記録されます。</div>';
      return;
    }
    b.innerHTML = this.histRowsHtml(rows);
  },

  // ===== 外部APIでの補完（既存社） =====
  // 🔴出所ガバナンス: 取得値は「提案」。空欄だけを候補にし、採用は人が選ぶ。
  //   経理が確定させた値をAPIが黙って上書きしないための決めごと（ブリーフのモック GOV と同じ思想）。
  async runEnrich() {
    const box = this.el('tmk-enrich-result');
    const btn = this.el('tmk-enrich-run');
    if (!box || !this.detail) return;
    const num = (this.detail.company.corporate_number || '').trim();
    const name = (this.detail.company.official_name || '').trim();
    // 法人番号が要るのは国税庁/gBizINFO/Data Hub。Sansan Open API は会社名で引ける
    if (!/^\d{13}$/.test(num) && !name) {
      box.innerHTML = '<div class="mf" style="font-size:11px">法人番号も社名も無いため照会できません。</div>'; return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '照会中…'; }
    box.innerHTML = '<div class="mf" style="font-size:11px">照会中…</div>';
    try {
      await TM_ENRICH.probe();
      const usable = ['kokuzei', 'gbizinfo', 'sansan', 'sansan_open'].filter(k => TM_ENRICH.available(k))
        // 法人番号が無いときは、それを必要とする取得元を外す
        .filter(k => k === 'sansan_open' ? !!name : /^\d{13}$/.test(num));
      if (!usable.length) {
        box.innerHTML = '<div class="alert warn" style="font-size:11px;margin:0">利用できる取得元がありません。<br>' +
          Object.keys(TM_ENRICH.PROVIDERS).map(k => `・${this.esc(TM_ENRICH.PROVIDERS[k].label)}: ${this.esc(TM_ENRICH.status[k].reason)}`).join('<br>') +
          '</div>';
        return;
      }
      const merged = {};
      const from = {};
      for (const p of usable) {
        const got = await TM_ENRICH.fetchCompany(p, {
          corporateNumber: num, soc: this.detail.company.sansan_soc || '', name,
        });
        if (!got) continue;
        Object.keys(got.values).forEach(no => {
          if (merged[no] === undefined) { merged[no] = got.values[no]; from[no] = TM_ENRICH.PROVIDERS[p].label; }
        });
      }
      // 空欄の項目だけを候補にする（複数列の項目は列ごとに空欄判定）
      const cand = [];
      Object.keys(merged).forEach(no => {
        const f = TM_META.FIELDS.find(x => x.no === +no);
        if (!f) return;
        const plan = this.editPlan(f);
        if (!plan) return;
        if (plan.kind === 'multi' && this.SPLIT_COLS[f.no]) {
          this.splitValue(f, merged[no]).forEach(part => {
            const path = `company.${part.col}`;
            const cur = this.rawByPath(path, this.detail);
            if (cur !== null && String(cur).trim() !== '') return;   // 既存値は触らない
            cand.push({ f, path, label: `${f.name}（${part.label}）`, val: part.val, src: from[no] });
          });
          return;
        }
        if (plan.kind !== 'single') return;
        const cur = this.rawByPath(plan.path, this.detail);
        if (cur !== null && String(cur).trim() !== '') return;   // 既存値は触らない
        cand.push({ f, path: plan.path, label: f.name, val: merged[no], src: from[no] });
      });
      this._enrichCand = cand;
      if (!cand.length) {
        box.innerHTML = '<div class="mf" style="font-size:11px">埋められる空欄はありませんでした（取得できた項目は既に値が入っています）。</div>';
        return;
      }
      box.innerHTML = `<div style="font-size:11px;margin-bottom:6px">空欄 <b>${cand.length}件</b>の候補が見つかりました。採用すると「未保存の変更」に入ります（保存で確定・履歴に記録）。</div>` +
        cand.map((c, i) => `<label class="ck" style="font-size:11px"><input type="checkbox" data-enr="${i}" checked>` +
          `<span><b>${this.esc(c.label)}</b>: ${this.esc(c.val)} <span class="mf">(${this.esc(c.src)})</span></span></label>`).join('') +
        '<button class="btn btn-sm btn-primary" id="tmk-enrich-apply" style="margin-top:6px">選んだ項目を反映</button>';
      this.el('tmk-enrich-apply').onclick = () => this.applyEnrich();
    } catch (e) {
      box.innerHTML = `<div class="alert warn" style="font-size:11px;margin:0">照会に失敗しました: ${this.esc(String(e.message || e))}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔎 APIで補完'; }
    }
  },

  // 候補を未保存の変更（pending）へ入れる。DBへの反映は通常の「💾保存」を通す＝履歴も同じ経路で残る
  applyEnrich() {
    const box = this.el('tmk-enrich-result');
    let n = 0;
    box.querySelectorAll('[data-enr]').forEach(cb => {
      if (!cb.checked) return;
      const c = (this._enrichCand || [])[+cb.dataset.enr];
      if (!c) return;
      this.pending[c.path] = String(c.val);
      n++;
    });
    if (!n) { this.toast('選択された項目がありません'); return; }
    this.renderDbody();
    this.refreshAiSide();
    box.innerHTML = `<div class="mf" style="font-size:11px">${n}件を反映しました。内容を確認して「💾 保存」を押してください。</div>`;
    this.toast(`${n}件を未保存の変更に入れました（保存で確定します）`);
  },

  // ===== 支店・枝番管理（branch テーブル実接続） =====
  renderBranches() {
    const box = this.el('tmk-branches');
    if (!box || !this.detail) return;
    const c = this.detail.company;
    const base = +c.company_id;
    let html = `<div class="slink"><span class="nm2"><b>${base}-000</b> 本社</span><span class="badge b-slate">本社</span></div>`;
    (this.detail.branch || []).forEach(br => {
      html += `<div class="slink"><span class="tnum mf" style="width:70px">${base}-${String(br.branch_no).padStart(3, '0')}</span>
        <input class="inp" data-bno="${br.branch_no}" value="${this.esc(br.branch_name || '')}" style="flex:1;padding:3px 7px;font-size:12px;min-width:0">
        <button class="btn btn-sm" data-bdetail="${br.branch_no}" title="住所・電話などの詳細">⚙</button>
        <button class="btn btn-sm" data-bdel="${br.branch_no}" title="削除">✕</button></div>`;
      if (this.branchEdit === br.branch_no) {
        const t = (col, ph, max) => `<input class="inp" data-bd="${col}" value="${this.esc(br[col] || '')}" placeholder="${ph}" maxlength="${max}" style="width:100%;min-width:0;margin-bottom:5px">`;
        html += `<div class="bdetail">
          ${t('postal_code', '郵便番号(7桁・ハイフンなし)', 7)}
          ${t('address', '住所', 300)}
          <div style="display:flex;gap:6px">${t('phone', '電話', 20)}${t('fax', 'FAX', 20)}</div>
          <div style="display:flex;gap:6px"><button class="btn btn-primary btn-sm" data-bdsave="${br.branch_no}">保存</button><button class="btn btn-sm" data-bdcancel>やめる</button></div>
        </div>`;
      }
    });
    box.innerHTML = html;
    box.querySelectorAll('input[data-bno]').forEach(inp => inp.onchange = () => this.renameBranch(+inp.dataset.bno, inp.value));
    box.querySelectorAll('[data-bdel]').forEach(b => b.onclick = () => this.deleteBranch(+b.dataset.bdel));
    box.querySelectorAll('[data-bdetail]').forEach(b => b.onclick = () => {
      const no = +b.dataset.bdetail;
      this.branchEdit = this.branchEdit === no ? null : no;
      this.renderBranches();
    });
    const bs = box.querySelector('[data-bdsave]');
    if (bs) bs.onclick = () => this.saveBranchDetail(+bs.dataset.bdsave);
    const bc = box.querySelector('[data-bdcancel]');
    if (bc) bc.onclick = () => { this.branchEdit = null; this.renderBranches(); };
  },

  // 支店の詳細（住所・電話等）。変更列ごとに履歴を残す（column_name: branch_番号.列）
  async saveBranchDetail(no) {
    if (this.busy || !this.detail) return;
    const box = this.el('tmk-branches');
    const cid = this.detail.company.company_id;
    const br = (this.detail.branch || []).find(b => b.branch_no === no);
    if (!br) return;
    const vals = {};
    box.querySelectorAll('[data-bd]').forEach(el => { vals[el.dataset.bd] = String(el.value).trim() || null; });
    if (vals.postal_code && !/^\d{7}$/.test(vals.postal_code)) { alert('郵便番号は7桁の数字で入力してください（ハイフンなし）。'); return; }
    const changed = ['postal_code', 'address', 'phone', 'fax'].filter(c => !this.sameVal(br[c], vals[c]));
    if (!changed.length) { this.branchEdit = null; this.renderBranches(); return; }
    const sb = this.getClient();
    const patch = {};
    changed.forEach(c => { patch[c] = vals[c]; });
    const res = await sb.from('branch').update(patch).eq('company_id', cid).eq('branch_no', no);
    if (res.error) { alert('支店詳細の保存に失敗しました: ' + res.error.message); return; }
    const rh = await sb.from('company_history').insert(changed.map(c => ({
      company_id: cid, table_name: 'branch', column_name: `branch_${no}.${c}`.slice(0, 40),
      old_value: br[c] === null || br[c] === undefined ? null : String(br[c]),
      new_value: vals[c] === null ? null : String(vals[c]), changed_by: this.whoAmI(),
    })));
    if (rh.error) alert('保存はできましたが履歴の記録に失敗しました: ' + rh.error.message);
    changed.forEach(c => { br[c] = vals[c]; });
    this.branchEdit = null;
    this.renderBranches();
    this.toast('支店の詳細を保存しました');
  },

  async addBranch() {
    if (this.busy || !this.detail) return;
    const cid = this.detail.company.company_id;
    const no = Math.max(0, ...(this.detail.branch || []).map(b => b.branch_no)) + 1;
    const sb = this.getClient();
    const res = await sb.from('branch').insert({ company_id: cid, branch_no: no, branch_name: '新規支店' });
    if (res.error) { alert('支店の追加に失敗しました: ' + res.error.message); return; }
    await sb.from('company_history').insert({
      company_id: cid, table_name: 'branch', column_name: 'branch_' + no,
      old_value: null, new_value: '新規支店', changed_by: this.whoAmI(),
    });
    this.detail.branch.push({ company_id: cid, branch_no: no, branch_name: '新規支店' });
    this.renderBranches();
    this.toast('支店を追加（枝番 ' + String(no).padStart(3, '0') + '）');
  },

  async renameBranch(no, name) {
    if (!this.detail) return;
    const cid = this.detail.company.company_id;
    const br = (this.detail.branch || []).find(b => b.branch_no === no);
    if (!br || br.branch_name === name) return;
    const sb = this.getClient();
    const res = await sb.from('branch').update({ branch_name: name }).eq('company_id', cid).eq('branch_no', no);
    if (res.error) { alert('支店名の変更に失敗しました: ' + res.error.message); return; }
    await sb.from('company_history').insert({
      company_id: cid, table_name: 'branch', column_name: 'branch_' + no,
      old_value: br.branch_name, new_value: name, changed_by: this.whoAmI(),
    });
    br.branch_name = name;
    this.toast('支店名を変更しました');
  },

  async deleteBranch(no) {
    if (!this.detail) return;
    const cid = this.detail.company.company_id;
    const br = (this.detail.branch || []).find(b => b.branch_no === no);
    if (!br || !confirm(`支店「${br.branch_name || ''}」（枝番 ${String(no).padStart(3, '0')}）を削除しますか？\n残りの枝番は振り直されます。`)) return;
    const sb = this.getClient();
    // モックの「振り直し」を再現: 全行消してから連番で入れ直す（支店は少数行なので安全）
    const rest = (this.detail.branch || []).filter(b => b.branch_no !== no)
      .sort((a, b) => a.branch_no - b.branch_no)
      .map((b, i) => ({ company_id: cid, branch_no: i + 1, branch_name: b.branch_name, postal_code: b.postal_code, address: b.address, phone: b.phone, fax: b.fax }));
    const del = await sb.from('branch').delete().eq('company_id', cid);
    if (del.error) { alert('支店の削除に失敗しました: ' + del.error.message); return; }
    if (rest.length) {
      const ins = await sb.from('branch').insert(rest);
      if (ins.error) { alert('枝番の振り直しに失敗しました: ' + ins.error.message + '\nbranch を確認してください。'); return; }
    }
    await sb.from('company_history').insert({
      company_id: cid, table_name: 'branch', column_name: 'branch_' + no,
      old_value: br.branch_name, new_value: null, changed_by: this.whoAmI(),
    });
    this.detail.branch = rest;
    this.renderBranches();
    this.toast('支店を削除（枝番を振り直し）');
  },

  // ===== 行編集カード（支払条件・旧社名・文書）＝1社複数行テーブルの汎用UI =====
  // 口座・支店カードと同じ「カード内で即時保存＋履歴」方式。フォーム側の項目は読み取り表示。
  termSummary(r) {
    if (!r) return null;
    const dayS = v => v === null || v === undefined ? '—' : (v === 31 ? '月末' : `${v}日`);
    return `優先${r.priority || 1}: 締${dayS(r.closing_day)}/支払${dayS(r.payment_day)}/サイト${r.site_months === null || r.site_months === undefined ? '—' : r.site_months + 'ヶ月'}` +
      (r.order_class ? `（${r.order_class}）` : '') + (r.term_code ? ` ${r.term_code}` : '');
  },
  ROW_CARDS: {
    payment_term: {
      pk: ['term_id'],
      cols: [
        { c: 'order_class', l: '発注分類区分', dt: 'VARCHAR(20)', ph: '例: 通常／資材' },
        { c: 'closing_day', l: '締日（月末=31）', dt: 'SMALLINT' },
        { c: 'payment_day', l: '支払日（月末=31）', dt: 'SMALLINT' },
        { c: 'site_months', l: 'サイト（ヶ月）', dt: 'SMALLINT' },
        { c: 'term_code', l: '名称・備考', dt: 'VARCHAR(40)' },
      ],
      addLabel: '＋ 支払条件を追加',
    },
    company_name_history: {
      pk: ['changed_on'],
      cols: [
        { c: 'changed_on', l: '変更日', dt: 'DATE', req: true },
        { c: 'old_name', l: '旧社名', dt: 'VARCHAR(200)', req: true },
        { c: 'new_name', l: '変更後の社名', dt: 'VARCHAR(200)' },
      ],
      addLabel: '＋ 旧社名を追加',
    },
    document: {
      pk: ['document_id'],
      cols: [
        { c: 'doc_type', l: '種類', dt: 'VARCHAR(30)', req: true, options: ['permit', 'contract', 'meishi', 'survey'] },
        { c: 'file_url', l: 'URL（Boxの共有リンク）', dt: 'VARCHAR(500)', req: true },
        { c: 'valid_until', l: '有効期限', dt: 'DATE' },
      ],
      addLabel: '＋ 文書リンクを追加',
    },
  },
  rowSummary(table, r) {
    if (!r) return null;
    if (table === 'payment_term') return this.termSummary(r);
    if (table === 'company_name_history') return `${r.changed_on || ''} ${r.old_name || ''} → ${r.new_name || '（現社名）'}`;
    if (table === 'document') return `${this.DOC_TYPE_LABEL[r.doc_type] || r.doc_type}: ${r.file_url || ''}${r.valid_until ? `（期限 ${r.valid_until}）` : ''}`;
    return null;
  },
  rowHistCol(table, r) {
    if (table === 'payment_term') return `term#${r.priority || 1}`;
    if (table === 'company_name_history') return `rename_${r.changed_on || ''}`.slice(0, 40);
    if (table === 'document') return `doc_${r.doc_type || ''}`.slice(0, 40);
    return table;
  },
  rowKeyStr(def, r) { return def.pk.map(k => String(r[k])).join('|'); },

  renderRowCards() {
    Object.keys(this.ROW_CARDS).forEach(table => this.renderRowCard(table));
  },
  renderRowCard(table) {
    const box = this.el('tmk-rc-' + table);
    if (!box || !this.detail) return;
    const def = this.ROW_CARDS[table];
    const rows = (this.detail[table] || []).slice();
    const editing = this.rowEdit && this.rowEdit.table === table ? this.rowEdit.id : null;
    let html = '';
    rows.forEach(r => {
      const key = this.rowKeyStr(def, r);
      if (editing === key) { html += this.rowFormHtml(table, def, r); return; }
      const isUrl = table === 'document' && /^https?:\/\//.test(r.file_url || '');
      const body = isUrl
        ? `${this.esc(this.DOC_TYPE_LABEL[r.doc_type] || r.doc_type)}: <a href="${this.esc(r.file_url)}" target="_blank" rel="noopener">${this.esc(r.file_url.length > 42 ? r.file_url.slice(0, 42) + '…' : r.file_url)}</a>${r.valid_until ? `<span class="mf tnum">（期限 ${this.esc(r.valid_until)}）</span>` : ''}`
        : this.esc(this.rowSummary(table, r) || '');
      html += `<div class="slink"><span class="nm2" style="font-size:11.5px">${body}</span>
        <button class="btn btn-sm" data-rcedit="${this.esc(key)}" title="変更">✎</button>
        <button class="btn btn-sm" data-rcdel="${this.esc(key)}" title="削除">✕</button></div>`;
    });
    if (!rows.length && editing !== 'new') html += '<div class="mf" style="font-size:11px;margin-bottom:6px">まだ登録がありません。</div>';
    if (editing === 'new') html += this.rowFormHtml(table, def, null);
    else html += `<button class="btn btn-sm" data-rcadd style="margin-top:4px">${this.esc(def.addLabel)}</button>`;
    box.innerHTML = html;
    box.querySelectorAll('[data-rcedit]').forEach(b => b.onclick = () => { this.rowEdit = { table, id: b.dataset.rcedit }; this.renderRowCard(table); });
    box.querySelectorAll('[data-rcdel]').forEach(b => b.onclick = () => this.deleteRowCard(table, b.dataset.rcdel));
    const add = box.querySelector('[data-rcadd]');
    if (add) add.onclick = () => { this.rowEdit = { table, id: 'new' }; this.renderRowCard(table); };
    const save = box.querySelector('[data-rcsave]');
    if (save) save.onclick = () => this.saveRowCard(table);
    const cancel = box.querySelector('[data-rccancel]');
    if (cancel) cancel.onclick = () => { this.rowEdit = null; this.renderRowCard(table); };
  },
  rowFormHtml(table, def, r) {
    const inp = c => {
      const v = r && r[c.c] !== null && r[c.c] !== undefined ? String(r[c.c]) : '';
      if (c.options) {
        return `<select class="inp" data-rc="${c.c}" style="width:100%;margin-bottom:5px">` +
          `<option value=""${v === '' ? ' selected' : ''}>（選択）</option>` +
          c.options.map(o => `<option value="${this.esc(o)}"${v === o ? ' selected' : ''}>${this.esc(this.DOC_TYPE_LABEL[o] || o)}</option>`).join('') + '</select>';
      }
      const dt = (c.dt || '').toUpperCase();
      if (dt.startsWith('DATE')) return `<input type="date" class="inp" data-rc="${c.c}" value="${this.esc(v.slice(0, 10))}" style="width:100%;margin-bottom:5px">`;
      const m = dt.match(/^(?:VARCHAR|CHAR)\((\d+)\)/);
      return `<input class="inp" data-rc="${c.c}" value="${this.esc(v)}" placeholder="${this.esc(c.ph || '')}" ${m ? `maxlength="${m[1]}"` : ''} style="width:100%;min-width:0;margin-bottom:5px">`;
    };
    return `<div class="rcform">
      ${def.cols.map(c => `<div class="mf" style="font-size:10px">${this.esc(c.l)}${c.req ? ' *' : ''}</div>${inp(c)}`).join('')}
      <div style="display:flex;gap:6px"><button class="btn btn-primary btn-sm" data-rcsave ${this.busy ? 'disabled' : ''}>保存</button><button class="btn btn-sm" data-rccancel>やめる</button></div>
    </div>`;
  },
  async saveRowCard(table) {
    if (this.busy || !this.detail || !this.rowEdit || this.rowEdit.table !== table) return;
    const def = this.ROW_CARDS[table];
    const box = this.el('tmk-rc-' + table);
    const cid = this.detail.company.company_id;
    const isNew = this.rowEdit.id === 'new';
    const cur = isNew ? null : (this.detail[table] || []).find(r => this.rowKeyStr(def, r) === this.rowEdit.id);
    if (!isNew && !cur) return;
    const vals = {};
    const errs = [];
    def.cols.forEach(c => {
      const el = box.querySelector(`[data-rc="${c.c}"]`);
      const raw = el ? String(el.value).trim() : '';
      if (c.req && raw === '') { errs.push(`・${c.l} は必須です`); return; }
      const msg = this.inputErrorDt(c.dt, raw);
      if (msg) { errs.push(`・${c.l}: ${msg}`); return; }
      vals[c.c] = this.normInDt(c.dt, raw);
    });
    if (table === 'payment_term') {
      ['closing_day', 'payment_day'].forEach(c => {
        if (vals[c] !== null && vals[c] !== undefined && (vals[c] < 1 || vals[c] > 31)) errs.push('・締日/支払日は1〜31で入力してください（月末=31）');
      });
    }
    if (table === 'document' && vals.file_url && !/^https?:\/\//.test(vals.file_url)) errs.push('・URLは https:// で始まるBox共有リンクを入れてください');
    if (errs.length) { alert('入力を確認してください。\n\n' + [...new Set(errs)].join('\n')); return; }
    const changed = def.cols.map(c => c.c).filter(c => !this.sameVal(cur ? cur[c] : null, vals[c]));
    if (!changed.length) { this.rowEdit = null; this.renderRowCard(table); return; }

    const sb = this.getClient();
    const who = this.whoAmI();
    this.busy = true;
    try {
      let savedRow;
      if (isNew) {
        const row = Object.assign({ company_id: cid }, vals);
        if (table === 'payment_term') row.priority = Math.max(0, ...(this.detail.payment_term || []).map(r => r.priority || 0)) + 1;
        const res = await sb.from(table).insert(row).select('*');
        if (res.error) {
          const msg = /duplicate|23505/i.test(res.error.message || '') ? '同じ日付の行が既にあります' : res.error.message;
          throw new Error(msg);
        }
        savedRow = (res.data || [])[0] || row;
        this.detail[table] = (this.detail[table] || []).concat([savedRow]);
      } else {
        let q = sb.from(table).update(vals);
        def.pk.forEach(k => { q = q.eq(k, cur[k]); });
        const res = await q.eq('company_id', cid);
        if (res.error) throw new Error(res.error.message);
        savedRow = Object.assign({}, cur, vals);
        const i = this.detail[table].indexOf(cur);
        if (i >= 0) this.detail[table][i] = savedRow;
      }
      const rh = await sb.from('company_history').insert({
        company_id: cid, table_name: table, column_name: this.rowHistCol(table, savedRow),
        old_value: cur ? this.rowSummary(table, cur) : null,
        new_value: this.rowSummary(table, savedRow), changed_by: who,
      });
      if (rh.error) alert('保存はできましたが履歴の記録に失敗しました: ' + rh.error.message);
    } catch (e) {
      this.busy = false;
      alert('保存に失敗しました: ' + (e.message || e));
      return;
    }
    this.busy = false;
    this.rowEdit = null;
    this.renderRowCard(table);
    if (this.dtab === 'basic') this.renderDbody();   // フォーム側の読み取り表示を更新（未保存の編集は保持される）
    this.refreshAiSide();
    this.toast('保存しました（変更履歴に記録）');
  },
  async deleteRowCard(table, key) {
    if (this.busy || !this.detail) return;
    const def = this.ROW_CARDS[table];
    const cid = this.detail.company.company_id;
    const cur = (this.detail[table] || []).find(r => this.rowKeyStr(def, r) === key);
    if (!cur) return;
    if (!confirm(`この行を削除しますか？\n\n${this.rowSummary(table, cur)}\n\n削除も変更履歴に残ります。`)) return;
    const sb = this.getClient();
    this.busy = true;
    try {
      let q = sb.from(table).delete();
      def.pk.forEach(k => { q = q.eq(k, cur[k]); });
      const res = await q.eq('company_id', cid);
      if (res.error) throw new Error(res.error.message);
      const rh = await sb.from('company_history').insert({
        company_id: cid, table_name: table, column_name: this.rowHistCol(table, cur),
        old_value: this.rowSummary(table, cur), new_value: null, changed_by: this.whoAmI(),
      });
      if (rh.error) alert('削除はできましたが履歴の記録に失敗しました: ' + rh.error.message);
    } catch (e) {
      this.busy = false;
      alert('削除に失敗しました: ' + (e.message || e));
      return;
    }
    this.busy = false;
    this.detail[table] = (this.detail[table] || []).filter(r => r !== cur);
    this.renderRowCard(table);
    if (this.dtab === 'basic') this.renderDbody();
    this.refreshAiSide();
    this.toast('削除しました（変更履歴に記録）');
  },

  // ===== 振込先口座（承認フロー・段階B確定ロジック。2026-08-26: 複数口座対応 #71） =====
  // 複数口座では履歴の column_name に「#p優先」を付けて口座を区別する（第1口座は従来どおり接尾辞なし）。
  //   BIGSERIAL の account_id は insert 前に決まらないため、優先番号で紐づける。
  bankHistMatch(colName, priority) {
    const s = String(colName || '');
    if ((priority || 1) === 1) return s.indexOf('#') < 0 || /#p1$/.test(s);
    return new RegExp(`#p${priority}$`).test(s);
  },
  lastBankActor(acc) {
    const pr = acc ? (acc.priority || 1) : 1;
    const h = ((this.detail && this.detail.company_history) || []).find(r =>
      r.table_name === 'bank_account' && this.bankHistMatch(r.column_name, pr));
    return h ? h.changed_by : null;
  },
  bankStatus(acc) {
    if (acc.approved_by) return { key: 'approved', label: `✓ 承認済み（${acc.approved_by}）`, cls: 'b-green' };
    if (this.lastBankActor(acc)) return { key: 'pending', label: '⏳ 承認待ち', cls: 'b-amber' };
    return { key: 'migrated', label: '移行データ・未確認', cls: 'b-slate' };
  },

  renderBanks() {
    const box = this.el('tmk-banks');
    if (!box || !this.detail) return;
    const accs = (this.detail.bank_account || []).slice().sort((a, b) => (a.priority || 1) - (b.priority || 1));
    const me = this.whoAmI();
    let html = '';
    accs.forEach(acc => {
      if (String(this.bankEdit) === String(acc.account_id)) { html += this.bankFormHtml(acc); return; }
      const st = this.bankStatus(acc);
      const actor = this.lastBankActor(acc);
      const canApprove = st.key !== 'approved' && actor !== me;
      const line = [acc.bank_name, acc.branch_code ? `支店${acc.branch_code}` : '', acc.account_type, acc.account_number].filter(Boolean).map(s => this.esc(s)).join('　');
      html += `<div style="border:1px solid var(--border);border-radius:8px;padding:9px 11px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${accs.length > 1 ? `<span class="badge b-slate">第${acc.priority || 1}口座</span>` : ''}
          <span class="badge ${st.cls}">${this.esc(st.label)}</span>
          ${st.key === 'pending' && actor ? `<span class="mf" style="font-size:10px">申請: ${this.esc(actor)}</span>` : ''}
          <span style="flex:1"></span>
          ${st.key !== 'approved' && canApprove ? `<button class="btn btn-success btn-sm" data-bapprove="${this.esc(String(acc.account_id))}">承認する</button>` : ''}
          ${st.key !== 'approved' && !canApprove ? '<span class="mf" style="font-size:10px" title="申請者本人は承認できません">本人以外の承認待ち</span>' : ''}
          <button class="btn btn-sm" data-bedit="${this.esc(String(acc.account_id))}">変更を申請</button>
        </div>
        <div style="font-weight:600;margin-top:4px">${line || '<span class="mf">—</span>'}</div>
        <div class="mf" style="font-size:11px">${this.esc(acc.account_holder_kana || '')}</div>
        ${acc.approved_at ? `<div class="mf tnum" style="font-size:10px;margin-top:2px">承認日時: ${this.esc(this.jstStamp(acc.approved_at))}</div>` : ''}
      </div>`;
    });
    if (!accs.length) {
      html += this.bankEdit === 'new' ? this.bankFormHtml(null)
        : '<div class="mf" style="font-size:11px">口座は登録されていません。<button class="btn btn-sm" data-bedit="new" style="margin-left:6px">口座を登録</button></div>';
    } else {
      // 複数口座（#71）: 2つ目以降も同じ承認フローで追加できる
      html += this.bankEdit === 'new' ? this.bankFormHtml(null)
        : '<button class="btn btn-sm" data-bedit="new">＋ 別の口座を追加</button>';
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-bedit]').forEach(b => b.onclick = () => { this.bankEdit = b.dataset.bedit; this.renderBanks(); });
    box.querySelectorAll('[data-bapprove]').forEach(b => b.onclick = () => this.approveBank(b.dataset.bapprove));
    const save = box.querySelector('[data-bsave]');
    if (save) save.onclick = () => this.saveBank();
    const cancel = box.querySelector('[data-bcancel]');
    if (cancel) cancel.onclick = () => { this.bankEdit = null; this.renderBanks(); };
  },

  bankFormHtml(acc) {
    const v = c => acc && acc[c] !== null && acc[c] !== undefined ? String(acc[c]) : '';
    const txt = (c, ph, extra) => `<input class="inp" data-bank="${c}" value="${this.esc(v(c))}" placeholder="${ph}" ${extra || ''} style="width:100%;min-width:0;margin-bottom:6px">`;
    // 選択式（実データの分布で確定）。🔴選択肢に無い既存値は「現在値」として必ず残す
    const sel = (c, ph) => {
      const cur = v(c), opts = this.BANK_CHOICES[c];
      const unknown = cur !== '' && opts.indexOf(cur) < 0;
      return `<select class="inp" data-bank="${c}" style="width:100%;min-width:0;margin-bottom:6px">` +
        `<option value=""${cur === '' ? ' selected' : ''}>${this.esc(ph)}</option>` +
        (unknown ? `<option value="${this.esc(cur)}" selected>${this.esc(cur)}（現在値・選択肢外）</option>` : '') +
        opts.map(o => `<option value="${this.esc(o)}"${cur === o ? ' selected' : ''}>${this.esc(o)}</option>`).join('') + '</select>';
    };
    const kanaLen = [...v('account_holder_kana')].length;
    return `<div style="border:1.5px solid var(--amber);background:var(--amber-bg);border-radius:8px;padding:10px 11px;margin-bottom:8px;font-size:12px">
      <div style="font-weight:800;color:var(--amber);margin-bottom:6px">${acc ? '口座変更の申請' : '口座の登録申請'}</div>
      ${txt('bank_name', '銀行名 *', 'maxlength="100"')}
      <div style="display:flex;gap:6px">${txt('bank_code', '銀行コード(4桁)', 'maxlength="4"')}${txt('branch_code', '支店コード(3桁)', 'maxlength="4"')}</div>
      <div style="display:flex;gap:6px">${sel('account_type', '預金種別 *')}${txt('account_number', '口座番号 *', 'maxlength="20"')}</div>
      ${txt('account_holder_kana', '口座名義(カナ) *', 'maxlength="100"')}
      ${kanaLen > 30 ? `<div style="font-size:10px;color:var(--amber);margin-bottom:4px">※名義${kanaLen}字。全銀フォーマットは30字上限（原文は保持されます）</div>` : ''}
      ${sel('payment_method', '支払方法（既定: 振込）')}
      <label style="display:flex;align-items:center;gap:5px;font-size:11px;margin-bottom:8px"><input type="checkbox" data-bank="is_factoring" ${acc && acc.is_factoring ? 'checked' : ''}>ファクタリング</label>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" data-bsave ${this.busy ? 'disabled' : ''}>${this.busy ? '送信中…' : '申請する'}</button>
        <button class="btn btn-sm" data-bcancel>やめる</button>
      </div>
      <div class="mf" style="font-size:10px;margin-top:6px">保存すると未承認になり、本人以外の承認が必要です</div>
    </div>`;
  },

  async saveBank() {
    if (this.busy || !this.detail) return;
    const box = this.el('tmk-banks');
    const d = this.detail;
    const cid = d.company.company_id;
    const isNewAcc = this.bankEdit === 'new';
    const acc = isNewAcc ? null : (d.bank_account || []).find(a => String(a.account_id) === String(this.bankEdit));
    if (!isNewAcc && !acc) return;

    const vals = {};
    box.querySelectorAll('[data-bank]').forEach(el => {
      const c = el.dataset.bank;
      vals[c] = (el.type === 'checkbox') ? el.checked : (String(el.value).trim() || null);
    });
    const errs = [];
    if (!vals.bank_name) errs.push('・銀行名は必須です');
    if (!vals.account_type) errs.push('・預金種別は必須です');
    if (!vals.account_number) errs.push('・口座番号は必須です');
    if (!vals.account_holder_kana) errs.push('・口座名義(カナ)は必須です');
    if (vals.bank_code && !/^\d{4}$/.test(vals.bank_code)) errs.push('・銀行コードは4桁の数字です');
    if (vals.branch_code && !/^\d{3}$/.test(vals.branch_code)) errs.push('・支店コードは3桁の数字です（全銀形式）');
    if (vals.account_number && !/^[\dA-Za-z-]{1,20}$/.test(vals.account_number)) errs.push('・口座番号に使えない文字があります');
    if (errs.length) { alert('入力を確認してください。\n\n' + errs.join('\n')); return; }
    if (!vals.payment_method) vals.payment_method = '振込';

    const changes = this.BANK_COLS.filter(c => !this.sameVal(acc ? acc[c] : null, vals[c]))
      .map(c => ({ column: c, oldV: acc ? acc[c] : null, newV: vals[c] }));
    if (!changes.length) { this.bankEdit = null; this.renderBanks(); return; }

    if (!confirm((isNewAcc ? '口座を登録申請します。' : '口座の変更を申請します。') +
      '\n\n' + changes.map(c => `・${this.BANK_LABELS[c.column]}: ${c.oldV === null || c.oldV === '' ? '（空）' : c.oldV} → ${c.newV === null ? '（空）' : c.newV}`).join('\n') +
      '\n\n保存すると未承認の状態になり、本人以外の admin/accounting の承認が必要です。')) return;

    // 複数口座: 新規は次の優先番号。履歴は優先2以降だけ「#p優先」で口座を区別（第1口座は従来形式）
    const priority = isNewAcc
      ? Math.max(0, ...(d.bank_account || []).map(a => a.priority || 1)) + 1
      : (acc.priority || 1);
    const colName = c => priority > 1 ? `${c}#p${priority}` : c;

    const who = this.whoAmI();
    const sb = this.getClient();
    this.busy = true;
    const btn = box.querySelector('[data-bsave]');
    if (btn) { btn.disabled = true; btn.textContent = '送信中…'; }
    try {
      const ins = await sb.from('company_history').insert(changes.map(c => ({
        company_id: cid, table_name: 'bank_account', column_name: colName(c.column),
        old_value: c.oldV === null || c.oldV === undefined ? null : String(c.oldV),
        new_value: c.newV === null ? null : String(c.newV),
        changed_by: who,
      }))).select('history_id');
      if (ins.error) throw new Error('変更履歴の記録に失敗しました: ' + ins.error.message);
      const histIds = (ins.data || []).map(r => r.history_id);

      const patch = {
        bank_name: vals.bank_name, bank_code: vals.bank_code, branch_code: vals.branch_code,
        account_type: vals.account_type, account_number: vals.account_number,
        account_holder_kana: vals.account_holder_kana, payment_method: vals.payment_method,
        is_factoring: !!vals.is_factoring,
        approved_by: null, approved_at: null, updated_at: new Date().toISOString(),
      };
      const res = isNewAcc
        ? await sb.from('bank_account').insert(Object.assign({ company_id: cid, priority }, patch))
        : await sb.from('bank_account').update(patch).eq('account_id', acc.account_id);
      if (res.error) {
        if (histIds.length) await sb.from('company_history').delete().in('history_id', histIds);
        throw new Error('口座の保存に失敗しました: ' + res.error.message);
      }
    } catch (e) {
      this.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '申請する'; }
      alert(String(e.message || e));
      return;
    }
    this.busy = false;
    this.bankEdit = null;
    this.toast('口座を申請しました（本人以外の承認待ち）');
    await this.openDetail(cid);
  },

  async approveBank(accountId) {
    if (this.busy || !this.detail) return;
    const d = this.detail;
    const cid = d.company.company_id;
    const acc = (d.bank_account || []).find(a => String(a.account_id) === String(accountId));
    if (!acc) return;
    const me = this.whoAmI();
    if (this.lastBankActor(acc) === me) { alert('申請者本人は承認できません。別の admin/accounting に依頼してください。'); return; }
    const line = [acc.bank_name, acc.branch_code ? `支店${acc.branch_code}` : '', acc.account_type, acc.account_number].filter(Boolean).join('　');
    if (!confirm(`この口座を承認しますか？\n\n${line}\n${acc.account_holder_kana || ''}\n\n承認すると振込先として有効になります。`)) return;
    const sb = this.getClient();
    this.busy = true;
    try {
      const res = await sb.from('bank_account').update({ approved_by: me, approved_at: new Date().toISOString() }).eq('account_id', acc.account_id);
      if (res.error) throw new Error(res.error.message);
      // 履歴側の承認印は「この口座の申請行」だけに付ける（複数口座では #p優先 で区別）
      const pend = await sb.from('company_history').select('history_id,column_name')
        .eq('company_id', cid).eq('table_name', 'bank_account').is('approved_by', null);
      if (pend.error) throw new Error('承認の記録（履歴側）の照会に失敗しました: ' + pend.error.message);
      const ids = (pend.data || []).filter(r => this.bankHistMatch(r.column_name, acc.priority || 1)).map(r => r.history_id);
      if (ids.length) {
        const res2 = await sb.from('company_history').update({ approved_by: me }).in('history_id', ids);
        if (res2.error) throw new Error('承認の記録（履歴側）に失敗しました: ' + res2.error.message);
      }
    } catch (e) {
      this.busy = false;
      alert('承認に失敗しました: ' + (e.message || e));
      return;
    }
    this.busy = false;
    this.toast('口座を承認しました');
    await this.openDetail(cid);
  },

  // temp→full の承認（作成者本人以外。承認までは各システムへ配布しない）
  async approveRegistration() {
    if (!this.detail || this.busy) return;
    const c = this.detail.company;
    const me = this.whoAmI();
    if ((c.created_by || null) === me) { alert('登録した本人は承認できません。別の admin/accounting に依頼してください。'); return; }
    if (!confirm(`「${c.official_name}」の登録を承認しますか？\n\n承認すると正式登録（配布可能）になります。`)) return;
    const sb = this.getClient();
    const res = await sb.from('company').update({
      registration_stage: 'full', updated_at: new Date().toISOString(), updated_by: me,
    }).eq('company_id', c.company_id);
    if (res.error) { alert('承認に失敗しました: ' + res.error.message); return; }
    const rh = await sb.from('company_history').insert({
      company_id: c.company_id, table_name: 'company', column_name: 'registration_stage',
      old_value: 'temp', new_value: 'full', changed_by: me, approved_by: me,
    });
    if (rh.error) alert('承認は完了しましたが履歴の記録に失敗しました: ' + rh.error.message);
    const row = (this.rows || []).find(r => r.company_id === c.company_id);
    if (row) row.registration_stage = 'full';
    this.toast('登録を承認しました');
    await this.openDetail(c.company_id);
  },

  // ===== API更新チェック =====
  // 🔴登記は変わり続ける（本店移転・商号変更・代表者交代）。一度埋めて終わりではなく、
  //   定期的に外部APIと突き合わせて「マスタの値が古くなっていないか」を見張る画面。
  //   取得値は提案。**採用は人が選ぶ**（保存は通常の経路＝1項目ずつ変更履歴に残る）。
  apiChk: null,   // { rows: [...], running: false, done: 0, total: 0, stat: {} }

  async renderApiCheck() {
    const wrap = this.el('tmk-wrap');
    if (!wrap || this.rows === null) return;
    this.el('tmk-title').textContent = 'API更新チェック';
    await TM_ENRICH.probe();
    const on = TM_ENRICH.available('gbizinfo');
    const targets = (this.rows || []).filter(r => !r.is_suspended && r.corporate_number);
    const noAddr = targets.filter(r => !r.address_line).length;

    wrap.innerHTML =
      '<div class="sub">登記情報（gBizINFO）と取引先マスタを突き合わせ、<b>空欄の補完</b>と<b>古くなった値</b>を洗い出します。' +
      '本店移転・商号変更・代表者交代があれば、マスタの値は登記と食い違います。' +
      '<b>取得値は提案です。採用するかは確認のうえ選んでください。</b></div>' +
      (on ? '' : `<div class="alert warn">gBizINFO が未接続です（${this.esc(TM_ENRICH.status.gbizinfo.reason)}）。接続すると実行できます。</div>`) +
      '<div class="fcard" style="margin-bottom:12px">' +
        '<h4>チェックの対象</h4>' +
        `<div class="mf" style="font-size:11.5px;margin-bottom:8px">法人番号がある有効社 <b>${targets.length.toLocaleString()}社</b>が対象です` +
        `（うち<b>本社住所が空 ${noAddr}社</b>）。照会は1社あたり約0.4秒かかります。</div>` +
        '<div class="tool" style="margin-bottom:0">' +
          '<select class="inp" id="tmk-chk-scope">' +
            `<option value="empty">空欄がある社のみ（推奨）</option>` +
            '<option value="all">すべての社</option>' +
          '</select>' +
          '<select class="inp" id="tmk-chk-limit">' +
            '<option value="20">20社ずつ</option>' +
            '<option value="50" selected>50社ずつ</option>' +
            '<option value="100">100社ずつ</option>' +
          '</select>' +
          `<button class="btn btn-primary" id="tmk-chk-run" ${on ? '' : 'disabled'}>🔄 チェックを実行</button>` +
          '<span class="mf" id="tmk-chk-prog" style="font-size:11.5px"></span>' +
        '</div>' +
      '</div>' +
      '<div id="tmk-chk-result"></div>';

    this.el('tmk-chk-run').onclick = () => this.runApiCheck();
    if (this.apiChk && this.apiChk.rows) this.renderApiCheckResult();
  },

  async runApiCheck() {
    const scope = this.el('tmk-chk-scope').value;
    const limit = +this.el('tmk-chk-limit').value;
    const btn = this.el('tmk-chk-run');
    const prog = this.el('tmk-chk-prog');
    let targets = (this.rows || []).filter(r => !r.is_suspended && r.corporate_number);
    if (scope === 'empty') {
      targets = targets.filter(r => !r.address_line || !r.postal_code || !r.name_kana || !r.representative_name);
    }
    // 既にチェック済みの社は後回しにして、未チェックから進める
    const doneIds = new Set((this.apiChk && this.apiChk.rows || []).map(r => r.company_id));
    targets = targets.filter(r => !doneIds.has(r.company_id)).slice(0, limit);
    if (!targets.length) { this.toast('対象がありません（この条件は確認済みです）'); return; }

    btn.disabled = true;
    this.apiChk = this.apiChk || { rows: [], stat: {} };
    const out = this.apiChk.rows;
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      prog.textContent = `照会中… ${i + 1} / ${targets.length}社`;
      try {
        const got = await TM_ENRICH.fetchCompany('gbizinfo', { corporateNumber: r.corporate_number });
        if (!got) {
          out.push({ company_id: r.company_id, name: r.official_name, notfound: true, diffs: [] });
        } else {
          out.push({ company_id: r.company_id, name: r.official_name, diffs: TM_ENRICH.diffCompany(r, got.raw) });
        }
      } catch (e) {
        out.push({ company_id: r.company_id, name: r.official_name, error: String(e.message || e), diffs: [] });
      }
      await new Promise(res => setTimeout(res, 350));   // 外部APIへの集中を避ける
    }
    prog.textContent = `完了（累計 ${out.length}社）`;
    btn.disabled = false;
    this.renderApiCheckResult();
  },

  STATE_STYLE: {
    fill: { badge: 'b-green', mark: '🟢', order: 1 },
    masterError: { badge: 'b-amber', mark: '🟠', order: 2 },
    mismatch: { badge: 'b-red', mark: '🔴', order: 3 },
    sameFuzzy: { badge: 'b-slate', mark: '⚪', order: 4 },
    same: { badge: 'b-slate', mark: '⚪', order: 5 },
  },

  renderApiCheckResult() {
    const box = this.el('tmk-chk-result');
    if (!box || !this.apiChk) return;
    const all = [];
    this.apiChk.rows.forEach(r => (r.diffs || []).forEach(d => all.push(Object.assign({ cid: r.company_id, name: r.name }, d))));
    const stat = {};
    all.forEach(d => { stat[d.state] = (stat[d.state] || 0) + 1; });
    const notfound = this.apiChk.rows.filter(r => r.notfound).length;
    const errors = this.apiChk.rows.filter(r => r.error).length;

    // 対応が要るものだけ上に出す（一致は畳む）
    const actionable = all.filter(d => d.state === 'fill' || d.state === 'masterError' || d.state === 'mismatch')
      .sort((a, b) => this.STATE_STYLE[a.state].order - this.STATE_STYLE[b.state].order);

    const summary =
      '<div class="fcard" style="margin-bottom:12px"><h4>結果</h4>' +
      `<div style="font-size:12px">照会 <b>${this.apiChk.rows.length.toLocaleString()}社</b>` +
      (notfound ? ` ／ gBizINFOに該当なし ${notfound}社` : '') +
      (errors ? ` ／ <span style="color:var(--accent)">照会失敗 ${errors}社</span>` : '') + '</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:12px">' +
        `<span>🟢 空欄を補完 <b>${stat.fill || 0}</b></span>` +
        `<span>🟠 マスタ側の誤り <b>${stat.masterError || 0}</b></span>` +
        `<span>🔴 不一致・要確認 <b>${stat.mismatch || 0}</b></span>` +
        `<span class="mf">⚪ 一致 ${(stat.same || 0) + (stat.sameFuzzy || 0)}（対応不要）</span>` +
      '</div></div>';

    if (!actionable.length) {
      box.innerHTML = summary + '<div class="fcard mf">対応が必要な差異はありませんでした。</div>';
      return;
    }

    const rows = actionable.map((d, i) => {
      const st = this.STATE_STYLE[d.state];
      return `<tr>` +
        `<td style="text-align:center"><input type="checkbox" data-chk="${i}" ${d.adopt ? 'checked' : ''}></td>` +
        `<td><span class="badge ${st.badge}">${st.mark} ${this.esc(d.judgeLabel)}</span></td>` +
        `<td class="nm">${this.esc(d.name)}</td>` +
        `<td>${this.esc(d.label)}</td>` +
        `<td class="mf" style="max-width:230px;white-space:normal">${this.esc(d.current || '(空欄)')}</td>` +
        `<td style="max-width:230px;white-space:normal"><b>${this.esc(d.api)}</b></td></tr>`;
    }).join('');

    this._chkActionable = actionable;
    box.innerHTML = summary +
      '<div class="tool">' +
        '<button class="btn btn-sm" id="tmk-chk-all">すべて選択</button>' +
        '<button class="btn btn-sm" id="tmk-chk-none">すべて解除</button>' +
        '<button class="btn btn-sm" id="tmk-chk-safe">🟢と🟠だけ選択</button>' +
        '<span class="count" id="tmk-chk-count"></span>' +
      '</div>' +
      '<div class="tblwrap"><table class="tbl"><thead><tr>' +
      ['採用', '判定', '取引先名', '項目', 'マスタの現在値', 'gBizINFOの値']
        .map(h => `<th>${h}</th>`).join('') +
      `</tr></thead><tbody>${rows}</tbody></table></div>` +
      '<div class="savebar" style="margin-top:14px">' +
        '<span>選んだ差異をマスタに反映します。<b>1項目ずつ変更履歴に記録</b>されます</span>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-primary" id="tmk-chk-apply">💾 選んだ内容を反映</button>' +
      '</div>';

    const upd = () => {
      const n = box.querySelectorAll('[data-chk]:checked').length;
      this.el('tmk-chk-count').textContent = `${n}件を選択中`;
    };
    box.querySelectorAll('[data-chk]').forEach(cb => cb.addEventListener('change', upd));
    this.el('tmk-chk-all').onclick = () => { box.querySelectorAll('[data-chk]').forEach(c => c.checked = true); upd(); };
    this.el('tmk-chk-none').onclick = () => { box.querySelectorAll('[data-chk]').forEach(c => c.checked = false); upd(); };
    this.el('tmk-chk-safe').onclick = () => {
      box.querySelectorAll('[data-chk]').forEach(c => {
        const d = actionable[+c.dataset.chk];
        c.checked = d.state === 'fill' || d.state === 'masterError';
      });
      upd();
    };
    this.el('tmk-chk-apply').onclick = () => this.applyApiCheck();
    upd();
  },

  // 選択された差異をマスタへ反映（CSV取込と同じ経路＝履歴に残る）
  async applyApiCheck() {
    const box = this.el('tmk-chk-result');
    const picks = [...box.querySelectorAll('[data-chk]:checked')].map(c => this._chkActionable[+c.dataset.chk]);
    if (!picks.length) { this.toast('採用する項目が選ばれていません'); return; }
    const mismatch = picks.filter(d => d.state === 'mismatch').length;
    if (!confirm(`${picks.length}件をマスタに反映します。` +
      (mismatch ? `\n\n🔴 うち${mismatch}件は「不一致・要確認」です。現在の値が上書きされます。` : '') +
      '\n\n1項目ずつ変更履歴に記録されます。よろしいですか？')) return;

    // 複数列にまたがる項目（本社住所・社名カナ）は分解して当てる
    const changes = [];
    picks.forEach(d => {
      const f = TM_META.FIELDS.find(x => x.no === d.no);
      const row = (this.rows || []).find(r => r.company_id === d.cid);
      if (!f || !row) return;
      if (this.SPLIT_COLS[d.no]) {
        this.splitValue(f, d.api).forEach(part => {
          if (this.sameVal(row[part.col], part.val)) return;
          changes.push({
            cid: d.cid, name: d.name,
            f: { no: d.no, name: `${f.name}（${part.label}）`, col: `company.${part.col}`, dtype: part.dtype },
            oldV: row[part.col], newV: part.val,
          });
        });
      } else {
        const newV = this.normIn(f, d.api);
        if (this.sameVal(row[d.col], newV)) return;
        changes.push({ cid: d.cid, name: d.name, f, oldV: row[d.col], newV });
      }
    });
    if (!changes.length) { this.toast('反映する変更がありません'); return; }
    // CSV取込と同じ適用経路を通す（履歴の書き方・エラー処理を1本にする）。
    // 出所は gBizINFO ＝履歴に「(gBizINFO)」が残り、画面のバッジが「gBizINFO API」になる
    this.showCsvPreview(changes, [], 'gBizINFO');
  },

  // ===== システム連携（グローバル） =====
  // 表示は「自動で繋がっているか」ではなく「マスタがコードを持っているか＋登録方法」で表す（2026-08-26訂正）。
  renderSysGlobal() {
    const wrap = this.el('tmk-wrap');
    if (!wrap || this.rows === null) return;
    const withSys = {};
    Object.values(this.codesByCid).forEach(codes => Object.keys(codes).forEach(s => withSys[s] = (withSys[s] || 0) + 1));
    const sansanN = this.rows.filter(r => r.sansan_soc).length;
    const rows = [
      { name: 'Sansan（名刺）', cnt: sansanN, method: '名刺→自動取得（未接続）',
        st: sansanN > 0 ? { badge: '取得あり', cls: 'b-sansan' } : { badge: '未接続', cls: 'b-slate' },
        note: 'SOCでの突合は接続後。名刺の無い取引先は経理の手入力に依存' },
      ...this.SYSLINK.map(s => {
        const cnt = withSys[s.sys] || 0;
        const st = this.sysState(s.sys, s.mode, cnt);
        return { name: s.name, cnt, method: cnt > 0 ? '人が手で転記' : '—', st, note: st.note };
      }),
    ];
    wrap.innerHTML = `<div class="sub">各システムとのつながりの全体像。<b>現時点で自動連携（API配信）しているシステムはありません。</b>
      teraServation と勘定奉行(オンプレ)は<b>同じ取引先コード</b>をマスタが保持していますが、各システムへの登録は<b>人が手で転記</b>しています。
      API配信は今回のスコープ外です（後から足せる形は維持）。この表は「マスタがコードを持っているか」の実測です。</div>
     <div class="alert warn">⚠ 「コードを持っている」＝「自動で同期している」ではありません。値の二重入力・転記漏れは現状の運用リスクとして残ります。</div>
     <div class="tblwrap"><table class="tbl"><thead><tr><th>システム</th><th>状態</th><th>登録方法</th><th>コード保有社数</th><th>備考</th></tr></thead><tbody>` +
      rows.map(r => `<tr style="cursor:default"><td style="font-weight:600">${this.esc(r.name)}</td>` +
        `<td><span class="badge ${r.st.cls}">${this.esc(r.st.badge)}</span></td>` +
        `<td class="mf">${this.esc(r.method)}</td>` +
        `<td class="num">${r.cnt.toLocaleString()}</td>` +
        `<td class="mf">${this.esc(r.note)}</td></tr>`).join('') +
      '</tbody></table></div>';
  },

  // ===== 変更履歴（グローバル・実データ最新100件） =====
  // ===== 詳細ページ「Box資料」タブ =====
  // 🔴設計の前提（実測）: 00_取引先コード は**書類の種類ごとの親フォルダ**で、取引先ごとの
  //   フォルダは例外的にしか無い。原本の大半は**ファイル名の先頭に取引先コード**を付けて平置き。
  //   そのため「この会社のフォルダを埋め込む」ことはできない。できるのは
  //     ①フォルダを埋め込んで人が辿る（確実）  ②コード/社名で検索する（Box側の描画に依存）
  //   の2本立て。②はBoxにサインインした実機でしか確認できないため、**既定は①**にしてある。
  renderBoxTab(host) {
    const c = this.detail.company;
    const code = ((this.detail.system_code || []).find(r => r.system === 'tera') || {}).code || '';
    if (this.boxMode === undefined) this.boxMode = 'folder';
    if (!this.boxFolder) this.boxFolder = this.BOX_FOLDER_ID;
    const q = this.boxMode === 'code' ? code : (this.boxMode === 'name' ? (c.official_name || '') : '');
    const url = this.boxMode === 'folder' ? this.boxEmbedUrl(this.boxFolder)
      : `https://app.box.com/embed/folder/${this.BOX_FOLDER_ID}/search?query=${encodeURIComponent(q)}`;
    const seg = (m, label, on, dis) =>
      `<button class="seg ${this.boxMode === m ? 'on' : ''}" data-boxm="${m}" ${dis ? 'disabled' : ''}${dis ? ' title="取引先コードが未採番のため使えません"' : ''}>${label}</button>`;
    host.innerHTML =
      '<div class="mf" style="font-size:11.5px;margin-bottom:10px">' +
      `経理の <b>${this.esc(this.BOX_FOLDER_PATH)}</b> をそのまま表示しています（取引口座申請書・履歴事項全部証明書・建設業許可証など）。<br>` +
      '🔴このフォルダは<b>書類の種類ごとの親フォルダ</b>です。<b>取引先ごとのフォルダは一部にしかありません</b>' +
      '（大半の原本は「<span class="tnum">4621</span>○○工業　20231025取引口座申請書.pdf」のように' +
      '<b>ファイル名の先頭に取引先コード</b>を付けて置かれています）。<br>' +
      '🔴ファイル名の数字は<b>取引先コード</b>であって<b>会社マスタIDではありません</b>' +
      '（例: Boxの「<span class="tnum">1417</span>○○工業」の1417は取引先コード。同じ数字の会社マスタIDは別の会社です）。' +
      '<span style="color:var(--amber)">中身が出ない場合はBoxにサインインしていないか、フォルダの閲覧権限がありません。</span></div>' +
      '<div class="fmtbar"><span class="lb">表示</span>' +
      seg('folder', '📁 フォルダを見る', true, false) +
      seg('code', `🔎 コード ${this.esc(code || '未採番')} で絞る`, true, !code) +
      seg('name', '🔎 社名で絞る', true, !(c.official_name || '')) +
      '<span class="fmthint">絞り込みはBox側の検索です。結果が出ないときは「フォルダを見る」に戻してください</span></div>' +
      (this.boxMode === 'folder'
        ? '<div class="tool" style="margin:8px 0"><span class="mf" style="font-size:11px">フォルダ</span>' +
          `<select class="inp" id="tmk-box-sub">${this.BOX_SUBS.map(([id, nm]) =>
            `<option value="${id}"${this.boxFolder === id ? ' selected' : ''}>${this.esc(nm)}</option>`).join('')}</select>` +
          `<a class="btn btn-sm" href="${this.boxFolderUrl(this.boxFolder)}" target="_blank" rel="noopener">↗ Boxで開く</a></div>`
        : `<div class="tool" style="margin:8px 0"><a class="btn btn-sm" href="${this.boxSearchUrl(q)}" target="_blank" rel="noopener">↗ Boxで開く（別タブ）</a></div>`) +
      `<div class="boxwrap"><iframe id="tmk-box-frame" src="${this.esc(url)}" ` +
      'title="Box 取引先コード" allow="clipboard-read *; clipboard-write *" ' +
      'allowfullscreen webkitallowfullscreen msallowfullscreen></iframe></div>';
    host.querySelectorAll('[data-boxm]').forEach(b => b.onclick = () => {
      if (b.disabled) return;
      this.boxMode = b.dataset.boxm;
      this.renderDbody();
    });
    const sel = this.el('tmk-box-sub');
    if (sel) sel.onchange = () => { this.boxFolder = sel.value; this.renderDbody(); };
  },

  async renderHistGlobal() {
    const wrap = this.el('tmk-wrap');
    if (!wrap) return;
    wrap.innerHTML = '<p class="mf" style="padding:20px">変更履歴を読み込み中…</p>';
    try {
      const sb = this.getClient();
      // 🔴PostgRESTの1リクエスト上限は1,000行。全社横断はここまで出し、
      //   これを超える場合は「取引先ごとの変更履歴」（詳細ページのタブ）で追う
      const HIST_MAX = 1000;
      const res = await sb.from('company_history').select('*').order('changed_at', { ascending: false }).limit(HIST_MAX);
      if (res.error) throw new Error(res.error.message);
      const rs = res.data || [];
      if (!rs.length) {
        wrap.innerHTML = `<div class="sub">全社横断の変更履歴（新しい順・最大${HIST_MAX.toLocaleString()}件）。</div><div class="fcard mf">まだ変更履歴はありません。項目を編集・新規登録すると「誰が・いつ・何を」変えたかがここに記録されます。</div>`;
        return;
      }
      const nameByCid = {};
      (this.rows || []).forEach(r => nameByCid[r.company_id] = r.official_name);
      // 🔴打ち切りが起きたことを黙らない（全部見えている、と誤解させないため）
      const capped = rs.length >= HIST_MAX
        ? `<span style="color:var(--amber)">直近${HIST_MAX.toLocaleString()}件のみ表示中です。これより古い履歴は、取引先の詳細ページ「変更履歴」タブ（1社あたり最大1,000件）で追えます。</span>`
        : '';
      wrap.innerHTML = `<div class="sub">全社横断の変更履歴（新しい順・${rs.length.toLocaleString()}件）。会社名クリックで詳細へ。${capped}</div><div class="tl">` + rs.map(r => {
        const nm = nameByCid[r.company_id] || r.company_id;
        const isCreate = r.column_name === '(新規作成)';
        const dot = isCreate ? 'create' : (r.approved_by ? 'approve' : 'human');
        const label = this.fieldLabel(r.table_name, r.column_name);
        const diff = isCreate
          ? `<b>${this.esc(r.new_value || '')}</b> を作成`
          : `<a data-hcid="${this.esc(r.company_id)}" style="cursor:pointer;text-decoration:underline">${this.esc(nm)}</a> の <b>${this.esc(label)}</b> を <span class="old">${this.esc(r.old_value === null ? '（空）' : r.old_value)}</span> → <b>${this.esc(r.new_value === null ? '（空）' : r.new_value)}</b>`;
        const appr = !isCreate && r.approved_by ? ` <span class="badge b-green">承認: ${this.esc(r.approved_by)}</span>` : '';
        return `<div class="tlrow"><div class="tldot ${dot}"></div><div><b>${this.esc(r.changed_by)}</b> ${diff}${appr}<div class="ts tnum">${this.esc(this.jstStamp(r.changed_at))}</div></div></div>`;
      }).join('') + '</div>';
      wrap.querySelectorAll('[data-hcid]').forEach(a => a.onclick = () => this.openDetail(a.dataset.hcid));
    } catch (e) {
      wrap.innerHTML = `<div class="alert warn">変更履歴の読み込みに失敗しました: ${this.esc(String(e.message || e))}</div>`;
    }
  },

  // ===== 新規登録（4経路・モックのchooser文言） =====
  openChooser() {
    const ov = this.el('tmk-ov-chooser');
    const body = this.el('tmk-chooser-body');
    if (!ov || !body) return;
    body.innerHTML = `<div class="mf" style="font-size:11.5px;margin-bottom:10px">空欄を埋めるのではなく、まず「どう入れるか」を選びます。どの経路でも<b>申請中</b>として登録され、本人以外の承認で正式登録になります。</div>
      <div class="chooser">
        <button class="mcard" data-m="sansan"><div class="t">① 名刺・Sansan取込 <span class="badge b-sansan">自動</span></div><div class="d">名刺があれば素性が自動で埋まる。人は空欄だけ確認。<b style="color:var(--amber)">API接続は9月以降（手入力フォームへ進みます）</b></div></button>
        <button class="mcard" data-m="hojin"><div class="t">② 法人番号オートフィル</div><div class="d">基本13桁で社名・住所を補完。表記ゆれ・同名会社を回避。登録済みなら既存社を開いて二重登録を防ぎます。</div></button>
        <button class="mcard" data-m="dup"><div class="t">③ 既存社を複製 <span class="badge b-slate">雛形</span></div><div class="d">似た会社の枠組みをコピーして固有情報だけ入力。</div></button>
        <button class="mcard" data-m="quick"><div class="t">④ 名前だけ先行登録 <span class="badge b-amber">最短</span></div><div class="d">社名だけで下書き登録。後から肉付け。</div></button>
      </div>
      <div id="tmk-chooser-extra" style="margin-top:10px"></div>`;
    ov.classList.add('on');
    body.querySelectorAll('.mcard').forEach(b => b.onclick = () => this.chooseMethod(b.dataset.m));
  },

  async chooseMethod(m) {
    const extra = this.el('tmk-chooser-extra');
    if (m === 'sansan') {
      // 名刺経由。Open API（APIキー・会社名で検索）と Data Hub（SOC/法人番号）のどちらが使えるかで入口が変わる
      await TM_ENRICH.probe();
      const useOpen = TM_ENRICH.available('sansan_open');
      const useHub = TM_ENRICH.available('sansan');
      if (!useOpen && !useHub) {
        extra.innerHTML = '<div class="alert warn">Sansan は未接続です。<br>' +
          `・${this.esc(TM_ENRICH.PROVIDERS.sansan_open.label)}: ${this.esc(TM_ENRICH.status.sansan_open.reason)}<br>` +
          `・${this.esc(TM_ENRICH.PROVIDERS.sansan.label)}: ${this.esc(TM_ENRICH.status.sansan.reason)}<br>` +
          '接続後は名刺から会社情報が自動で入ります。今は手入力で登録できます。</div>' +
          '<button class="btn btn-primary" id="tmk-sansan-go">手入力で続ける</button>';
        this.el('tmk-sansan-go').onclick = () => { this.el('tmk-ov-chooser').classList.remove('on'); this.startNew('sansan', {}); };
        return;
      }
      // Open API は会社名検索（法人番号での検索は仕様上できない）。Data Hub は SOC/法人番号。
      const ph = useOpen ? '会社名（名刺に登録されている表記で検索）' : 'SOC(13桁) または 法人番号(13桁)';
      extra.innerHTML =
        (useOpen && !useHub
          ? '<div class="mf" style="font-size:11px;margin-bottom:6px">名刺に載っている情報（社名・住所・電話・FAX・URL）が取得できます。' +
            '法人番号・資本金などは Sansan Open API では取得できません。</div>'
          : '') +
        `<div style="display:flex;gap:8px"><input class="inp" id="tmk-soc" placeholder="${this.esc(ph)}" style="flex:1">` +
        '<button class="btn btn-primary" id="tmk-soc-go">Sansanから取得</button></div>';
      this.el('tmk-soc-go').onclick = () => this.sansanFetch(useOpen ? 'sansan_open' : 'sansan');
      return;
    }
    if (m === 'hojin') {
      extra.innerHTML = `<div style="display:flex;gap:8px"><input class="inp" id="tmk-hojin" maxlength="13" placeholder="法人番号（13桁）" style="flex:1"><button class="btn btn-primary" id="tmk-hojin-go">確認して進む</button></div>`;
      this.el('tmk-hojin-go').onclick = () => this.hojinCheck();
      this.el('tmk-hojin').focus();
      return;
    }
    if (m === 'dup') {
      extra.innerHTML = `<input class="inp" id="tmk-dupq" placeholder="複製元の社名・コードで検索" style="width:100%"><div id="tmk-duphits" style="max-height:180px;overflow:auto;margin-top:6px"></div>`;
      const q = this.el('tmk-dupq'), hits = this.el('tmk-duphits');
      q.oninput = () => {
        const nq = this.norm(q.value);
        if (!nq) { hits.innerHTML = ''; return; }
        const found = (this.rows || []).filter(r => !r.is_suspended &&
          (this.norm(r.official_name).includes(nq) || this.norm((this.codesByCid[r.company_id] || {}).tera).includes(nq))).slice(0, 8);
        hits.innerHTML = found.map(r => `<div class="cmdrow" data-dcid="${this.esc(r.company_id)}">🏢 ${this.esc(r.official_name)} <span class="mf">(コード ${this.esc((this.codesByCid[r.company_id] || {}).tera || '—')})</span></div>`).join('') || '<div class="mf" style="padding:6px">該当なし</div>';
        hits.querySelectorAll('[data-dcid]').forEach(x => x.onclick = async () => {
          this.el('tmk-ov-chooser').classList.remove('on');
          await this.openDetail(x.dataset.dcid);
          this.startDup();
        });
      };
      q.focus();
      return;
    }
    if (m === 'quick') {
      extra.innerHTML = `<div style="border-top:1px solid var(--border);padding-top:10px">
        <input class="inp" id="tmk-qname" maxlength="200" placeholder="正式社名（必須）" style="width:100%">
        <div class="typechips" style="margin-top:8px">${TM_META.TYPES.map(t => `<button class="tc" data-qt="${this.esc(t)}">${this.esc(t)}</button>`).join('')}</div>
        <button class="btn btn-primary" id="tmk-qsave" style="margin-top:4px">下書きで登録</button></div>`;
      extra.querySelectorAll('[data-qt]').forEach(b => b.onclick = () => b.classList.toggle('on'));
      this.el('tmk-qsave').onclick = () => this.quickSave();
      this.el('tmk-qname').focus();
      return;
    }
  },

  async hojinCheck() {
    const num = (this.el('tmk-hojin').value || '').trim();
    if (!/^\d{13}$/.test(num)) { alert('法人番号は13桁の数字です。'); return; }
    const dup = (this.rows || []).find(r => r.corporate_number === num);
    if (dup) {
      this.el('tmk-ov-chooser').classList.remove('on');
      alert(`この法人番号は登録済みです：\n${dup.official_name}\n\n既存の会社を開きます（二重登録の防止）。`);
      this.openDetail(dup.company_id);
      return;
    }
    // 外部APIで補完（キーが無ければ静かに手入力へ）
    this.enrichNotice = null;
    const btn = this.el('tmk-hojin-go');
    if (btn) { btn.disabled = true; btn.textContent = '照会中…'; }
    const prefill = { 'company.corporate_number': num };
    let note = null;
    let usedProvider = null;
    try {
      await TM_ENRICH.probe();
      const provider = TM_ENRICH.available('kokuzei') ? 'kokuzei' : (TM_ENRICH.available('gbizinfo') ? 'gbizinfo' : null);
      usedProvider = provider;
      if (provider) {
        const got = await TM_ENRICH.fetchCompany(provider, { corporateNumber: num });
        if (got) {
          Object.assign(prefill, this.enrichToCols(got.values));
          note = `${TM_ENRICH.PROVIDERS[provider].label} から ${Object.keys(got.values).length}項目を取得しました（内容を確認してください）`;
        } else {
          note = `${TM_ENRICH.PROVIDERS[provider].label} に該当がありませんでした。手入力で登録できます`;
        }
      } else {
        note = 'API未接続のため手入力です（' + (TM_ENRICH.status.kokuzei || {}).reason + '）';
      }
    } catch (e) {
      note = '外部APIの照会に失敗しました: ' + String(e.message || e) + '（手入力で続けられます）';
    }
    if (btn) { btn.disabled = false; btn.textContent = '確認して進む'; }
    this.el('tmk-ov-chooser').classList.remove('on');
    this.startNew('hojin', prefill);
    // API由来の値に印を付ける（法人番号そのものは人の入力なので除く）
    if (usedProvider) {
      const apLabel = TM_ENRICH.PROVIDERS[usedProvider].label.indexOf('gBizINFO') >= 0 ? 'gBizINFO API' : '国税庁API';
      this.apiPrefill = {};
      Object.keys(prefill).forEach(c => {
        if (c !== 'company.corporate_number') this.apiPrefill[c] = { val: prefill[c], label: apLabel };
      });
      this.renderNewFields();
    }
    if (note) this.toast(note);
  },

  // Sansan名刺から採った値の「確からしさ」を人に伝える文言を組み立てる。
  // 🔴同じ会社に支店の名刺が混ざるため、黙って1つ選ぶのは危険。何枚から選んだかを必ず見せる。
  sansanNotice(raw) {
    if (!raw || !raw._matched) return null;
    const parts = [`名刺${raw._matched}枚が該当`];
    if (raw._addressVariants > 1) {
      parts.push(`住所が${raw._addressVariants}種類あり、最も多い1件（${raw._pickedCount}枚）を採用しました`);
      if (raw._otherAddresses && raw._otherAddresses.length) {
        parts.push('他の候補: ' + raw._otherAddresses.join(' / '));
      }
      parts.push('🔴支店の住所が混ざることがあります。本社住所かどうか確認してください');
    }
    return parts.join('。');
  },

  // TM_ENRICH の {項目No: 値} → 新規フォームの {col: 値}
  // 複数列にまたがる項目（社名カナ・本社住所など）は先頭列に入れる（分割は人が直す前提）
  // APIの取得値（項目No→値）を編集パスへ展開する。
  // 複数列の項目（本社住所・社名カナ）は splitValue で列ごとに分解（半角カナは自動変換）。
  enrichToCols(values) {
    const out = {};
    Object.keys(values).forEach(no => {
      const f = this.fieldByNo(+no);
      if (!f) return;
      const plan = this.editPlan(f);   // 承認制・カード系はここで null ＝ 自動で入れない
      if (!plan) return;
      if (plan.kind === 'multi' && this.SPLIT_COLS[f.no]) {
        this.splitValue(f, values[no]).forEach(part => { out[`company.${part.col}`] = part.val; });
        return;
      }
      if (plan.kind === 'single') out[plan.path] = values[no];
    });
    return out;
  },

  // 経路①: Sansan から取得して新規フォームへ（接続済みのときだけ到達する）
  //   provider='sansan_open' … 会社名で名刺を検索（APIキー1本の方）
  //   provider='sansan'      … SOC/法人番号で Data Hub を引く
  async sansanFetch(provider) {
    const v = (this.el('tmk-soc').value || '').trim();
    const isOpen = provider === 'sansan_open';
    if (isOpen) {
      if (v.length < 2) { alert('会社名を入力してください（2文字以上）。'); return; }
    } else if (!/^\d{13}$/.test(v)) {
      alert('SOC または 法人番号を13桁で入力してください。'); return;
    }
    this.enrichNotice = null;
    const btn = this.el('tmk-soc-go');
    if (btn) { btn.disabled = true; btn.textContent = '取得中…'; }
    let prefill = {}, note = null;
    try {
      const params = isOpen ? { name: v } : { soc: v, corporateNumber: v };
      const got = await TM_ENRICH.fetchCompany(provider, params);
      if (got) {
        prefill = this.enrichToCols(got.values);
        this.enrichNotice = this.sansanNotice(got.raw);
        note = `${TM_ENRICH.PROVIDERS[provider].label} から ${Object.keys(got.values).length}項目を取得しました（内容を確認してください）`;
      } else {
        note = '該当する名刺が見つかりませんでした。手入力で登録できます';
      }
    } catch (e) {
      note = 'Sansan の取得に失敗しました: ' + String(e.message || e);
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Sansanから取得'; }
    this.el('tmk-ov-chooser').classList.remove('on');
    // 会社名は検索語をそのまま初期値に（取得できていれば上書きされる）
    if (isOpen && !prefill['company.official_name']) prefill['company.official_name'] = v;
    this.startNew('sansan', prefill);
    // API由来の値に印を付ける（出所バッジが「Sansan API」になる）
    const apLabel = 'Sansan API';
    this.apiPrefill = {};
    Object.keys(prefill).forEach(c => { this.apiPrefill[c] = { val: prefill[c], label: apLabel }; });
    if (isOpen) delete this.apiPrefill['company.official_name'];   // 検索語の初期値はAPI値ではない
    this.renderNewFields();
    if (note) this.toast(note);
  },

  async quickSave() {
    const name = (this.el('tmk-qname') || {}).value || '';
    if (!name.trim()) { alert('正式社名は必須です。'); return; }
    const types = [...document.querySelectorAll('#tmk-chooser-extra .tc.on')].map(b => b.dataset.qt);
    this.el('tmk-ov-chooser').classList.remove('on');
    await this.insertCompany({ official_name: name.trim() }, types, 'quick', {});
  },

  startDup() {
    if (!this.detail || !this.detail.company.company_id) return;
    const d = this.detail;
    const OMIT = ['company_id', 'official_name', 'name_kana', 'name_kana_half', 'name_half', 'corporate_number',
      'representative_name', 'search_name_normalized', 'search_rep_normalized', 'sansan_soc',
      'postal_code', 'prefecture', 'address_line', 'building', 'registered_address', 'phone', 'fax', 'website_url',
      'invoice_reg_number', 'invoice_status', 'is_suspended', 'suspend_reason', 'suspend_merged_into',
      'trade_end_on', 'last_trade_on', 'registration_stage', 'data_source', 'remarks',
      'created_at', 'created_by', 'updated_at', 'updated_by'];
    const seed = {};
    Object.keys(d.company || {}).forEach(k => {
      if (OMIT.indexOf(k) < 0 && d.company[k] !== null) seed['company.' + k] = d.company[k];
    });
    ['company_billing', 'company_subcontractor', 'company_customer', 'company_scrap'].forEach(t => {
      const r = (d[t] || [])[0];
      if (r) Object.keys(r).forEach(k => {
        if (k === 'company_id' || r[k] === null) return;
        if (typeof r[k] === 'object') {   // JSONB（送付先）はキーごとのパスに分解して複製
          Object.keys(r[k]).forEach(jk => { if (r[k][jk] != null) seed[`${t}.${k}#${jk}`] = r[k][jk]; });
          return;
        }
        seed[t + '.' + k] = r[k];
      });
    });
    const types = this.detailTypes();
    this.startNew('dup', {}, seed, types, d.company.official_name);
  },

  startNew(method, prefillCols, dupSeed, types, dupFrom) {
    if (!this.guardUnsaved()) return;
    this.apiPrefill = null;   // APIから来た値の印（sansanFetch/hojinCheck が設定する）
    this.isNew = true;
    this.newMethod = method;
    this.dupFrom = dupFrom || null;
    this.dupSeed = dupSeed || null;
    this.newTypes = (types || []).slice();
    this.newVals = {};
    this.autoNew = {};
    // プレフィル（法人番号・複製値）を入力値として持つ
    Object.keys(prefillCols || {}).forEach(col => { this.newVals[col] = String(prefillCols[col]); });
    Object.keys(dupSeed || {}).forEach(col => {
      const v = dupSeed[col];
      this.newVals[col] = v === true ? 'true' : v === false ? 'false' : String(v);
    });
    this.view = 'new';
    this.markNav();
    this.renderNew();
    const scroller = document.scrollingElement || document.documentElement;
    scroller.scrollTop = 0;
  },

  newFields() {
    // モックの新規と同じ: 共通(*)＋選択種別のブロック
    return TM_META.FIELDS.filter(f => f.types.includes('*') || (() => {
      const blocks = new Set();
      this.newTypes.forEach(t => (TM_META.TYPE_BLOCKS[t] || []).forEach(b => blocks.add(b)));
      return blocks.has(f.block);
    })());
  },

  renderNew() {
    const wrap = this.el('tmk-wrap');
    if (!wrap) return;
    this.el('tmk-title').textContent = '新規登録・編集';
    wrap.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="tmk-back" style="margin-bottom:10px">← 一覧へ</button>
    <div class="grid2">
     <div>
      <div class="sec"><h3>① 種別と入力経路 <span class="badge b-slate">${this.esc(this.NEW_METHOD_LABELS[this.newMethod] || '')}</span></h3>
        <div class="mf" style="font-size:11.5px;margin-bottom:8px">${
          this.newMethod === 'sansan' ? 'Sansan API接続は9月以降の予定です。接続後は名刺から自動で埋まります（今は手入力）。'
          : this.newMethod === 'hojin' ? '法人番号から登録します。国税庁APIオートフィルは接続後に有効になります（今は手入力）。'
          : this.newMethod === 'dup' ? `「${this.esc(this.dupFrom || '')}」の枠組みを複製しました。固有情報だけ入れ替えてください。`
          : '社名だけで下書き登録できます。'}</div>
        ${this.enrichNotice ? `<div class="alert warn" style="font-size:11px;margin:0">${this.esc(this.enrichNotice)}</div>` : ''}
        <div style="font-size:11px;font-weight:700;color:var(--mf2);margin-bottom:4px">取引先種別（選ぶと必要な欄だけ表示）</div>
        <div class="typechips" id="tmk-ntypes">${TM_META.TYPES.map(t => `<button class="tc ${this.newTypes.includes(t) ? 'on' : ''}" data-nt="${this.esc(t)}">${this.esc(t)}</button>`).join('')}</div>
      </div>
      ${this.fmtBarHtml()}
      <div id="tmk-nfields"></div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn" id="tmk-ncancel">キャンセル</button>
        <span style="flex:1"></span>
        <button class="btn btn-primary" id="tmk-nsave" ${this.busy ? 'disabled' : ''}>${this.busy ? '登録中…' : '💾 申請中として登録'}</button>
      </div>
     </div>
     <div>
      <div class="sec" style="position:sticky;top:64px"><h3>🤖 AIチェック</h3><div class="mf" style="font-size:11px;margin-bottom:6px">保存時に自動点検。要確認が残っても下書き（申請中）にはできます。</div><div id="tmk-nai"></div></div>
      <div class="sec"><h3>外部APIからの取得</h3><div class="mf" style="font-size:11px;margin-bottom:8px">会社情報を自動で埋める取得元。未接続でも手入力で登録できます</div>
        <div id="tmk-enrich-status">${TM_ENRICH.statusHtml()}</div></div>
      <div class="sec"><h3>登録後に必要な作業</h3><div class="mf" style="font-size:11px;margin-bottom:8px">🔴自動配信はありません。承認後、各システムへは<b>人が手で登録</b>します（API配信は今回スコープ外）</div>${
        this.SYSLINK.map(s => `<div class="slink"><span class="nm2">${this.esc(s.name)}</span>${s.mode === 'manual' ? '<span class="badge b-amber">要・手動登録</span>' : '<span class="badge b-slate">対象外（今後）</span>'}</div>`).join('')}</div>
     </div>
    </div>`;
    this.el('tmk-back').onclick = () => { if (this.guardUnsaved()) { this.isNew = false; this.go('list'); } };
    this.el('tmk-ncancel').onclick = () => { if (this.guardUnsaved()) { this.isNew = false; this.go('list'); } };
    this.el('tmk-nsave').onclick = () => this.saveNew();
    this.el('tmk-ntypes').querySelectorAll('[data-nt]').forEach(b => b.onclick = () => {
      const t = b.dataset.nt;
      const i = this.newTypes.indexOf(t);
      if (i >= 0) this.newTypes.splice(i, 1); else this.newTypes.push(t);
      b.classList.toggle('on');
      this.renderNewFields();
      this.refreshNewAi();
    });
    const bar = wrap;
    this.wireFmtBar(bar, () => this.renderNewFields());
    this.renderNewFields();
    // プレフィル済み（法人番号経路・複製）でも自動判定を効かせる。埋まったら描き直して反映
    this.syncAutoJudgeNew(null, null);
    this.renderNewFields();
    this.refreshNewAi();
  },

  renderNewFields() {
    const host = this.el('tmk-nfields');
    if (!host) return;
    this.renderFieldsGeneric(host, this.newFields(), this.newApi());
  },

  // 新規画面の項目値（複数欄は結合表示）。#53は種別チップの選択を映す
  newFieldValue(f) {
    if (f.no === 53) return this.newTypes.join('・');
    return this.fieldPaths(f).map(p => this.newVals[p])
      .filter(v => v !== undefined && String(v).trim() !== '').join(' ／ ');
  },
  newApi() {
    return {
      get: p => this.newVals[p] !== undefined ? this.newVals[p] : '',
      set: (f, p, val) => {
        if (String(val).trim() === '') delete this.newVals[p]; else this.newVals[p] = val;
        this.syncAutoJudgeNew(f, p);
        this.refreshNewAi();
      },
      val: f => this.newFieldValue(f),
      srcOf: f => {
        // 実際の出所主義（2026-08-26整理）: 値が無い欄に「Sansanから取れる予定」の予告は出さない
        if (f.approval) return ['lock', '🔒承認'];
        if (f.no === 1) return ['code', 'コード'];
        if (f.no === 53) return this.newTypes.length ? ['edit', '手入力'] : ['none', '—'];
        const paths = this.fieldPaths(f);
        const filled = paths.filter(p => this.newVals[p] !== undefined && String(this.newVals[p]).trim() !== '');
        if (!filled.length) return ['none', '—'];
        // APIから取得してプレフィルされた値（未編集）→「○○ API」
        if (this.apiPrefill) {
          const hit = filled.find(p => this.apiPrefill[p] && String(this.apiPrefill[p].val) === String(this.newVals[p]));
          if (hit) return ['api', this.apiPrefill[hit].label];
        }
        // 自動判定で入った値（人が触っていない）→「自動判定」
        if (filled.some(p => this.autoNew[p] !== undefined && String(this.autoNew[p]) === String(this.newVals[p])))
          return ['auto', '自動判定'];
        if (this.dupSeed && filled.some(p => this.dupSeed[p] !== undefined && String(this.dupSeed[p]) === String(this.newVals[p]))) return ['mig', '複製'];
        return ['edit', '手入力'];
      },
      types: () => this.newTypes.slice(),
      setTypes: null,   // 新規は上の種別チップで選ぶ
    };
  },

  refreshNewAi() {
    const a = this.el('tmk-nai');
    if (a) a.innerHTML = this.aiHtml(f => this.newFieldValue(f), this.newTypes);
  },

  // 新規登録フォーム: 社名・法人番号・住所を入れた時点で、空欄の区分を自動で埋める。
  // 🔴再描画はしない（入力中にフォーカスを奪わないため）。対象欄のDOMとバッジだけを直接更新する。
  syncAutoJudgeNew(f, changedPath) {
    const host = this.el('tmk-nfields');
    if (!host) return;
    // 人が区分そのものを触った → その欄は以後、自動判定で上書きしない
    if (f && this.AUTO_BY_NO[f.no]) { delete this.autoNew[changedPath]; return; }
    Object.keys(this.AUTO_BY_NO).forEach(noStr => {
      const no = Number(noStr);
      const fd = this.fieldByNo(no);
      const plan = fd && this.editPlan(fd);
      if (!plan || !plan.path) return;
      const path = plan.path;
      const cur = this.newVals[path];
      const curStr = cur === undefined || cur === null ? '' : String(cur);
      const isAuto = this.autoNew[path] !== undefined && String(this.autoNew[path]) === curStr;
      if (curStr.trim() !== '' && !isAuto) return;      // 人が入れた値は触らない
      const j = this.autoJudge(no, p => (this.newVals[p] === undefined ? '' : this.newVals[p]));
      const next = j ? j.val : '';
      if (curStr === next) return;
      if (next === '') { delete this.newVals[path]; delete this.autoNew[path]; }
      else { this.newVals[path] = next; this.autoNew[path] = next; }
      const el = host.querySelector(`[data-path="${CSS.escape(path)}"]`);
      if (el) el.value = next;
      const badge = host.querySelector(`.src[data-src="${CSS.escape(fd.col)}"]`);
      if (badge) { const [sc, sl] = this.newApi().srcOf(fd); badge.className = 'src ' + sc; badge.textContent = sl; }
    });
  },

  nextCompanyId() {
    let max = 2563;
    (this.rows || []).forEach(r => { if (/^\d+$/.test(r.company_id)) max = Math.max(max, +r.company_id); });
    return max + 1;
  },

  async saveNew() {
    if (this.busy || !this.isNew) return;
    const errs = [];
    const coVals = {};
    const subTables = {};   // 1社1行テーブル（JSONBは列単位のオブジェクトに組む）
    const keyedRows = [];   // system_code / permit_license の行
    Object.keys(this.newVals).forEach(path => {
      const meta = this.pathMeta(path);
      if (!meta) return;
      const msg = this.inputErrorDt(meta.dtype, this.newVals[path]);
      if (msg) { errs.push(`・${meta.label}: ${msg}`); return; }
      const v = this.normInDt(meta.dtype, this.newVals[path], meta.norm);
      if (v === null) return;
      const p = this.parsePath(path);
      if (p.jsonKey) {
        const t = (subTables[p.table] = subTables[p.table] || {});
        (t[p.column] = t[p.column] || {})[p.jsonKey] = v;
      } else if (p.keyVal) {
        let g = keyedRows.find(x => x.table === p.table && x.keyVal === p.keyVal);
        if (!g) { g = { table: p.table, keyCol: p.keyCol, keyVal: p.keyVal, patch: {} }; keyedRows.push(g); }
        g.patch[p.column] = v;
      } else if (p.table === 'company') coVals[p.column] = v;
      else (subTables[p.table] = subTables[p.table] || {})[p.column] = v;
    });
    if (errs.length) { alert('入力を確認してください。\n\n' + errs.join('\n')); return; }
    if (!coVals.official_name) { alert('正式社名は必須です。'); return; }
    if (coVals.corporate_number) {
      const dup = (this.rows || []).find(r => r.corporate_number === coVals.corporate_number);
      if (dup) { alert(`この法人番号は登録済みです：${dup.official_name}\n二重登録はできません。`); return; }
    }
    if (!confirm(`「${coVals.official_name}」を申請中として登録します。\n\n会社マスタIDが採番され、本人以外の admin/accounting の承認で正式登録になります。よろしいですか？`)) return;
    this.busy = true;
    const btn = this.el('tmk-nsave');
    if (btn) { btn.disabled = true; btn.textContent = '登録中…'; }
    const cid = await this.insertCompany(coVals, this.newTypes, this.newMethod, subTables, keyedRows);
    this.busy = false;
    if (cid === null && btn) { btn.disabled = false; btn.textContent = '💾 申請中として登録'; }
  },

  // 新規登録の書込本体（quick とフル・フォームの共通経路・採番リトライ付き）
  async insertCompany(coVals, typeLabels, method, subTables, keyedRows) {
    const who = this.whoAmI();
    const sb = this.getClient();
    const typeCodes = typeLabels.map(l => Object.keys(TM_META.TYPE_CODES).find(c => TM_META.TYPE_CODES[c] === l)).filter(Boolean);
    let cid = null;
    const n = this.nextCompanyId();
    for (let attempt = 0; attempt < 5; attempt++) {
      const tryId = String(n + attempt).padStart(8, '0');
      const res = await sb.from('company').insert(Object.assign({
        company_id: tryId, registration_stage: 'temp', data_source: method,
        created_by: who, updated_by: who,
      }, coVals));
      if (!res.error) { cid = tryId; break; }
      if (!/duplicate|23505/i.test(res.error.message || '')) { alert('登録に失敗しました: ' + res.error.message); return null; }
    }
    if (!cid) { alert('採番が競合しました。もう一度お試しください。'); return null; }

    const warn = [];
    if (typeCodes.length) {
      const r = await sb.from('company_type').insert(typeCodes.map(t => ({ company_id: cid, type_code: t })));
      if (r.error) warn.push('種別: ' + r.error.message);
    }
    for (const t of Object.keys(subTables || {})) {
      const row = subTables[t];
      if (row && Object.keys(row).length) {
        const r = await sb.from(t).insert(Object.assign({ company_id: cid }, row));
        if (r.error) warn.push(`${t}: ${r.error.message}`);
      }
    }
    // キー付きテーブル（各システムコード・許認可）
    for (const g of keyedRows || []) {
      const row = Object.assign({ company_id: cid }, g.patch);
      row[g.keyCol] = g.keyVal;
      if (g.table === 'system_code' && !row.code) continue;   // code は NOT NULL
      const r = await sb.from(g.table).insert(row);
      if (r.error) {
        warn.push(`${g.table}: ` + (/duplicate|23505/i.test(r.error.message || '')
          ? `コードが他社と重複しています（${this.SYSTEM_LABEL[g.keyVal] || g.keyVal}）` : r.error.message));
      }
    }
    const histRows = [{
      company_id: cid, table_name: 'company', column_name: '(新規作成)',
      old_value: null, new_value: `${coVals.official_name || ''}（経路: ${this.NEW_METHOD_LABELS[method] || method}${this.dupFrom ? '・複製元: ' + this.dupFrom : ''}）`,
      changed_by: who,
    }];
    Object.keys(coVals).forEach(k => {
      if (coVals[k] !== null && k !== 'official_name') histRows.push({
        company_id: cid, table_name: 'company', column_name: k,
        old_value: null, new_value: String(coVals[k]),
        // 自動判定で入った値（人が触っていない）は印を残す＝出所バッジが「自動判定」になる
        changed_by: (this.autoNew['company.' + k] !== undefined
          && String(this.autoNew['company.' + k]) === String(coVals[k])) ? who + '(自動判定)' : who,
      });
    });
    const rh = await sb.from('company_history').insert(histRows);
    if (rh.error) warn.push('履歴: ' + rh.error.message);
    if (warn.length) alert('登録は完了しましたが、一部の保存に失敗しました:\n' + warn.join('\n'));

    // 一覧キャッシュへ反映（company 全列キャッシュに合わせる）
    if (this.rows) {
      const row = Object.assign({ company_id: cid, is_suspended: false, registration_stage: 'temp', created_by: who, updated_by: who, data_source: method }, coVals);
      this.rows.push(row);
      this.typesByCid[cid] = typeCodes.slice();
      (keyedRows || []).filter(g => g.table === 'system_code' && g.patch.code).forEach(g => {
        (this.codesByCid[cid] = this.codesByCid[cid] || {})[g.keyVal] = g.patch.code;
      });
    }
    this.isNew = false;
    this.newMethod = null;
    this.dupFrom = null;
    this.dupSeed = null;
    this.newVals = {};
    this.autoNew = {};
    this.newTypes = [];
    this.toast(`登録しました（会社マスタID ${+cid}・申請中）`);
    await this.openDetail(cid);
    return cid;
  },

  // ===== CSV出力（モック互換ヘッダ「no:項目名」・一覧で解決できる値） =====
  expCSV() {
    if (this.rows === null) return;
    const fields = TM_META.FIELDS;
    const rows = [['取引先マスタ番号', 'システムコード', ...fields.map(f => f.no + ':' + f.name)]];
    this.rows.forEach(r => {
      rows.push([+r.company_id, (this.codesByCid[r.company_id] || {}).tera || '',
        ...fields.map(f => this.getListVal(r, f) || '')]);
    });
    const csv = '﻿' + rows.map(row => row.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = '取引先マスタ_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.csv';
    a.click();
    this.toast(`CSVを出力しました（${this.rows.length.toLocaleString()}社）`);
  },

  // ===== 複数列にまたがる項目の分解（CSV取込・外部API補完で使う） =====
  // 🔴外部APIは「本社住所」を1本の文字列で返すが、スキーマは3列（都道府県/番地/建物）に分かれている。
  //   一括補完で最も埋めたいのがこの2項目のため、取込時に分解する経路を用意する。
  SPLIT_COLS: {
    25: [   // 本社住所
      { col: 'prefecture', label: '都道府県', dtype: 'VARCHAR(20)' },
      { col: 'address_line', label: '番地', dtype: 'VARCHAR(200)' },
      { col: 'building', label: '建物', dtype: 'VARCHAR(100)' },
    ],
    3: [    // 社名カナ
      { col: 'name_kana', label: '全角カナ', dtype: 'VARCHAR(200)' },
      { col: 'name_kana_half', label: '半角カナ', dtype: 'VARCHAR(200)' },
    ],
  },
  PREFS: ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
    '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
    '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
    '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
    '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'],

  // 全角カナ → 半角カナ（teraServationは振込名義人が半角カナでないと通らない＝ブリーフ§9-6）
  toHalfKana(s) {
    const M = {
      'ガ': 'ｶﾞ', 'ギ': 'ｷﾞ', 'グ': 'ｸﾞ', 'ゲ': 'ｹﾞ', 'ゴ': 'ｺﾞ', 'ザ': 'ｻﾞ', 'ジ': 'ｼﾞ', 'ズ': 'ｽﾞ', 'ゼ': 'ｾﾞ', 'ゾ': 'ｿﾞ',
      'ダ': 'ﾀﾞ', 'ヂ': 'ﾁﾞ', 'ヅ': 'ﾂﾞ', 'デ': 'ﾃﾞ', 'ド': 'ﾄﾞ', 'バ': 'ﾊﾞ', 'ビ': 'ﾋﾞ', 'ブ': 'ﾌﾞ', 'ベ': 'ﾍﾞ', 'ボ': 'ﾎﾞ',
      'パ': 'ﾊﾟ', 'ピ': 'ﾋﾟ', 'プ': 'ﾌﾟ', 'ペ': 'ﾍﾟ', 'ポ': 'ﾎﾟ', 'ヴ': 'ｳﾞ',
      'ア': 'ｱ', 'イ': 'ｲ', 'ウ': 'ｳ', 'エ': 'ｴ', 'オ': 'ｵ', 'カ': 'ｶ', 'キ': 'ｷ', 'ク': 'ｸ', 'ケ': 'ｹ', 'コ': 'ｺ',
      'サ': 'ｻ', 'シ': 'ｼ', 'ス': 'ｽ', 'セ': 'ｾ', 'ソ': 'ｿ', 'タ': 'ﾀ', 'チ': 'ﾁ', 'ツ': 'ﾂ', 'テ': 'ﾃ', 'ト': 'ﾄ',
      'ナ': 'ﾅ', 'ニ': 'ﾆ', 'ヌ': 'ﾇ', 'ネ': 'ﾈ', 'ノ': 'ﾉ', 'ハ': 'ﾊ', 'ヒ': 'ﾋ', 'フ': 'ﾌ', 'ヘ': 'ﾍ', 'ホ': 'ﾎ',
      'マ': 'ﾏ', 'ミ': 'ﾐ', 'ム': 'ﾑ', 'メ': 'ﾒ', 'モ': 'ﾓ', 'ヤ': 'ﾔ', 'ユ': 'ﾕ', 'ヨ': 'ﾖ',
      'ラ': 'ﾗ', 'リ': 'ﾘ', 'ル': 'ﾙ', 'レ': 'ﾚ', 'ロ': 'ﾛ', 'ワ': 'ﾜ', 'ヲ': 'ｦ', 'ン': 'ﾝ',
      'ァ': 'ｧ', 'ィ': 'ｨ', 'ゥ': 'ｩ', 'ェ': 'ｪ', 'ォ': 'ｫ', 'ッ': 'ｯ', 'ャ': 'ｬ', 'ュ': 'ｭ', 'ョ': 'ｮ',
      'ー': 'ｰ', '・': '･', '　': ' ',
    };
    return String(s || '').replace(/[ァ-ヴー・　]/g, c => M[c] || c);
  },

  // 1本の値を複数列へ分解する。戻り値: [{col, label, val, dtype}]
  splitValue(f, raw) {
    const s = String(raw || '').trim();
    const defs = this.SPLIT_COLS[f.no] || [];
    if (!s) return [];
    if (f.no === 25) {
      // 都道府県を切り出す。建物名は判別が難しいため番地にまとめ、人の確認に委ねる
      const pref = this.PREFS.find(p => s.startsWith(p)) || '';
      const rest = pref ? s.slice(pref.length).trim() : s;
      return [
        { col: 'prefecture', label: '都道府県', val: pref || null, dtype: 'VARCHAR(20)' },
        { col: 'address_line', label: '番地', val: rest || null, dtype: 'VARCHAR(200)' },
      ].filter(x => x.val);
    }
    if (f.no === 3) {
      // 全角カナと、そこから機械変換した半角カナ。半角社名(name_half)は別物なので触らない
      return [
        { col: 'name_kana', label: '全角カナ', val: s, dtype: 'VARCHAR(200)' },
        { col: 'name_kana_half', label: '半角カナ', val: this.toHalfKana(s), dtype: 'VARCHAR(200)' },
      ];
    }
    return defs.map(d => ({ col: d.col, label: d.label, val: s, dtype: d.dtype }));
  },

  // ===== CSV取込（モック互換形式・差分プレビュー→確定で履歴つき一括更新） =====
  parseCSV(t) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) {
        if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && t[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  },

  impCSV(file) {
    const rd = new FileReader();
    rd.onload = () => {
      const rows = this.parseCSV(String(rd.result).replace(/^﻿/, ''));
      if (rows.length < 2) { this.toast('CSVが読めません'); return; }
      const head = rows[0];
      const ni = head.indexOf('取引先マスタ番号');
      if (ni < 0) { alert('ヘッダに『取引先マスタ番号』が必要です（CSV出力の形式で読み込めます）。'); return; }
      // "no:項目名" 列 → company.* 項目を取込対象にする。
      // 🔴複数列にまたがる項目（本社住所＝都道府県/番地/建物・社名カナ＝全角/半角カナ/半角社名）も受ける。
      //   これらは isEditable() が false だが、外部APIからの一括補完で最も埋めたい項目のため
      //   CSV取込に限って「1本の文字列を複数列へ分解する」経路を用意する（画面の手入力は段階Dで対応）。
      const colIdx = {};
      head.forEach((h, ix) => {
        const m = String(h).match(/^(\d+):/);
        if (!m) return;
        const f = this.fieldByNo(+m[1]);
        if (!f || !f.col || !f.col.startsWith('company.')) return;
        if (this.isEditable(f) || this.SPLIT_COLS[f.no]) colIdx[ix] = f;
      });
      const byNo = {};
      (this.rows || []).forEach(r => byNo[+r.company_id] = r);
      const changes = [];   // {cid, f, oldV, newV}
      const skipped = [];
      rows.slice(1).forEach(rw => {
        const no = +rw[ni];
        const row = byNo[no];
        if (!row) { if (rw[ni] !== '') skipped.push(no); return; }
        for (const ix in colIdx) {
          const f = colIdx[ix];
          const raw = rw[ix] || '';
          if (this.SPLIT_COLS[f.no]) {
            // 1本の文字列を複数列へ分解する（本社住所・社名カナ）
            this.splitValue(f, raw).forEach(part => {
              const oldV = row[part.col];
              if (this.sameVal(oldV, part.val)) return;
              changes.push({
                cid: row.company_id, name: row.official_name,
                f: { no: f.no, name: `${f.name}（${part.label}）`, col: `company.${part.col}`, dtype: part.dtype },
                oldV, newV: part.val,
              });
            });
            continue;
          }
          const newV = this.normIn(f, raw);
          const oldV = row[f.col.split('.')[1]];
          if (this.inputError(f, raw)) continue;
          if (!this.sameVal(oldV, newV)) changes.push({ cid: row.company_id, name: row.official_name, f, oldV, newV });
        }
      });
      if (!changes.length) { this.toast('変更はありません（CSVは現在の値と同じです）'); return; }
      if (changes.length > 500) { alert(`変更が${changes.length}件あります。一度に取り込めるのは500件までです。CSVを分割してください。`); return; }
      this.showCsvPreview(changes, skipped);
    };
    rd.readAsText(file, 'utf-8');
  },

  // sourceTag: 反映経路の出所ラベル（'gBizINFO' 等）。履歴の changed_by に「(gBizINFO)」の形で残り、
  //   画面の出所バッジが「gBizINFO API」と表示する根拠になる。省略時は手動のCSV取込。
  showCsvPreview(changes, skipped, sourceTag) {
    this._csvSourceTag = sourceTag || 'CSV取込';
    const ov = this.el('tmk-ov-csv');
    const body = this.el('tmk-csv-body');
    const nCo = new Set(changes.map(c => c.cid)).size;
    body.innerHTML = `<div class="mf" style="font-size:12px;margin-bottom:8px"><b>${nCo}社・${changes.length}件</b>の変更を検出しました。適用すると1件ずつ変更履歴に記録されます。${skipped.length ? `<br>⚠ マスタ番号が見つからない行: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ' …' : ''}` : ''}</div>
      <div style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:8px;margin-bottom:12px">` +
      changes.slice(0, 30).map(c => `<div style="padding:5px 10px;border-bottom:1px solid var(--muted);font-size:11.5px"><b>${this.esc(c.name)}</b> ${this.esc(c.f.name)}: <span class="mf" style="text-decoration:line-through">${this.esc(c.oldV === null || c.oldV === undefined ? '（空）' : String(c.oldV))}</span> → <b>${this.esc(c.newV === null ? '（空）' : String(c.newV))}</b></div>`).join('') +
      (changes.length > 30 ? `<div class="mf" style="padding:5px 10px;font-size:11px">…ほか${changes.length - 30}件</div>` : '') +
      `</div><div style="display:flex;gap:8px"><button class="btn" data-tmk-ovclose>やめる</button><span style="flex:1"></span><button class="btn btn-primary" id="tmk-csv-apply">適用する（${changes.length}件）</button></div>`;
    ov.classList.add('on');
    this.el('tmk-csv-apply').onclick = () => this.applyCsv(changes);
  },

  async applyCsv(changes) {
    const sourceTag = this._csvSourceTag || 'CSV取込';
    const btn = this.el('tmk-csv-apply');
    if (btn) { btn.disabled = true; btn.textContent = '適用中…'; }
    const who = this.whoAmI();
    const sb = this.getClient();
    try {
      // 履歴を先に書く（1件ずつの記録・ブリーフ§6）
      const ins = await sb.from('company_history').insert(changes.map(c => ({
        company_id: c.cid, table_name: 'company', column_name: c.f.col.split('.')[1],
        old_value: c.oldV === null || c.oldV === undefined ? null : String(c.oldV),
        new_value: c.newV === null ? null : String(c.newV),
        changed_by: who + '(' + sourceTag + ')',
      })));
      if (ins.error) throw new Error('変更履歴の記録に失敗しました: ' + ins.error.message);
      // 会社ごとにまとめて更新
      const byCid = {};
      changes.forEach(c => { (byCid[c.cid] = byCid[c.cid] || {})[c.f.col.split('.')[1]] = c.newV; });
      let doneN = 0;
      for (const cid of Object.keys(byCid)) {
        const patch = Object.assign({}, byCid[cid], { updated_at: new Date().toISOString(), updated_by: who });
        const res = await sb.from('company').update(patch).eq('company_id', cid);
        if (res.error) throw new Error(`${cid} の更新に失敗しました（${doneN}社適用済み）: ` + res.error.message);
        const row = (this.rows || []).find(r => r.company_id === cid);
        if (row) Object.assign(row, byCid[cid]);
        doneN++;
      }
      this.el('tmk-ov-csv').classList.remove('on');
      this.toast(`${doneN}社を更新しました（CSV取込・履歴記録済み）`);
      if (this.view === 'list') this.renderList();
    } catch (e) {
      alert('CSV取込に失敗しました。\n\n' + (e.message || e) + '\n\n適用済みの分は変更履歴で確認できます。');
      if (btn) { btn.disabled = false; btn.textContent = '適用する'; }
    }
  },

  // ===== ⌘K コマンドパレット =====
  openCmd() {
    const ov = this.el('tmk-ov-cmd');
    const inp = this.el('tmk-cmd-input');
    if (!ov || !inp) return;
    inp.value = '';
    this._cmdSel = 0;
    this.buildCmd('');
    ov.classList.add('on');
    setTimeout(() => inp.focus(), 30);
    inp.oninput = () => { this._cmdSel = 0; this.buildCmd(inp.value); };
  },

  buildCmd(q) {
    const nq = this.norm(q);
    this._cmdItems = (this.rows || []).filter(r => !nq || this.norm(r.official_name).includes(nq)
      || this.norm((this.codesByCid[r.company_id] || {}).tera).includes(nq) || this.norm(String(+r.company_id)).includes(nq))
      .slice(0, 10)
      .map(r => ({ label: `🏢 ${r.official_name}  (No.${+r.company_id}${(this.codesByCid[r.company_id] || {}).tera ? ' / ' + (this.codesByCid[r.company_id] || {}).tera : ''})`, cid: r.company_id }));
    this.drawCmd();
  },

  drawCmd() {
    const list = this.el('tmk-cmd-list');
    if (!list) return;
    list.innerHTML = this._cmdItems.map((it, i) => `<div class="cmdrow ${i === this._cmdSel ? 'sel' : ''}" data-i="${i}">${this.esc(it.label)}</div>`).join('') || '<div class="cmdrow mf">該当なし</div>';
    list.querySelectorAll('[data-i]').forEach(r => r.onclick = () => {
      const it = this._cmdItems[+r.dataset.i];
      this.el('tmk-ov-cmd').classList.remove('on');
      if (it) this.openDetail(it.cid);
    });
  },

  cmdKey(e) {
    if (e.key === 'ArrowDown') { this._cmdSel = Math.min(this._cmdItems.length - 1, this._cmdSel + 1); this.drawCmd(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { this._cmdSel = Math.max(0, this._cmdSel - 1); this.drawCmd(); e.preventDefault(); }
    else if (e.key === 'Enter' && this._cmdItems[this._cmdSel]) {
      const it = this._cmdItems[this._cmdSel];
      this.el('tmk-ov-cmd').classList.remove('on');
      this.openDetail(it.cid);
    }
  },
};
