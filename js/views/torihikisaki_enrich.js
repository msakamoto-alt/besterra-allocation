/**
 * torihikisaki_enrich.js - 取引先マスタ 外部API取得（エンリッチ）の受け口
 *
 * 開発ブリーフ§7-1「API連携の下調べ（最優先）」。取得元は名刺の有無で分岐する:
 *   A 名刺あり → Sansan Data Hub（国税庁情報も一緒に来る）
 *   B 名刺なし → 国税庁 法人番号Web-API
 *   C 販管費先（請求書だけ）→ 国税庁 法人番号Web-API
 *
 * 🔴設計の前提:
 * - ブラウザから外部APIは直接呼べない（CORS）。呼び出しは Edge Function `torihikisaki-enrich` を経由する。
 *   APIキーはサーバー側（Edge Functionの環境変数）にのみ置き、ブラウザには出さない。
 * - キー未設定のプロバイダは available()=false を返し、画面は「未接続」と理由を出して手入力に落ちる。
 *   ＝キーが届いたら Edge Function に環境変数を足すだけで、画面側の改修なしに動き出す。
 * - 取得値は **提案** であって確定ではない。必ず差分プレビューを出し、人が採用/却下する
 *   （出所ガバナンス＝経理の確定値を自動で上書きしない）。
 *
 * キーの入手状況（2026-08-26時点・ブリーフ§7-1）:
 *   国税庁 法人番号Web-API … アプリケーションID申請中（9月上旬見込み）
 *   gBizINFO             … トークン未申請（即時発行）
 *   Sansan Data Hub      … client_id/secret＋feedID を Sansan 担当者へ申請（長谷部さん待ち）
 */
const TM_ENRICH = {
  // ===== プロバイダ定義 =====
  // fields: そのAPIが返す値 → 取引先マスタの項目No。ここが「どのAPIで何が埋まるか」の正本。
  PROVIDERS: {
    kokuzei: {
      label: '国税庁 法人番号Web-API',
      keyName: 'NTA_APP_ID',
      needs: '法人番号13桁 または 商号',
      note: 'アプリケーションID申請中（9月上旬見込み）。全件データは入手済みのため、届き次第すぐ結線できる',
      // 国税庁APIの返却項目 → 項目No
      map: {
        corporateNumber: 6,        // 法人番号(13桁)
        name: 2,                   // 正式社名
        furigana: 3,               // 社名カナ（全角フリガナ）
        postCode: 24,              // 本社住所(〒)
        address: 25,               // 本社住所（都道府県+市区町村+丁目番地）
        kind: 14,                  // 法人/個人区分（法人種別コード）
        addressOutside: 15,        // 国内/海外区分の手がかり
        registeredAddress: 26,     // 本店所在地(登記簿)
      },
    },
    // ===== 国税庁 適格請求書発行事業者公表システム Web-API =====
    // 🔴他のAPIと役割が違う。「値を埋める」のではなく **登録の失効・取消を見張る** ためのもの。
    //   インボイスは登録後に失効・取消がありうる（塩田さんの移行時点で失効13社・他社番号14社を検出済み）。
    //   T番号を持つ1,566社（有効社の67%）が定期照会の対象。
    //
    // 仕様（公式PDF k-web-api-tetuduki.pdf で確認済み・推測ではない・2026-08-26）:
    //   ベース: https://web-api.invoice-kohyo.nta.go.jp/1/
    //   ① num   … 登録番号を指定（**1〜最大10件**）。?id=&number=T…,T…&type=&history=
    //   ② diff  … 取得期間を指定（最大50日）。?id=&from=&to=&type=&division=&divide=
    //   ③ valid … 登録番号＋基準日で直近の状態。?id=&number=&day=&type=  ←**失効判定はこれが最適**
    //   更新は **1回/日・翌開庁日の午前6時**（＝1日1回のバッチ照会で十分。頻繁に叩く意味がない）
    //   アプリケーションIDは無償。発行届出→申請書提出→国税庁の審査。本番/検証で同じIDが使える
    //   🔴「利用が著しく集中した場合等には利用を制限することがある」＝礼儀正しく叩くこと
    invoice: {
      label: '国税庁 インボイス公表システム',
      keyName: 'NTA_INVOICE_APP_ID',
      needs: '登録番号（T+13桁）',
      note: '**値を埋めるのではなく失効・取消を見張る**用途。1リクエスト最大10件・更新は1日1回（午前6時）',
      // このプロバイダは「項目を埋める」より「状態を検証する」ため、mapは最小限
      map: {
        registratedNumber: 33,   // 適格請求書発行事業者 登録番号(T番号)
      },
    },

    // ===== gBizINFO（経済産業省・法人情報） =====
    // 認証: X-hojinInfo-api-token ／ GET https://info.gbiz.go.jp/hojin/v1/hojin/{法人番号13桁}
    // 🔴フィールド名は公式クライアントの HojinInfo モデル定義で確認済み（推測ではない・2026-08-26）
    //   全30項目: business_items, business_summary, capital_stock, certification, close_cause,
    //   close_date, commendation, company_size_female, company_size_male, company_url,
    //   corporate_number, date_of_establishment, employee_number, finance, founding_year, kana,
    //   location, name, name_en, number_of_activity, patent, postal_code, procurement,
    //   qualification_grade, representative_name, representative_position, status, subsidy,
    //   update_date, workplace_info
    // 🔴**本社住所（location）は登記情報が元＝#25の正しい取得元**（名刺の拠点住所とは違う）
    gbizinfo: {
      label: 'gBizINFO',
      keyName: 'GBIZINFO_TOKEN',
      needs: '法人番号13桁',
      note: '接続済み。**本社住所・郵便番号・法人番号・社名・カナは実測100%**（登記ベース）。代表者名・資本金等は企業規模により20〜89%',
      map: {
        corporate_number: 6,       // 法人番号(13桁)
        name: 2,                   // 正式社名
        kana: 3,                   // 社名カナ
        postal_code: 24,           // 本社郵便番号
        location: 25,              // 本社住所（登記ベース＝名刺の拠点住所ではない）
        representative_name: 7,    // 代表者名
        capital_stock: 11,         // 資本金
        employee_number: 21,       // 従業員数
        date_of_establishment: 9,  // 設立年月日
        business_summary: 20,      // 事業内容・会社概要
        company_url: 31,           // URL(HP)
        // 🔴 certification（届出・認定情報）は **#88 建設業許可に使えない**（2026-08-26 実データで確定）。
        //   別エンドポイント GET /v1/hojin/{法人番号}/certification で取れる中身は
        //   **全省庁統一資格（政府調達の競争参加資格）** であり、建設業許可（大臣/知事許可）ではない。
        //     例) ベステラ株式会社: 「物品の製造／販売／役務の提供等:C／物品の買受け:A」＋デジタル庁
        //         ある協力会社: 「競争参加資格」＋法務省・有効期限 2021-03-31
        //   03_項目定義は #88 の取得元を「許可証の写し／gBizINFOの許認可情報」としているが、
        //   **gBizINFO側は当てにできない** → 建設業許可の有効期限は許可証の写し（届出）で人が入れる。
        //   ※塩田さんへの確認事項（9月中旬）。
      },
    },
    // ===== Sansan Open API（名刺管理）＝APIキー1本で使える方 =====
    // 🔴Data Hub とは別物。会社専用のエンドポイントは無く、会社情報は「名刺」に載っている分だけ取れる。
    //   法人番号・資本金・従業員数・売上・上場区分は**取得できない**（そちらは Data Hub / 国税庁APIの担当）。
    //   認証: X-Sansan-Api-Key（32桁）／レート制限: 10回/秒
    //   仕様: https://docs.ap.sansan.com/ja/api/openapi/v3.1/index.html
    sansan_open: {
      label: 'Sansan Open API（名刺）',
      keyName: 'SANSAN_API_KEY',
      needs: '会社名（名刺の登録会社名で検索）',
      note: '名刺に載っている情報のみ。住所は所属拠点＝本社とは限らないため対象外。社名とURLのみ提案する',
      // GET /v3.1/bizCards/search の BizCard オブジェクト → 項目No
      // 🔴2026-08-26 実データで11/11の項目名一致を確認済み（sansan_probe_call.py）
      //
      // 🔴住所・郵便番号・電話・FAXは **意図的に対象外**（坂本さん判断 2026-08-26）:
      //   名刺の住所は「その人の所属拠点の住所」であって本社住所ではない。
      //   枚数の多さは本社である証拠にならない（営業拠点ほど名刺交換が多い／ベステラの取引は
      //   現場ごとに担当がつくため支店・現場事務所の名刺が集中しやすい）。
      //   #25 は「本社住所」なので、登記上の所在地が取れる **国税庁API / gBizINFO** が担当する。
      //   ※名刺の拠点情報を #27「支店・拠点(複数)」へ活かす案は将来の検討事項（今は実装しない）。
      map: {
        companyName: 2,        // 正式社名（名刺の会社名。表記ゆれあり＝人が確認する前提）
        url: 31,               // 会社URL（拠点によらず共通性が高い）
        // ※ countryCode も来るが #15「国内/海外区分」の取得元は 03_項目定義で **国税庁API** と決まっている。
        // ※ companyId（Sansan会社ID・32桁）も来るが、#18 は SOC(13桁) 用の列で別物。
        //   SFが持つ突合キーは会社ID(32桁)側なので専用列が要る → 塩田さんへの確認事項。
      },
    },
    sansan: {
      label: 'Sansan Data Hub',
      keyName: 'SANSAN_CLIENT_ID / SANSAN_CLIENT_SECRET / SANSAN_COMPANY_FEED_ID',
      needs: 'SOC(13桁) または 法人番号',
      note: '契約済みだが認証情報は Sansan 担当者への申請待ち（長谷部さん）。名刺がある取引先はここが主経路',
      // 2026-07のTrack B調査（scripts/fetch_sansan_companies.py）で確定した実フィールド名 → 項目No
      map: {
        'soc': 18,                                 // SOC(Sansan Organization Code)
        'nta.corporateNumber': 6,                  // 法人番号(13桁)
        'ss.company_name_kanji': 2,                // 正式社名
        'ss.company_name_kana': 3,                 // 社名カナ
        'ss.postal_code': 24,                      // 本社住所(〒)
        'ss.location': 25,                         // 本社住所
        'ss.phone_number': 28,                     // 電話番号
        'ss.legal_capital': 11,                    // 資本金
        'ss.employee_number': 21,                  // 従業員数
        'ss.created_year': 9,                      // 設立年月日
        'ss.listed_type': 12,                      // 上場区分
        'ss.latest_sales_term_sales': 22,          // 売上高
        'ss.representative_name': 7,               // 代表者名
        'ss.main_major_industrial_class': 19,      // 業種(大分類)
        'ntaInvoice.registratedNumber': 33,        // 登録番号(T+13桁)
        // ※ organization.riskAssessmentStatus（反社リスク評価）は意図的に対象外。
        //    反社は approval=true の承認制項目で、確定は反社チェックAPI（RoboRobo等）の結果によるため、
        //    参考値を自動で流し込むと「チェック済み」と誤読される（フェイルクローズを崩す）。
      },
    },
  },

  // Edge Function 名（既存の sf-import と同じ流儀。Sync.ENRICH_FN で上書き可）
  fnName() { return (typeof Sync !== 'undefined' && Sync.ENRICH_FN) || 'torihikisaki-enrich'; },

  // 🔴Edge Function は **本番Supabase** に置く（学習用DBには user_roles も Auth ユーザーも無く、
  //   Function内のロール判定（admin/accounting）が通らないため）。
  //   取引先データの読み書きは学習用（TorihikisakiView.getClient）、外部API呼び出しはここ、と役割を分ける。
  fnClient() { return Sync.getSupabase(); },

  // 疎通状況のキャッシュ（画面表示用）。null=未確認
  status: null,

  /**
   * 各プロバイダのキー設定状況を Edge Function に問い合わせる。
   * Function が無い／落ちている場合も「未接続」として静かに扱う（画面は手入力で動き続ける）。
   */
  async probe() {
    if (this.status) return this.status;   // 1セッション1回だけ問い合わせる（未デプロイ時に毎回CORSエラーを出さない）
    const out = {};
    Object.keys(this.PROVIDERS).forEach(k => { out[k] = { ok: false, reason: '未確認' }; });
    try {
      const sb = this.fnClient();
      const res = await sb.functions.invoke(this.fnName(), { body: { action: 'status' } });
      if (res.error) throw new Error(res.error.message || String(res.error));
      const d = res.data || {};
      Object.keys(this.PROVIDERS).forEach(k => {
        const p = (d.providers || {})[k];
        out[k] = p ? { ok: !!p.ok, reason: p.reason || (p.ok ? '接続可' : 'キー未設定') }
                   : { ok: false, reason: 'Function側に定義なし' };
      });
    } catch (e) {
      const reason = /Failed to send|not found|404/i.test(String(e.message || e))
        ? 'Edge Function 未デプロイ' : `疎通失敗: ${String(e.message || e).slice(0, 60)}`;
      Object.keys(this.PROVIDERS).forEach(k => { out[k] = { ok: false, reason }; });
    }
    this.status = out;
    return out;
  },

  available(key) { return !!(this.status && this.status[key] && this.status[key].ok); },
  anyAvailable() { return Object.keys(this.PROVIDERS).some(k => this.available(k)); },

  /**
   * 会社情報を取得する。戻り値は {provider, values:{項目No: 値}, raw} または null。
   * 🔴取得できても勝手に保存しない。呼び出し側が差分プレビューを出して人に選ばせること。
   */
  async fetchCompany(provider, params) {
    const p = this.PROVIDERS[provider];
    if (!p) throw new Error('未知の取得元: ' + provider);
    if (!this.available(provider)) {
      const why = (this.status && this.status[provider] && this.status[provider].reason) || '未接続';
      throw new Error(`${p.label} は利用できません（${why}）`);
    }
    const sb = this.fnClient();
    const res = await sb.functions.invoke(this.fnName(), {
      body: { action: 'fetch', provider, params },
    });
    if (res.error) throw new Error(res.error.message || String(res.error));
    const d = res.data || {};
    if (d.error) throw new Error(d.error);
    if (!d.record) return null;
    return { provider, values: this.toFieldValues(provider, d.record), raw: d.record };
  },

  // APIの返却レコード → {項目No: 値}（PROVIDERS[].map に従う。ネスト表記 'ss.xxx' に対応）
  toFieldValues(provider, record) {
    const map = this.PROVIDERS[provider].map;
    const out = {};
    Object.keys(map).forEach(path => {
      const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), record);
      if (v !== undefined && v !== null && String(v).trim() !== '') out[map[path]] = String(v).trim();
    });
    return out;
  },

  // 突合対象の項目（API値 → 項目No・マスタ列）。本社住所は3列に分かれるため特別扱い。
  DIFF_FIELDS: [
    { no: 2, api: 'name', col: 'official_name', label: '正式社名' },
    { no: 3, api: 'kana', col: 'name_kana', label: '社名カナ' },
    { no: 24, api: 'postal_code', col: 'postal_code', label: '本社郵便番号' },
    { no: 25, api: 'location', col: '__address__', label: '本社住所' },
    { no: 7, api: 'representative_name', col: 'representative_name', label: '代表者名' },
    { no: 11, api: 'capital_stock', col: 'capital_amount', label: '資本金' },
    { no: 21, api: 'employee_number', col: 'employee_count', label: '従業員数' },
    { no: 9, api: 'date_of_establishment', col: 'established_on', label: '設立年月日' },
    { no: 20, api: 'business_summary', col: 'business_summary', label: '事業内容' },
    { no: 31, api: 'company_url', col: 'website_url', label: 'URL' },
  ],

  // 1社分の突合。company行 と APIレコード から差異の一覧を作る。
  diffCompany(row, rec) {
    const out = [];
    this.DIFF_FIELDS.forEach(f => {
      const api = rec[f.api];
      if (api === null || api === undefined || String(api).trim() === '') return;
      const cur = f.col === '__address__'
        ? [row.prefecture, row.address_line, row.building].filter(Boolean).join(' ')
        : row[f.col];
      const j = this.judge(f.no, cur, api);
      out.push({
        no: f.no, label: f.label, col: f.col,
        current: cur || '', api: String(api),
        state: j.state, judgeLabel: j.label, adopt: j.adopt,
      });
    });
    return out;
  },

  // この項目はどのAPIで埋まりうるか（画面の説明・「未接続」理由の表示に使う）
  providersForField(no) {
    return Object.keys(this.PROVIDERS).filter(k => Object.values(this.PROVIDERS[k].map).indexOf(no) >= 0);
  },

  // ===== 突合の判定（API更新チェック画面が使う） =====
  // 🔴実データで踏んだ落とし穴を全て織り込んである。ここを甘くすると「表記ゆれ」が
  //   不一致として大量に出て、本当に確認すべき差異（本店移転・代表者交代）が埋もれる。
  //   実例では 54件 → 22件 まで誤検知を減らせた。

  // 基本の正規化。gBizINFOは英字を**全角**で返す（ＮＴＴ／ＪＦＥ／ＡＵＳ）ため半角に寄せる。
  norm(v) {
    if (v === null || v === undefined) return '';
    let s = String(v).trim();
    if (!s) return '';
    s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    s = s.replace(/[－―‐−]/g, '-');
    return s.replace(/[\s　-]/g, '').toUpperCase();
  },

  // カナ比較。gBizINFOは**ひらがな**で返すのでカタカナへ寄せる。
  normKana(v) {
    return this.norm(v).replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
  },

  KANSUJI: { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' },

  // 住所比較。丁目・番・号と漢数字の書式差を吸収する。
  // 🔴norm() を先に通すとハイフンが消えて 1-5-25 が 1525 になり区切りを失う（実データで踏んだ）。
  normAddr(v) {
    let s = String(v || '').trim();
    Object.keys(this.KANSUJI).forEach(k => { s = s.split(k + '丁目').join(this.KANSUJI[k] + '丁目'); });
    s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    s = s.replace(/[－―‐−ー]/g, '-');
    s = s.split('丁目').join('-').split('番地').join('-').split('番').join('-').split('号').join('');
    return s.replace(/[\s　]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  },

  // 代表者名。gBizINFOは役職付き・姓名間に空白が入る（例「代表取締役社長　千　田　一　弘」）。
  normPerson(v) {
    let s = String(v || '').trim();
    ['代表取締役社長', '代表取締役', '取締役社長', '代表理事', '理事長', '代表執行役',
      '取締役頭取', '取締役', '頭取', '社長', '会長', '代表者', '代表'].forEach(t => { s = s.split(t).join(''); });
    return this.norm(s);
  },

  /**
   * マスタの現在値とAPI値を突き合わせて判定する。
   * 戻り値: { state, label, adopt }
   *   fill        … 空欄を補完できる（そのまま採用してよい）
   *   masterError … マスタ側の入力誤り（カナ欄に漢字など）
   *   same        … 一致（変更不要）
   *   sameFuzzy   … 一致（表記ゆれのみ・対応不要）
   *   mismatch    … 不一致（移転/改称かAPIの誤りか、人が判断）
   */
  judge(no, current, apiValue) {
    const cur = current === null || current === undefined ? '' : String(current);
    const api = apiValue === null || apiValue === undefined ? '' : String(apiValue);
    if (!this.norm(cur)) return { state: 'fill', label: '空欄を補完', adopt: true };
    // カナ欄に漢字＝マスタ側の誤り（例: 金融機関名が漢字のままカナ欄に入っている）
    if (no === 3 && /[一-鿿]/.test(cur)) {
      return { state: 'masterError', label: 'マスタ側の誤り（カナ欄に漢字）', adopt: true };
    }
    const cmp = no === 3 ? this.normKana.bind(this)
      : no === 25 ? this.normAddr.bind(this)
      : no === 7 ? this.normPerson.bind(this)
      : this.norm.bind(this);
    let same = cmp(cur) === cmp(api);
    // 住所は片方に建物名が付くことがある。番地まで一致していれば同じ場所とみなす
    if (!same && no === 25) {
      const a = this.normAddr(cur), b = this.normAddr(api);
      if (a && b && (a.startsWith(b) || b.startsWith(a))) same = true;
    }
    if (same) {
      return this.norm(cur) === this.norm(api)
        ? { state: 'same', label: '一致（変更不要）', adopt: false }
        : { state: 'sameFuzzy', label: '一致（表記ゆれのみ）', adopt: false };
    }
    return { state: 'mismatch', label: '不一致・要確認', adopt: false };
  },

  // 実測での取得率（2026-08-26・gbiz_coverage_check.py）。
  // 「必ず取れる」と「取れたら儲けもの」を分けて伝えないと、人が期待を誤って確認を怠るため。
  RELIABLE: {
    gbizinfo: {
      always: ['法人番号', '正式社名', '社名カナ', '本社郵便番号', '本社住所'],
      sometimes: '代表者名・従業員数（約4〜9割）／設立年月日・事業内容・URL（約2〜8割）／資本金（約2割）は企業規模により差',
    },
  },

  // 疎通状況の要約HTML（設定画面・新規登録の案内で使う）
  statusHtml() {
    const s = this.status || {};
    return Object.keys(this.PROVIDERS).map(k => {
      const p = this.PROVIDERS[k], st = s[k] || { ok: false, reason: '未確認' };
      const badge = st.ok ? '<span class="badge b-sansan">接続可</span>' : '<span class="badge b-slate">未接続</span>';
      const n = Object.keys(p.map).length;
      const rel = this.RELIABLE[k];
      const detail = st.ok
        ? (rel ? `必ず取れる: ${rel.always.join('・')}<br><span class="mf">${rel.sometimes}</span>` : p.needs)
        : st.reason;
      return `<div class="slink"><span class="nm2">${TorihikisakiView.esc(p.label)}` +
        `<span class="mf" style="font-size:10px">　${n}項目を供給</span></span>${badge}` +
        `<span class="mf" style="font-size:10px;flex-basis:100%">${st.ok && rel ? detail : TorihikisakiView.esc(detail)}</span></div>`;
    }).join('');
  },
};
