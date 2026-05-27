/**
 * sync.js - Google Sheets CSV同期
 *
 * salesforce_imports シート（Salesforceレポート形式）から
 * projects（工事マスタ）と assignments（配置）を派生生成する。
 *
 * config.js で SHEET_ID が設定されていれば Sheets から取得、
 * 未設定なら MOCK_DATA を返す。
 */

const Sync = {
  SHEET_ID: null,

  // Supabase（段階A: 読み込み移行）。config.js で設定。
  // USE_SUPABASE=true のとき、gviz/parseCSV ではなく Supabase から取得する。
  SUPABASE_URL: null,
  SUPABASE_ANON_KEY: null,
  USE_SUPABASE: false,
  _sb: null,
  isEditor: false,   // 段階B: 編集ログイン済みか（Supabase Auth authenticated）。段階E1以降は role から導出
  role: null,        // 段階E1: ログインユーザーのロール（admin/editor/executive/manager/viewer）
  ADMIN_FN: 'admin-users',  // 段階E1.5: アカウント管理 Edge Function 名（config.js で実デプロイ名に上書き可）

  // シート名の候補。テンプレ命名 と Box CSV ファイル名（数字接頭辞）の両方を試す
  SHEET_CANDIDATES: {
    employees: ['employees', '01_employees'],
    departments: ['departments', '02_departments'],
    qualifications: ['qualifications', '05_qualifications'],
    employee_qualifications: ['employee_qualifications', '06_employee_qualifications'],
    salesforce_imports: ['salesforce_imports', '09_salesforce_imports'],
    prospects: ['prospects', '11_prospects'],
    assignment_overrides: ['assignment_overrides', '12_assignment_overrides'],
    g_work_logs: ['g_work_logs', '07_G_work_logs', '07_g_work_logs'],
    project_status_overrides: ['project_status_overrides', '13_project_status_overrides'],
  },

  // 各シートの形式バリデータ（先頭行で判定）
  SHEET_VALIDATORS: {
    employees: txt => /employee_id|社員番号|名前/i.test((txt || '').split('\n')[0] || ''),
    departments: txt => /department_id|department_name|事務所|部署/i.test((txt || '').split('\n')[0] || ''),
    // 厳密化：employees と被らないよう qualification_id 必須
    qualifications: txt => {
      const head = (txt || '').split('\n')[0] || '';
      return /qualification_id/i.test(head);
    },
    employee_qualifications: txt => {
      const head = (txt || '').split('\n')[0] || '';
      // emp_id × qual_id の組み合わせを必須（社員リスト誤認を防ぐ）
      return /qualification_id|qual_id/i.test(head) && /emp_id|社員番号/i.test(head);
    },
    salesforce_imports: txt => /工事部員|工事番号|人事配置一覧|現場管理表/i.test((txt || '').split('\n')[0] || ''),
    prospects: txt => /prospect_id|project_name|customer|見込み/i.test((txt || '').split('\n')[0] || ''),
    assignment_overrides: txt => /override_key|emp_name|project_id/i.test((txt || '').split('\n')[0] || ''),
    g_work_logs: txt => /社員コード|プロジェクトコード|作業時間|emp_id|hours/i.test((txt || '').split('\n')[0] || ''),
    project_status_overrides: txt => {
      const head = (txt || '').split('\n')[0] || '';
      // project_id ＋ completed の組み合わせを必須（他のシート誤認防止）
      return /project_id/i.test(head) && /completed/i.test(head);
    },
  },

  cache: {},
  lastSync: null,

  csvUrl(sheetName) {
    if (!this.SHEET_ID) throw new Error('SHEET_ID 未設定');
    return `https://docs.google.com/spreadsheets/d/${this.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  },

  async fetchSheetRaw(sheetName) {
    const response = await fetch(this.csvUrl(sheetName));
    if (!response.ok) throw new Error(`Sheet取得失敗: ${sheetName} (${response.status})`);
    return await response.text();
  },

  // 候補リストから「正しい形式」のシートを順次試す
  async fetchSheetWithValidation(key) {
    const candidates = this.SHEET_CANDIDATES[key] || [key];
    const validator = this.SHEET_VALIDATORS[key];
    for (const sheet of candidates) {
      try {
        const text = await this.fetchSheetRaw(sheet);
        if (!validator || validator(text)) {
          console.info(`シート ${key}: '${sheet}' から取得`);
          return text;
        } else {
          console.warn(`シート '${sheet}' は ${key} の形式ではないためスキップ`);
        }
      } catch (e) {
        // 次の候補を試す
      }
    }
    console.warn(`シート ${key} は全候補でフェッチ失敗`);
    return null;
  },

  async fetchSheet(sheetName) {
    const text = await this.fetchSheetRaw(sheetName);
    return this.parseCSV(text);
  },

  parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length === 0) return [];

    // Google Sheets の gviz/tq?tqx=out:csv は、全列が文字列のシートで
    // 「ヘッダ自動検出に失敗」し、各セルが "ヘッダ名 値" のように
    // 空白区切りで結合されて返される既知のバグがある。
    //
    // A列の値を見て、よくあるヘッダ名のパターンで始まれば「結合バグ」と判定し、
    // 全列でヘッダ部分と値を分離する。
    const firstRow = this.parseRow(lines[0]);
    // ASCII英数字 _ で始まり、空白＋何か続く形（例: "override_key 竹内信広__..."）
    // 1単語ヘッダ＋空白＋他の値、を検出
    const HEADER_TOKEN = /^([a-z][a-z0-9_]*)\s/i;
    const firstCellStr = String(firstRow[0] || '');
    const headerMatch = firstCellStr.match(HEADER_TOKEN);
    // 検出条件：A列が「ascii_token + 空白 + 何か」のパターン
    // かつ、その先頭トークンがヘッダ名らしい（override_key, prospect_id等）
    const HEADER_PATTERN = /^(override_key|prospect_id|qualification_id|qual_id|department_id|emp_id|employee_id|社員番号|record_id|名前)$/i;
    const isMerged = headerMatch && HEADER_PATTERN.test(headerMatch[1]);

    if (isMerged) {
      console.warn('[parseCSV] gviz/tq 結合バグを検出。ヘッダと最初のデータ行を分離します。');
      const headers = [];
      const firstDataValues = [];
      firstRow.forEach(cell => {
        const s = String(cell || '');
        // 最初の空白でヘッダと値を分割
        const m = s.match(/^(\S+)(\s+(.*))?$/);
        if (m) {
          headers.push(m[1]);
          firstDataValues.push(m[3] != null ? m[3].trim() : '');
        } else {
          headers.push(s);
          firstDataValues.push('');
        }
      });
      console.info('[parseCSV] 復元ヘッダ:', headers);
      console.info('[parseCSV] 復元最初のデータ行:', firstDataValues);

      const firstObj = {};
      headers.forEach((h, i) => firstObj[h] = firstDataValues[i] || '');
      const restRows = lines.slice(1).map(line => {
        const values = this.parseRow(line);
        const row = {};
        headers.forEach((h, i) => row[h] = values[i] || '');
        return row;
      });
      // 最初のデータ行が全空なら除外（ヘッダだけの状態）
      const hasFirstData = firstDataValues.some(v => String(v || '').trim() !== '');
      return hasFirstData ? [firstObj, ...restRows] : restRows;
    }

    // 通常のCSV
    const headers = firstRow;
    return lines.slice(1).map(line => {
      const values = this.parseRow(line);
      const row = {};
      headers.forEach((h, i) => row[h] = values[i] || '');
      return row;
    });
  },

  parseRow(line) {
    const result = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }  // クォート内のエスケープ
        else if (c === '"') inQuote = false;
        else cur += c;
      } else {
        if (c === '"') inQuote = true;
        else if (c === ',') { result.push(cur); cur = ''; }
        else cur += c;
      }
    }
    result.push(cur);
    return result;
  },

  // === Salesforce レポート専用パーサ（ヘッダベース・列順序非依存） ===
  // ヘッダ行を見て各列のインデックスを動的に特定。
  // 受け入れ列名（部分一致）：所属/工事部員/ロール/ロール詳細/受注形態/工事番号/工事名/着工/完工/総売上/受注金額/状態
  parseSalesforceCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    // ヘッダ検証：Salesforce形式かどうか
    const firstLine = lines[0] || '';
    const isSalesforce = firstLine.includes('工事部員') || firstLine.includes('工事番号')
      || firstLine.includes('人事配置一覧') || firstLine.includes('現場管理表')
      || firstLine.includes('受注形態');
    if (!isSalesforce) {
      console.warn('salesforce_imports シートが Salesforce形式ではありません。スキップします。', firstLine.substring(0, 100));
      return [];
    }

    // ヘッダから列インデックスを特定（部分一致）
    const headers = this.parseRow(firstLine);
    const findCol = (...patterns) => {
      for (let i = 0; i < headers.length; i++) {
        const h = String(headers[i] || '');
        for (const p of patterns) {
          if (h.includes(p)) return i;
        }
      }
      return -1;
    };
    const cols = {
      dept: findCol('所属', '部門'),
      emp: findCol('工事部員', '担当者'),
      role: findCol('ロール詳細') >= 0 && findCol('ロール詳細') !== findCol('ロール')
        ? findCol('ロール') : -1,  // 「ロール」と「ロール詳細」両方ある時の優先
      role_simple: findCol('ロール'),  // ロール詳細がなければこれを使う
      role_detail: findCol('ロール詳細'),
      contract_type: findCol('受注形態'),
      project_id: findCol('工事番号'),
      project_name: findCol('工事名', '通称'),
      start: findCol('着工'),
      end: findCol('完工'),
      total_revenue: findCol('総売上'),
      order_amount: findCol('受注金額'),
      status: findCol('状態'),
    };
    // 'ロール' 単独列の特定：ロール詳細と被らない方
    if (cols.role < 0) cols.role = cols.role_simple;
    // 'ロール' と 'ロール詳細' が同じ列を指す場合（findColの部分一致仕様）の補正
    if (cols.role === cols.role_detail && cols.role_detail >= 0) {
      // 「ロール詳細」の方が長いので findCol が先にヒット。逆順で探し直す
      for (let i = 0; i < headers.length; i++) {
        const h = String(headers[i] || '').trim();
        if (h === 'ロール') { cols.role = i; break; }
      }
    }
    console.info('SF列マッピング:', cols);

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const c = this.parseRow(lines[i]);
      // 合計行スキップ
      if (cols.dept >= 0 && (c[cols.dept] || '').includes('合計')) continue;

      const emp_name = this.normalizeName(c[cols.emp] || '');
      const project_id = cols.project_id >= 0 ? (c[cols.project_id] || '').trim() : '';

      // 必須：工事部員のみ。工事番号は無い場合もフォールバック許容
      if (!emp_name) continue;

      // 工番なし行は完全スキップ（受注前のSF案件は取り込まない方針）
      // 見込み案件は 11_prospects シートで管理する
      if (!project_id) continue;
      if (/^(-|nan|null|na|n\/a|undefined)$/i.test(project_id)) continue;
      if (!/[A-Za-z]/.test(project_id) || !/\d/.test(project_id)) continue;

      rows.push({
        department: c[cols.dept] || '',
        emp_name,
        emp_name_raw: c[cols.emp] || '',
        role: c[cols.role] || '',
        role_detail: c[cols.role_detail] || '',
        contract_type: c[cols.contract_type] || '',
        project_id,
        project_name: c[cols.project_name] || '',
        start: this.normalizeDate(c[cols.start]),
        end: this.normalizeDate(c[cols.end]),
        total_revenue: c[cols.total_revenue] || '',
        order_amount: c[cols.order_amount] || '',
        status: c[cols.status] || '',
      });
    }
    return rows;
  },

  // 氏名から絵文字（🔴🔵🟢🟡⚪等）と前後空白を除去
  normalizeName(name) {
    return String(name || '')
      .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')  // サロゲートペア（絵文字含む）
      .replace(/[☀-➿⬀-⯿]/g, '')    // その他記号
      .trim();
  },

  // 日付正規化：YYYY/MM/DD → そのまま、空文字は null
  normalizeDate(s) {
    if (!s) return null;
    return String(s).trim();
  },

  // 金額正規化：'JPY3,682,680,400' → 3682680400
  parseAmount(s) {
    if (!s) return 0;
    const num = String(s).replace(/[^\d]/g, '');
    return parseInt(num, 10) || 0;
  },

  // employees シートを両形式（仕様書テンプレ / Phase0ベース）に対応して正規化
  // 区分は新表記（現場監督 / 準現場監督 / 監督サポート / 対象外）に統一
  normalizeCategoryName(c) {
    const s = String(c || '').trim();
    if (!s) return '対象外';
    // 旧表記 → 新表記
    if (s === '監督職' || s === '現場監督') return '現場監督';
    if (s === '準監督職' || s === '準現場監督' || s.includes('準')) return '準現場監督';
    if (s === '広義監督職' || s === '監督サポート') return '監督サポート';
    return s;  // 「対象外」やその他はそのまま
  },

  normalizeEmployees(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const first = raw[0];

    // 仕様書テンプレート形式（employee_id, name, department_id, category 等）
    if (Object.prototype.hasOwnProperty.call(first, 'employee_id')) {
      return raw.map(r => ({
        id: parseInt(r.employee_id, 10) || r.employee_id,
        name: String(r.name || '').trim(),
        department: r.department || r.department_id || '',
        role: r.role_title || '',
        role_title: r.role_title || '',
        category: this.normalizeCategoryName(r.category),
        status: r.status || 'active',
        rank: r.rank_code || '',
      })).filter(e => e.id && e.name);
    }

    // Phase 0 ベース形式（No, 社員番号, 名前, 部門, 役職, 資格, 区分, 中計, 所属（最終判定））
    if (Object.prototype.hasOwnProperty.call(first, '社員番号') || Object.prototype.hasOwnProperty.call(first, '名前')) {
      return raw.map(r => {
        const kubun = String(r['区分'] || '').trim();
        const chukei = String(r['中計'] || '').trim();
        const inChukei = chukei.includes('〇') || chukei.includes('○') || chukei === '◯';
        let category;
        if (inChukei) {
          if (kubun.includes('準') || kubun.includes('準監督')) category = '準現場監督';
          else if (kubun === '監督職') category = '現場監督';
          else category = '監督サポート';
        } else {
          // 中計外でも区分から判定（フェイルセーフ）
          if (kubun.includes('準')) category = '準現場監督';
          else if (kubun === '監督職') category = '現場監督';
          else category = '対象外';
        }
        return {
          id: parseInt(r['社員番号'], 10) || r['社員番号'],
          name: String(r['名前'] || '').trim(),
          department: String(r['所属（最終判定）'] || r['部門'] || '').trim(),
          role: String(r['役職'] || '').trim(),
          role_title: String(r['役職'] || '').trim(),
          qualifications_raw: String(r['資格'] || '').trim(),  // F列（複数資格はカンマ・改行・スペースで区切り想定）
          category,
          status: 'active',
          rank: '',
        };
      }).filter(e => e.id && e.name);
    }

    // どちらでもなければ生データのまま返す
    return raw;
  },

  // ロールマッピング：Salesforceロール → 当社社員の役割
  // SF経由は当社社員前提なので 主任技術者 or 副監督 のみ（派遣は手動で登録）
  mapRole(sfRole) {
    if (!sfRole) return '副監督';
    if (sfRole.includes('責任者')) return '主任技術者';
    if (sfRole.includes('メンバー')) return '副監督';
    return '副監督';
  },

  // 旧表記「支援」「視察」「応援」を新表記「派遣」に正規化
  // ※「応援」は派遣社員専用の役割名として再定義（v0.6.2）
  normalizeRole(role) {
    const r = String(role || '').trim();
    if (r === '支援' || r === '視察' || r === '応援') return '派遣';
    return r;
  },

  // 役割表示順（バー描画・ソート用）
  ROLE_ORDER: { '主任技術者': 0, '監理技術者': 0, '副監督': 1, '派遣': 2 },

  // 完成工事の判定（status + 計画終了日の両方を見る）
  isCompletedProject(status, endDate) {
    const s = String(status || '');
    if (/完成|完工|完了|終了|引渡/.test(s)) return true;
    if (endDate) {
      const d = new Date(String(endDate).replace(/\//g, '-'));
      if (!isNaN(d)) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (d < today) return true;
      }
    }
    return false;
  },

  // 現在進行形の配置か判定（今日が join〜planned_end の範囲内）
  isActiveAssignment(a, today) {
    const t = today || new Date();
    t.setHours(0, 0, 0, 0);
    const start = a.join ? new Date(String(a.join).replace(/\//g, '-')) : null;
    const end = a.planned_end ? new Date(String(a.planned_end).replace(/\//g, '-')) : null;
    if (start && !isNaN(start) && start > t) return false;
    if (end && !isNaN(end) && end < t) return false;
    return true;
  },

  // 氏名先頭の絵文字から資格を判定（🔴=監理技術者 / 🔵=主任技術者）
  detectQualMarker(rawName) {
    if (!rawName) return null;
    if (rawName.includes('🔴')) return 'Q-DED';   // 監理技術者
    if (rawName.includes('🔵')) return 'Q-MAIN';  // 主任技術者
    return null;
  },

  // employees の F列「資格」フィールドから資格マスタと employee_qualifications を派生
  // 複数資格はカンマ/読点/改行/スペース/スラッシュで区切り
  // 既存マスタに無い資格名は自動的にマスタへ追加（社内認定種別として）
  deriveQualificationsFromEmployees(employees, existingQuals, existingEqs) {
    const quals = (existingQuals || []).slice();
    const qualsByName = {};
    quals.forEach(q => { qualsByName[String(q.name || '').trim()] = q; });

    const eqs = (existingEqs || []).slice();
    const existingKeys = new Set(eqs.map(eq => `${eq.emp_id}|${eq.qual_id}`));

    (employees || []).forEach(e => {
      const raw = String(e.qualifications_raw || '').trim();
      if (!raw) return;
      // 区切り文字：カンマ/読点/改行/スラッシュ/中黒・全角空白
      const names = raw.split(/[,、，\n\r\/／・　]+/).map(s => s.trim()).filter(Boolean);
      names.forEach(name => {
        // マスタに無ければ追加（自動採番：QE-001, QE-002,...）
        let q = qualsByName[name];
        if (!q) {
          const id = `QE-${String(quals.length + 1).padStart(3, '0')}`;
          q = { id, name, type: '社内登録' };
          quals.push(q);
          qualsByName[name] = q;
        }
        const key = `${e.id}|${q.id}`;
        if (!existingKeys.has(key)) {
          eqs.push({
            emp_id: e.id,
            qual_id: q.id,
            acquired: null,
            expiry: null,
            source: 'employees_F',
          });
          existingKeys.add(key);
        }
      });
    });
    return { qualifications: quals, employee_qualifications: eqs };
  },

  // 段階Q: 資格名を正規化（全角→半角：１級→1級／一級・二級→1級・2級）
  _normQual(s) {
    let t = String(s || '');
    try { t = t.normalize('NFKC'); } catch (e) { /* noop */ }
    return t.replace(/一級/g, '1級').replace(/二級/g, '2級');
  },

  // 実務経験で施工管理技士の要件を満たす監督の補完（SmartHRに証書データが無いケース）。
  //   キー=社員番号（同姓回避のため番号で指定）／値=deriveSekouTags が解釈できる資格名。
  //   ここに足すと qualifications_raw 経由で資格軸ガント・ダッシュボードのバッジ両方に反映される。
  EXPERIENCE_SEKOU: {
    '2007': '1級施工管理技士',  // 竹内信広：実務経験で1級施工管理技士の要件を満たす
  },

  // 段階Q: 保有資格名の配列から「1級/2級 施工管理技士」タグを導出。
  //   建築/土木/電気/管/造園 等の細分は畳む。技士「補」は下位資格のため除外。
  //   1級2級を両方保有する場合は上位（1級）のみ（資格軸ガントで二重表示しない）。
  //   このタグが資格軸ガント・バッジの唯一のソース（qualifications_raw に格納）。
  deriveSekouTags(names) {
    let has1 = false, has2 = false;
    (names || []).forEach(nm => {
      const n = this._normQual(nm);
      if (n.includes('施工管理技士') && !n.includes('補')) {
        if (n.includes('1級')) has1 = true;
        else if (n.includes('2級')) has2 = true;
      }
    });
    if (has1) return ['1級 施工管理技士'];
    if (has2) return ['2級 施工管理技士'];
    return [];
  },

  // 段階Q: 表示自体を除外する資格（個人系・業務管理外）。部分一致。
  QUAL_HIDDEN: ['運転免許'],
  isQualHidden(name) {
    const n = String(name || '');
    return this.QUAL_HIDDEN.some(k => n.includes(k));
  },

  // 段階Q: 期限アラートを出す対象資格（技術者・登録系の更新制資格のみ）。部分一致。
  //   ここに無い資格は詳細に期限日付を表示するだけでアラート（赤/橙/黄・件数）にしない。
  //   職長・安全衛生責任者教育（再教育推奨・法的失効なし）等はあえて対象外。編集容易。
  QUAL_EXPIRY_TRACK: [
    '監理技術者資格者証', '監理技術者講習', '解体工事施工技士',
    '建設キャリアアップ', '登録解体基幹技能者',
    '舗装施工管理技術者', '舗装診断士', 'コンクリート診断士', 'コンクリート技士',
    '非破壊試験', '宅地建物取引士', '可搬形発電設備専門技術者', '無人航空機操縦士',
    '溶接管理技術者',
  ],
  isExpiryTracked(name) {
    const n = String(name || '');
    return this.QUAL_EXPIRY_TRACK.some(k => n.includes(k));
  },

  // 段階Q: 有効期限の状態判定。戻り値 {status, days, label}。
  //   status: none(期限なし) / expired / warn30 / warn90 / ok / unknown
  qualExpiryStatus(expiry) {
    const e = String(expiry || '').trim();
    if (e === '' || e === '期限なし' || e === '無期限') return { status: 'none', days: null, label: '期限なし' };
    const m = e.replace(/-/g, '/').split('/');
    if (m.length !== 3) return { status: 'unknown', days: null, label: e };
    const dt = new Date(+m[0], +m[1] - 1, +m[2]);
    if (isNaN(dt.getTime())) return { status: 'unknown', days: null, label: e };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((dt - today) / 86400000);
    if (days < 0) return { status: 'expired', days, label: `期限切れ（${-days}日経過）` };
    if (days <= 30) return { status: 'warn30', days, label: `残${days}日` };
    if (days <= 90) return { status: 'warn90', days, label: `残${days}日` };
    return { status: 'ok', days, label: `残${days}日` };
  },

  // Salesforce の工事部員絵文字から employee_qualifications を派生
  // 既存の employee_qualifications にマージ（同一 emp_id × qual_id は重複なし）
  deriveQualificationsFromSalesforce(sfRows, employees, existingEqs) {
    const empByName = {};
    (employees || []).forEach(e => {
      const key = (e.name || '').replace(/\s+/g, '');
      if (key) empByName[key] = e;
    });

    // 各人の所有資格を集約
    const empQualSet = {};
    sfRows.forEach(r => {
      const qualId = this.detectQualMarker(r.emp_name_raw);
      if (!qualId) return;
      const empKey = (r.emp_name || '').replace(/\s+/g, '');
      const emp = empByName[empKey];
      if (!emp) return;
      const k = emp.id + '|' + qualId;
      empQualSet[k] = { emp_id: emp.id, qual_id: qualId };
    });

    // 既存に無い分だけ追加
    const existing = new Set((existingEqs || []).map(eq => eq.emp_id + '|' + eq.qual_id));
    const merged = [...(existingEqs || [])];
    Object.values(empQualSet).forEach(rec => {
      const key = rec.emp_id + '|' + rec.qual_id;
      if (!existing.has(key)) {
        merged.push({
          emp_id: rec.emp_id,
          qual_id: rec.qual_id,
          acquired: null,
          expiry: null,
          source: 'salesforce_marker',
        });
      }
    });
    return merged;
  },

  // 見込み案件（prospects v2）から projects を派生
  // v2スキーマ: prospect_id, status, customer, project_name, contract_type, area,
  //             managing_dept, start_date, end_date, amount, note, archived
  // 担当監督は今回スコープ外（assignments は生成しない）
  // archived=TRUE の行は除外
  deriveFromProspects(prospectRows, employees) {
    const projects = [];
    prospectRows.forEach(r => {
      // アーカイブ済みはスキップ
      const arch = String(r.archived || '').trim().toUpperCase();
      if (arch === 'TRUE' || arch === '1' || arch === 'YES') return;

      const pid = String(r.prospect_id || '').trim();
      if (!pid) return;
      const projName = String(r.project_name || '').trim();
      if (!projName) return;  // 工事名なしは表示価値なし

      projects.push({
        project_id: pid,
        name: projName,
        customer: r.customer || '',
        start: this.normalizeDate(r.start_date),
        end: this.normalizeDate(r.end_date),
        amount: this.parseAmount(r.amount),
        kind: '見込み',
        dept: r.managing_dept || '',
        area: r.area || '',
        contract_type: r.contract_type || '',
        status: r.status || '見込み',
        note: r.note || '',
        prospect: true,
        completed: false,
      });
    });

    return { projects, assignments: [] };
  },

  // Salesforceデータから projects と assignments を派生
  // 完成工事は projects.completed=true でフラグ付与（表示制御はビュー側）
  // 工事番号が空の行はスキップ（parseSalesforceCsv 段階で既に対応）
  deriveFromSalesforce(sfRows, employees) {
    const projectsMap = {};
    const assignments = [];

    // 氏名インデックス
    const empByName = {};
    (employees || []).forEach(e => {
      const key = (e.name || '').replace(/\s+/g, '');
      if (key) empByName[key] = e;
    });

    let asgIdSeq = 1;
    sfRows.forEach(r => {
      const completed = this.isCompletedProject(r.status, r.end);

      if (!projectsMap[r.project_id]) {
        const deptParts = String(r.department || '').split('/');
        const deptShort = deptParts[deptParts.length - 1] || r.department;
        projectsMap[r.project_id] = {
          project_id: r.project_id,
          name: r.project_name,
          customer: '',
          start: r.start,
          end: r.end,
          amount: this.parseAmount(r.total_revenue || r.order_amount),
          kind: '工事',
          dept: deptShort,
          contract_type: r.contract_type || '',
          status: r.status,
          completed,
        };
      }

      const empKey = r.emp_name.replace(/\s+/g, '');
      const emp = empByName[empKey];
      assignments.push({
        assignment_id: asgIdSeq++,
        emp_id: emp ? emp.id : null,
        emp_name: r.emp_name,
        project_id: r.project_id,
        project_name: r.project_name,
        allocation: 1,
        join: r.start,
        leave: null,
        planned_end: r.end,
        role: this.mapRole(r.role),
        role_sf: r.role,
        confirmed: String(r.status || '').includes('確定'),
        completed,
        source: 'salesforce',
      });
    });

    // 役割順→氏名でソート（主任技術者を一番上に・旧表記を正規化）
    assignments.sort((a, b) => {
      const ra = this.ROLE_ORDER[this.normalizeRole(a.role)] ?? 99;
      const rb = this.ROLE_ORDER[this.normalizeRole(b.role)] ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.emp_name || '').localeCompare(b.emp_name || '');
    });

    return {
      projects: Object.values(projectsMap),
      assignments,
    };
  },

  // ===== G工番ログ ユーティリティ =====

  // '8:00' / '8:30' / 8 / '8.5' を時間（小数）に変換
  parseHours(s) {
    if (s == null) return 0;
    const str = String(s).trim();
    const colon = str.match(/^(\d+):(\d+)$/);
    if (colon) return Number(colon[1]) + Number(colon[2]) / 60;
    const num = Number(str);
    return isNaN(num) ? 0 : num;
  },

  // 備考からG工番カテゴリを推定（検証B2のカテゴリに準拠）
  classifyGCategory(note) {
    const s = String(note || '').trim();
    if (!s || /G工番を使用の際/.test(s)) return '空欄・未記載';
    if (/教育|研修|採用|新人|OJT/i.test(s)) return '教育・採用';
    if (/安全|KY|衛生|健康/i.test(s)) return '安全衛生';
    if (/資料|事務|報告|提案|見積|積算/i.test(s)) return '資料作成・事務';
    if (/会議|打合|ミーティング|MTG|打ち合わせ/i.test(s)) return '会議・打合せ';
    if (/視察|調査|見学|現調|現地/i.test(s)) return '視察・調査';
    if (/移動|出張/i.test(s)) return '移動・出張';
    return 'その他';
  },

  // 日付から年月キー（YYYY-MM）を生成
  yearMonthKey(dateStr) {
    if (!dateStr) return null;
    const d = new Date(String(dateStr).replace(/\//g, '-'));
    if (isNaN(d)) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },

  // 先月の年月キーを返す
  previousYearMonthKey() {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },

  // G工番判定：プロジェクトコードが 'G' or 'G' で始まる短いコード
  isGWorkCode(code) {
    const s = String(code || '').trim();
    if (!s) return false;
    // 'G' 単独、または 'G-XXX' のようなパターン（'GLE...' のような工番除外）
    if (s === 'G') return true;
    if (/^G[-_]/.test(s)) return true;
    return false;
  },

  // 指定社員の指定年月のG工番サマリを集計
  // 戻り値: { totalHours, gHours, gRatio, categories: {cat: hours, ...} }
  computeGSummaryForEmployee(empId, yearMonth) {
    const logs = this.cache.g_work_logs || [];
    if (logs.length === 0 || !yearMonth) {
      return { totalHours: 0, gHours: 0, gRatio: 0, categories: {}, logCount: 0 };
    }

    let totalHours = 0;
    let gHours = 0;
    const categories = {};
    let logCount = 0;

    logs.forEach(r => {
      const rEmpId = String(r['社員コード'] || r.emp_id || '').trim();
      if (rEmpId !== String(empId)) return;
      const ym = this.yearMonthKey(r['日付'] || r.date);
      if (ym !== yearMonth) return;

      const h = this.parseHours(r['作業時間'] || r.hours);
      totalHours += h;
      logCount++;
      if (this.isGWorkCode(r['プロジェクトコード'] || r.project_code)) {
        gHours += h;
        const cat = this.classifyGCategory(r['備考'] || r.note);
        categories[cat] = (categories[cat] || 0) + h;
      }
    });

    const gRatio = totalHours > 0 ? gHours / totalHours : 0;
    return { totalHours, gHours, gRatio, categories, logCount };
  },

  // override_key の正規化（GAS側 upsert と一致させる）
  buildOverrideKey(empName, projectId) {
    return `${(empName || '').replace(/\s+/g, '')}__${(projectId || '').trim()}`;
  },

  // override 行を assignments にマージ（v4: op 別処理）
  // op=update: 既存配置の期間/役割を上書き（旧挙動）
  // プロジェクト状態 override を projects にマージ
  // 自動判定（status文言 + planned_end < 今日）より override を優先する
  // completed が 'TRUE'/'true' → true、'FALSE'/'false' → false
  mergeProjectStatusOverrides(projects, overrideRows) {
    if (!Array.isArray(overrideRows) || overrideRows.length === 0) return projects;
    const map = new Map();
    overrideRows.forEach(r => {
      const pid = String(r.project_id || '').trim();
      if (!pid) return;
      const raw = String(r.completed || '').trim().toLowerCase();
      let completed = null;
      if (raw === 'true') completed = true;
      else if (raw === 'false') completed = false;
      // 状態は明示値(true/false)のみ反映。dept は非空なら管轄事務所を上書き
      const dept = String(r.dept || '').trim();
      map.set(pid, { completed, dept });
    });
    if (map.size === 0) return projects;
    return projects.map(p => {
      const ov = map.get(p.project_id);
      if (!ov) return p;
      const next = Object.assign({}, p);
      if (ov.completed !== null) { next.completed = ov.completed; next._status_overridden = true; }
      if (ov.dept) { next.dept = ov.dept; next._dept_overridden = true; }
      return next;
    });
  },

  // op=add: 新規配置を追加（見込み案件への監督紐付け / 既存案件への追加メンバー）
  // op=remove: 既存配置を除外（マージ後の assignments から消す）
  // 後方互換: op 列なし or 空欄は update とみなす
  mergeOverridesIntoAssignments(assignments, overrideRows, projects) {
    if (!Array.isArray(overrideRows) || overrideRows.length === 0) return assignments;

    // override をキー→行 にマップ化
    const map = {};
    overrideRows.forEach(r => {
      const key = String(r.override_key || this.buildOverrideKey(r.emp_name, r.project_id) || '').trim();
      if (!key) return;
      map[key] = r;
    });

    // 1. 既存 assignments に対し update / remove を適用
    let updateCount = 0, removeCount = 0, addCount = 0;
    const removedKeys = new Set();
    let working = assignments.map(a => {
      const key = this.buildOverrideKey(a.emp_name, a.project_id);
      const o = map[key];
      if (!o) return a;
      const op = String(o.op || 'update').trim();
      if (op === 'remove') {
        removeCount++;
        removedKeys.add(key);
        return null;  // 後で filter で除外
      }
      // update（または未指定）
      updateCount++;
      const next = { ...a };
      if (o.join_date) next.join = this.normalizeDate(o.join_date);
      if (o.planned_end) next.planned_end = this.normalizeDate(o.planned_end);
      if (o.role) next.role = o.role;
      // 準備期間開始日（空文字なら準備期間なしとしてクリア）
      next.prep_start = o.prep_start ? this.normalizeDate(o.prep_start) : '';
      next.overridden = true;
      next.override_note = o.note || '';
      next.override_updated_at = o.updated_at || '';
      next.override_op = 'update';
      next.override_key = String(o.override_key || key);  // 解除/編集時に正しいキーを使うため保持
      return next;
    }).filter(Boolean);

    // 2. op=add のレコードを新規 assignment として追加
    const employees = this.cache.employees || [];
    const empByName = {};
    employees.forEach(e => {
      const k = (e.name || '').replace(/\s+/g, '');
      if (k) empByName[k] = e;
    });
    const projMap = {};
    (projects || []).forEach(p => { projMap[p.project_id] = p; });

    // 既存 assignments の assignment_id の最大値を取得（衝突防止）
    let maxAsgId = 0;
    working.forEach(a => {
      const n = Number(a.assignment_id) || 0;
      if (n > maxAsgId) maxAsgId = n;
    });
    let nextAsgId = Math.max(maxAsgId + 1, 50000);  // override由来は 50000 以降

    overrideRows.forEach(o => {
      const op = String(o.op || 'update').trim();
      if (op !== 'add') return;
      const empName = String(o.emp_name || '').trim();
      const projId = String(o.project_id || '').trim();
      if (!empName || !projId) return;

      // 重複チェック：override_key で識別（配置未定・不足は役割で区別するため emp_name だけでは不十分）
      const key = String(o.override_key || this.buildOverrideKey(empName, projId)).trim();
      if (removedKeys.has(key)) return;  // remove と同時指定はおかしい
      const already = working.some(a => {
        const aKey = String(a.override_key || this.buildOverrideKey(a.emp_name, a.project_id)).trim();
        return aKey === key;
      });
      if (already) {
        console.warn(`add 重複スキップ: ${key}（既存配置あり）`);
        return;
      }

      const emp = empByName[empName.replace(/\s+/g, '')];
      const proj = projMap[projId];
      working.push({
        assignment_id: nextAsgId++,
        emp_id: emp ? emp.id : null,
        emp_name: empName,
        project_id: projId,
        project_name: proj ? proj.name : '',
        allocation: 1,
        join: this.normalizeDate(o.join_date),
        leave: null,
        planned_end: this.normalizeDate(o.planned_end),
        prep_start: o.prep_start ? this.normalizeDate(o.prep_start) : '',
        role: o.role || '派遣',
        role_sf: '',
        confirmed: false,
        completed: false,
        prospect: proj ? !!proj.prospect : false,
        source: 'override_add',
        overridden: true,
        override_note: o.note || '',
        override_op: 'add',
        override_key: String(o.override_key || key),  // 解除/編集時に正しいキーを使うため保持
      });
      addCount++;
    });

    console.info(`assignment_overrides: update=${updateCount} / add=${addCount} / remove=${removeCount}`);
    return working;
  },

  // GAS Web App に POST（配属期間 override の upsert / delete）
  // Content-Type を text/plain にして CORS preflight を回避
  async postOverride(payload) {
    // 段階B: USE_SUPABASE のときは supabase-js で直接書き込む（GAS不要）。
    // RLS により書込は authenticated（編集ログイン済み）のみ許可される。
    if (this.USE_SUPABASE && this.SUPABASE_URL && this.SUPABASE_ANON_KEY) {
      return await this.writeToSupabase(payload);
    }
    // 従来：Apps Script Web App 経由
    if (!this.OVERRIDE_API_URL) throw new Error('OVERRIDE_API_URL が未設定です（config.js を確認）');
    const body = JSON.stringify({ ...payload, token: this.OVERRIDE_TOKEN });
    const response = await fetch(this.OVERRIDE_API_URL, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    });
    if (!response.ok) throw new Error(`API応答エラー: ${response.status}`);
    const json = await response.json();
    if (!json.ok) throw new Error(`API失敗: ${json.error || 'unknown'}`);
    return json;
  },

  // 'P' + 12桁hex（GAS uuidShort 相当・新規 prospect の採番）
  uuidShortProspect() {
    const hex = '0123456789abcdef';
    let s = 'P';
    for (let i = 0; i < 12; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
  },

  // GAS doPost の各 action を supabase-js で再現。返り値は { ok:true, action, ... }。
  // エラー時は throw（呼び出し側は従来どおり try/catch でハンドリング）。
  async writeToSupabase(payload) {
    const sb = this.getSupabase();
    const action = payload.action || 'upsert';
    const nowIso = new Date().toISOString();
    const fail = (msg) => { throw new Error(msg); };
    const check = (res) => { if (res && res.error) fail(res.error.message || JSON.stringify(res.error)); return res; };

    if (action === 'upsert') {
      const key = String(payload.override_key || '').trim();
      if (!key) fail('override_key required');
      const row = {
        override_key: key,
        emp_name: payload.emp_name || '',
        project_id: payload.project_id || '',
        join_date: payload.join_date || '',
        planned_end: payload.planned_end || '',
        prep_start: payload.prep_start || '',  // 準備期間開始日（準備期間 = prep_start〜join_date）
        role: payload.role || '',
        note: payload.note || '',
        updated_at: nowIso,
        updated_by: payload.updated_by || '',
        op: String(payload.op || 'update').trim(),
      };
      check(await sb.from('assignment_overrides').upsert(row, { onConflict: 'override_key' }));
      return { ok: true, action: 'upserted', key };
    }

    if (action === 'delete') {
      const key = String(payload.override_key || '').trim();
      if (!key) fail('override_key required');
      check(await sb.from('assignment_overrides').delete().eq('override_key', key));
      return { ok: true, action: 'deleted', key };
    }

    if (action === 'prospect_upsert') {
      const id = String(payload.prospect_id || '').trim();
      const isNew = !id;
      const pid = isNew ? this.uuidShortProspect() : id;
      const row = {
        prospect_id: pid,
        status: payload.status || '見込み',
        customer: payload.customer || '',
        project_name: payload.project_name || '',
        contract_type: payload.contract_type || '',
        area: payload.area || '',
        managing_dept: payload.managing_dept || '',
        start_date: payload.start_date || '',
        end_date: payload.end_date || '',
        amount: payload.amount || '',
        note: payload.note || '',
        updated_at: nowIso,
        updated_by: payload.updated_by || 'web',
        archived: (payload.archived === true || payload.archived === 'true') ? 'TRUE' : 'FALSE',
      };
      if (isNew) {
        row.created_at = payload.created_at || nowIso;
        check(await sb.from('prospects').insert(row));
        return { ok: true, action: 'inserted', prospect_id: pid };
      }
      // 既存更新：created_at は触らない
      check(await sb.from('prospects').update(row).eq('prospect_id', pid));
      return { ok: true, action: 'updated', prospect_id: pid };
    }

    if (action === 'prospect_delete') {
      const id = String(payload.prospect_id || '').trim();
      if (!id) fail('prospect_id required');
      check(await sb.from('prospects').delete().eq('prospect_id', id));
      return { ok: true, action: 'deleted', prospect_id: id };
    }

    if (action === 'prospect_archive') {
      const id = String(payload.prospect_id || '').trim();
      if (!id) fail('prospect_id required');
      check(await sb.from('prospects').update({
        status: '受注済み',
        updated_at: nowIso,
        updated_by: payload.updated_by || 'web',
        archived: 'TRUE',
      }).eq('prospect_id', id));
      return { ok: true, action: 'archived', prospect_id: id };
    }

    if (action === 'project_status_upsert') {
      const pid = String(payload.project_id || '').trim();
      if (!pid) fail('project_id required');
      const c = payload.completed;
      let completedStr = '';   // '' = 状態は自動（上書きしない）。管轄事務所だけ上書きするケースを許容
      if (c === true || c === 'true' || c === 'TRUE') completedStr = 'TRUE';
      else if (c === false || c === 'false' || c === 'FALSE') completedStr = 'FALSE';
      check(await sb.from('project_status_overrides').upsert({
        project_id: pid,
        completed: completedStr,
        dept: payload.dept || '',   // '' = 管轄事務所は自動（Salesforce元値）
        note: payload.note || '',
        updated_at: nowIso,
        updated_by: payload.updated_by || 'web',
      }, { onConflict: 'project_id' }));
      return { ok: true, action: 'upserted', project_id: pid, completed: completedStr };
    }

    if (action === 'project_status_delete') {
      const pid = String(payload.project_id || '').trim();
      if (!pid) fail('project_id required');
      check(await sb.from('project_status_overrides').delete().eq('project_id', pid));
      return { ok: true, action: 'deleted', project_id: pid };
    }

    throw new Error('unknown_action: ' + action);
  },

  // 編集権限（段階B）：USE_SUPABASE のときは編集ログイン済みか、従来は API設定有無で判定
  canEdit() {
    if (this.USE_SUPABASE) return this.role === 'admin' || this.role === 'editor';
    return !!(this.OVERRIDE_API_URL && this.OVERRIDE_TOKEN);
  },

  // 参照系テーブル（Sheetsで編集する3つ）の列ホワイトリスト。
  // 余分な空ヘッダ列やサロゲートid を除外し、これらの列だけ投入する。
  REFERENCE_COLUMNS: {
    employees: ['No', '社員番号', '名前', '部門', '役職', '資格', '区分', '中計', '所属（最終判定）', 'オーバーライド理由', 'ユーザーチェック'],
    g_work_logs: ['社員コード', '社員名', '日付', '勤務時間差異', 'プロジェクトコード', 'プロジェクト名', '作業時間', '備考'],
    salesforce_imports: ['department', 'emp_name', 'emp_name_raw', 'role', 'role_detail', 'contract_type', 'project_id', 'project_name', 'start', 'end', 'total_revenue', 'order_amount', 'status'],
    // 段階D: SmartHR名簿(01_organization)の整形後スキーマ
    organization: ['emp_no', 'last_name', 'first_name', 'kana_last', 'kana_first', 'email', 'business', 'hire_date', 'depts', 'positions'],
    // 段階Q: 資格マスタ(02_employees タブ＝SmartHR「従業員の資格一覧」エクスポートを貼付)。
    //   1行=1人×1資格。必要6列のみ取込（部署/点数/資格番号/証明書の写し等は無視）。
    employee_quals: ['社員番号', '氏名', 'コード', '保有資格', '取得日', '有効期限'],
  },

  // 段階D: SmartHR名簿(01_organization)の生行 → organization テーブル形式に整形。
  // 部署1..10／役職1..10 の非空セルを配列にまとめる（兼任=部署が複数）。
  parseOrganizationRows(rawRows) {
    return rawRows.map(r => {
      const depts = [];
      const positions = [];
      for (let i = 1; i <= 10; i++) {
        const d = String(r[`部署${i} 部署`] || '').trim();
        if (d) depts.push(d);
        const p = String(r[`役職${i} 役職`] || '').trim();
        if (p) positions.push(p);
      }
      return {
        emp_no: String(r['社員番号'] || '').trim(),
        last_name: String(r['姓'] || '').trim(),
        first_name: String(r['名'] || '').trim(),
        kana_last: String(r['姓（ヨミガナ）'] || '').trim(),
        kana_first: String(r['名（ヨミガナ）'] || '').trim(),
        email: String(r['メールアドレス'] || '').trim(),
        business: String(r['業務内容'] || '').trim(),
        hire_date: String(r['入社年月日'] || '').trim(),
        depts: [...new Set(depts)],          // 部署の重複登録を除去
        positions: [...new Set(positions)],
      };
    }).filter(r => r.emp_no);
  },

  // 段階C/D/D5: Sheets→Supabase 参照系テーブルの同期（編集者のみ・「同期」ボタンから呼ばれる）。
  // 同期対象：g_work_logs（勤怠貼付）・salesforce_imports（SF貼付）・organization（01_organization 名簿）・
  //           employee_quals（02_employees 資格）。編集の正は Google Sheets。運用系には一切触れない。
  // ※ 旧 employees(01_employees) は段階D5で廃止し、同期対象から除外。
  async syncReferenceFromSheets() {
    // Sheets から取得（既存の gviz 経路を再利用）
    const [gwTxt, sfTxt] = await Promise.all([
      this.fetchSheetWithValidation('g_work_logs'),
      this.fetchSheetWithValidation('salesforce_imports'),
    ]);
    // 段階D: 組織図名簿（01_organization）／段階D5: 資格マスタ（02_employees）を直接取得
    let orgTxt = null, qualTxt = null;
    try { orgTxt = await this.fetchSheetRaw('01_organization'); } catch (e) { /* タブ未作成は許容 */ }
    try { qualTxt = await this.fetchSheetRaw('02_employees'); } catch (e) { /* タブ未作成は許容 */ }

    const gwRows = gwTxt ? this.parseCSV(gwTxt).filter(r => String(r['社員コード'] || '').trim()) : [];
    const sfRows = sfTxt ? this.parseSalesforceCsv(sfTxt) : [];
    const orgRows = orgTxt ? this.parseOrganizationRows(this.parseCSV(orgTxt)) : [];
    const qualRows = qualTxt ? this.parseCSV(qualTxt).filter(r => String(r['社員番号'] || '').trim()) : [];

    // 0件のテーブルは取得失敗の可能性があるので置換しない（誤って空にしない安全策）
    // ※ 段階D5: 旧 employees(01_employees) は廃止につき同期しない。資格は 02_employees→employee_quals へ。
    if (gwRows.length) await this._replaceSupabaseTable('g_work_logs', gwRows);
    if (sfRows.length) await this._replaceSupabaseTable('salesforce_imports', sfRows);
    if (orgRows.length) await this._replaceSupabaseTable('organization', orgRows);
    if (qualRows.length) await this._replaceSupabaseTable('employee_quals', qualRows);

    return { g_work_logs: gwRows.length, salesforce_imports: sfRows.length, organization: orgRows.length, employee_quals: qualRows.length };
  },

  // 参照系テーブルを全置換。書込は authenticated（編集者）のみRLSで許可。
  // 安全策：「先に新規投入 → 成功後に旧行を削除」の順。
  //   - 投入が失敗しても旧データは残る（空にならない）
  //   - 旧行削除が失敗しても重複が残るだけ（再同期で回復）＝データ消失は起きない
  // サロゲートidは常に増加するため、投入前の最大idを基準に旧行を特定できる。
  async _replaceSupabaseTable(table, rows) {
    const sb = this.getSupabase();
    const cols = this.REFERENCE_COLUMNS[table];
    const clean = rows.map(r => {
      const o = {};
      cols.forEach(c => { o[c] = (r[c] !== undefined ? r[c] : null); });
      return o;
    });
    // 1. 投入前の最大id（新規行はこれより大きいidになる）
    const maxRes = await sb.from(table).select('id').order('id', { ascending: false }).limit(1);
    if (maxRes.error) throw new Error(`${table} 既存id取得失敗: ${maxRes.error.message}`);
    const maxOldId = (maxRes.data && maxRes.data.length) ? maxRes.data[0].id : 0;
    // 2. 新規行を投入（旧行と一時共存・失敗時は旧データが残る）
    const batch = 500;
    for (let i = 0; i < clean.length; i += batch) {
      const ins = await sb.from(table).insert(clean.slice(i, i + batch));
      if (ins.error) throw new Error(`${table} 投入失敗(${i}行目付近): ${ins.error.message}`);
    }
    // 3. 旧行を削除（投入成功後。失敗しても重複が残るだけで消失はしない）
    const del = await sb.from(table).delete().lte('id', maxOldId);
    if (del.error) throw new Error(`${table} 旧行削除失敗: ${del.error.message}（重複が残った可能性。もう一度同期してください）`);
  },

  async syncAll() {
    if (this.USE_SUPABASE && this.SUPABASE_URL && this.SUPABASE_ANON_KEY) {
      // 段階A: Supabase から各テーブルを取得（gviz/parseCSV をバイパス）
      await this.fetchRawFromSupabase();
      this.processRawTables();
    } else if (this.SHEET_ID) {
      // 各シートを候補名でフォールバック取得（バリデータでヘッダ確認）
      const keys = ['employees', 'departments', 'qualifications', 'employee_qualifications', 'salesforce_imports', 'prospects', 'assignment_overrides', 'g_work_logs', 'project_status_overrides'];
      const texts = await Promise.allSettled(keys.map(k => this.fetchSheetWithValidation(k)));

      keys.forEach((key, i) => {
        const r = texts[i];
        if (r.status !== 'fulfilled' || !r.value) return;
        try {
          if (key === 'salesforce_imports') {
            this.cache.salesforce_imports = this.parseSalesforceCsv(r.value);
          } else {
            this.cache[key] = this.parseCSV(r.value);
          }
        } catch (e) {
          console.warn(`${key} パース失敗:`, e);
        }
      });
      this.processRawTables();
    } else {
      this.loadMockData();
      console.info('SHEET_ID未設定のためモックデータで動作中');
    }
    this.lastSync = new Date();
    return this.cache;
  },

  // Supabase から各テーブルを取得し this.cache に格納する。
  // salesforce_imports は parseSalesforceCsv 整形後の形で保存済みなのでそのまま使える。
  // 取得後の正規化・派生は processRawTables() が Sheets 経路と共通で行う。
  // ※ 段階D6: 旧 employees テーブルは廃止（organization+employee_tiers が社員の正）。fetch しない。
  async fetchRawFromSupabase() {
    const sb = this.getSupabase();
    const fetchTable = async (table, orderCol) => {
      let all = [];
      let from = 0;
      const page = 1000;
      // PostgREST の1リクエスト上限に備えてページング取得（g_work_logs は数千行）
      while (true) {
        let q = sb.from(table).select('*').range(from, from + page - 1);
        if (orderCol) q = q.order(orderCol, { ascending: true });
        const { data, error } = await q;
        if (error) {
          console.error(`Supabase ${table} 取得失敗:`, error.message || error);
          break;
        }
        all = all.concat(data || []);
        if (!data || data.length < page) break;
        from += page;
      }
      return all;
    };
    const [sf, pro, ov, gw, ps, org, tiers, quals] = await Promise.all([
      fetchTable('salesforce_imports', 'id'),
      fetchTable('prospects', null),
      fetchTable('assignment_overrides', null),
      fetchTable('g_work_logs', 'id'),
      fetchTable('project_status_overrides', null),
      fetchTable('organization', 'id'),       // 段階D: 組織図名簿（無ければ[]）
      fetchTable('employee_tiers', null),      // 段階D: 階層判定（無ければ[]）
      fetchTable('employee_quals', 'id'),      // 段階D5: 資格マスタ（無ければ[]）
    ]);
    this.cache.employees = [];               // 段階D6: 旧 employees 廃止。processRawTables が organization から再生成
    this.cache.salesforce_imports = sf;
    this.cache.prospects = pro;
    this.cache.assignment_overrides = ov;
    this.cache.g_work_logs = gw;
    this.cache.project_status_overrides = ps;
    this.cache.organization = org;
    this.cache.employee_tiers = tiers;
    this.cache.employee_quals = quals;
    console.info('Supabaseから取得:',
      `sf=${sf.length}`, `prospects=${pro.length}`,
      `overrides=${ov.length}`, `glogs=${gw.length}`, `status=${ps.length}`,
      `org=${org.length}`, `tiers=${tiers.length}`, `quals=${quals.length}`);
  },

  // supabase-js クライアント（遅延生成）
  getSupabase() {
    if (this._sb) return this._sb;
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error('supabase-js が読み込まれていません（index.html のCDN参照を確認）');
    }
    this._sb = window.supabase.createClient(this.SUPABASE_URL, this.SUPABASE_ANON_KEY);
    return this._sb;
  },

  // 段階E1: ログイン（Supabase Auth・全ユーザー個人アカウント）+ ロール取得。
  async login(email, password) {
    const sb = this.getSupabase();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message || 'ログインに失敗しました');
    await this.fetchRole();
    return !!(data && data.session);
  },

  async logout() {
    try { await this.getSupabase().auth.signOut(); } catch (e) { /* noop */ }
    this.role = null;
    this.isEditor = false;
  },

  // 既存セッション（localStorage 永続）を復元し、ロールを取得。ログイン中なら true。
  async refreshSession() {
    if (!this.USE_SUPABASE || !this.SUPABASE_URL) return false;
    try {
      const { data } = await this.getSupabase().auth.getSession();
      if (data && data.session) { await this.fetchRole(); return true; }
    } catch (e) { /* noop */ }
    this.role = null; this.isEditor = false;
    return false;
  },

  // user_roles から自分のロールを取得（ur_read_self ポリシーで本人行を直接読む）。
  async fetchRole() {
    try {
      const sb = this.getSupabase();
      const { data: u } = await sb.auth.getUser();
      const uid = u && u.user && u.user.id;
      this.userId = uid || null;            // 段階E4: 自分の学習ログ絞り込み用
      if (!uid) {
        this.role = null;
      } else {
        const { data, error } = await sb.from('user_roles').select('role').eq('user_id', uid).maybeSingle();
        if (error) throw error;
        this.role = (data && data.role) || null;
      }
    } catch (e) {
      console.error('ロール取得失敗:', e);
      this.role = null;
      this.userId = null;
    }
    this.isEditor = (this.role === 'admin' || this.role === 'editor');  // 後方互換
    return this.role;
  },

  isLoggedIn() { return !!this.role; },
  isAdmin() { return this.role === 'admin'; },

  // ロールの日本語表示名
  ROLE_LABELS: { admin: '管理者', editor: '編集者', executive: '経営者', manager: '役職者', viewer: '閲覧者' },
  roleLabel() { return this.ROLE_LABELS[this.role] || this.role || '—'; },

  // ===== 段階E1.5: アカウント管理（Edge Function「admin-users」経由）=====
  // service_role はサーバー側のみ。ここからは admin の JWT を付けて呼ぶ（functions.invoke が自動付与）。
  async _invokeAdmin(body) {
    const { data, error } = await this.getSupabase().functions.invoke(this.ADMIN_FN, { body });
    if (error) {
      // HTTP非2xxでも error。レスポンス本文の error メッセージを優先的に拾う
      let msg = error.message || 'リクエストに失敗しました';
      try { const ctx = await error.context?.json?.(); if (ctx?.error) msg = ctx.error; } catch (_) { /* noop */ }
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(data.error);
    return data;
  },
  async adminListUsers() { const d = await this._invokeAdmin({ action: 'list' }); return (d && d.users) || []; },
  async adminCreateUser({ email, password, display_name, role }) {
    return this._invokeAdmin({ action: 'create', email, password, display_name, role });
  },
  async adminSetRole(user_id, role) { return this._invokeAdmin({ action: 'set_role', user_id, role }); },
  async adminSetName(user_id, display_name) { return this._invokeAdmin({ action: 'set_name', user_id, display_name }); },
  async adminSetPassword(user_id, password) { return this._invokeAdmin({ action: 'set_password', user_id, password }); },
  async adminDeleteUser(user_id) { return this._invokeAdmin({ action: 'delete', user_id }); },

  // tier（監督職/準監督職/広義監督職/対象外）→ 画面が使う category（現場監督/準現場監督/監督サポート/対象外）
  TIER_TO_CATEGORY: {
    '監督職': '現場監督',
    '準監督職': '準現場監督',
    '広義監督職': '監督サポート',
    '対象外': '対象外',
    // 監督リスト表記（category）を直接保存しても通るように識別マップに含める
    '現場監督': '現場監督',
    '準現場監督': '準現場監督',
    '監督サポート': '監督サポート',
  },

  // 段階D: 階層の手動判定を保存（組織図画面から）。tier は監督リスト表記でよい。
  async setEmployeeTier(empNo, tier) {
    const sb = this.getSupabase();
    const res = await sb.from('employee_tiers').upsert({
      emp_no: String(empNo).trim(),
      tier: tier,
      note: '',
      updated_at: new Date().toISOString(),
      updated_by: 'web',
    }, { onConflict: 'emp_no' });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 手動判定を削除して自動判定に戻す
  async clearEmployeeTier(empNo) {
    const sb = this.getSupabase();
    const res = await sb.from('employee_tiers').delete().eq('emp_no', String(empNo).trim());
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // ===== 段階E3: 経営ドッキング（management_reports）=====
  // 経営機密。RLS で SELECT=admin/executive・書込=admin に制限済み（phaseE3_management_reports.sql）。
  // html_content は重い（1本約75KB）ので、一覧はメタのみ取得し、本文は選択時に個別取得する。

  // レポート一覧（メタのみ・html_content を含めない）。admin/executive 以外は RLS で 0 件。
  async listManagementReports() {
    const sb = this.getSupabase();
    const { data, error } = await sb.from('management_reports')
      .select('id, report_type, year_month, title, uploaded_at, uploaded_by')
      .order('year_month', { ascending: false });
    if (error) throw new Error(error.message || JSON.stringify(error));
    return data || [];
  },

  // 指定レポートの HTML 本文を取得（選択時に遅延ロード）。
  async fetchManagementReportHtml(id) {
    const sb = this.getSupabase();
    const { data, error } = await sb.from('management_reports')
      .select('html_content').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message || JSON.stringify(error));
    return (data && data.html_content) || '';
  },

  // レポートのアップロード/差替（admin のみ・(report_type, year_month) で upsert）。
  async upsertManagementReport({ report_type, year_month, title, html_content }) {
    const sb = this.getSupabase();
    const { data: u } = await sb.auth.getUser();
    const email = (u && u.user && u.user.email) || 'admin';
    const res = await sb.from('management_reports').upsert({
      report_type,
      year_month: String(year_month).trim(),
      title: title || null,
      html_content,
      uploaded_at: new Date().toISOString(),
      uploaded_by: email,
    }, { onConflict: 'report_type,year_month' });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // レポート削除（admin のみ）。
  async deleteManagementReport(id) {
    const sb = this.getSupabase();
    const res = await sb.from('management_reports').delete().eq('id', id);
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // ===== 段階E4a: 安全Eラーニング（quiz_questions / quiz_answers）=====
  // 出題は RLS で「公開問題は全員・非公開は admin のみ」。解答ログは本人INSERT・本人/管理職SELECT。

  // 出題一覧。activeOnly=true なら公開問題のみ（学習用）。admin の精査では false で非公開も取得。
  async listQuizQuestions(activeOnly) {
    const sb = this.getSupabase();
    let q = sb.from('quiz_questions')
      .select('id, qid, unit, sub, difficulty, question, choice_a, choice_b, choice_c, choice_d, correct, explanation, source, active')
      .order('qid', { ascending: true });
    if (activeOnly) q = q.eq('active', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message || JSON.stringify(error));
    return data || [];
  },

  // 解答を1件記録（user_id は default auth.uid()・answered_at は default now()）。fire-and-forget 用途。
  async recordQuizAnswer({ question_id, qid, unit, choice, is_correct }) {
    const sb = this.getSupabase();
    const res = await sb.from('quiz_answers').insert({
      question_id: question_id != null ? question_id : null,
      qid: qid || null,
      unit: unit || null,
      choice: choice || null,
      is_correct: !!is_correct,
    });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 自分の学習カウント（今日 / 通算 の解答数）。ヘッダ表示用の軽量集計。
  async myQuizCounts() {
    const sb = this.getSupabase();
    const uid = this.userId;
    if (!uid) return { today: 0, total: 0 };
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const total = await sb.from('quiz_answers').select('id', { count: 'exact', head: true }).eq('user_id', uid);
    const today = await sb.from('quiz_answers').select('id', { count: 'exact', head: true })
      .eq('user_id', uid).gte('answered_at', start.toISOString());
    return { today: today.count || 0, total: total.count || 0 };
  },

  // ----- 出題管理（admin のみ・RLSで強制）-----
  async upsertQuizQuestion(q) {
    const sb = this.getSupabase();
    const row = {
      qid: String(q.qid || '').trim(),
      unit: q.unit, sub: q.sub || null, difficulty: q.difficulty || null,
      question: q.question, choice_a: q.choice_a, choice_b: q.choice_b,
      choice_c: q.choice_c, choice_d: q.choice_d, correct: q.correct,
      explanation: q.explanation || null, source: q.source || null,
      active: q.active !== false, updated_at: new Date().toISOString(),
    };
    const res = await sb.from('quiz_questions').upsert(row, { onConflict: 'qid' });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 一括 upsert（CSVインポート用・admin のみ）。rows は upsertQuizQuestion と同じ形の配列。
  async bulkUpsertQuizQuestions(rows) {
    const sb = this.getSupabase();
    const now = new Date().toISOString();
    const payload = rows.map(q => ({
      qid: String(q.qid || '').trim(),
      unit: q.unit, sub: q.sub || null, difficulty: q.difficulty || null,
      question: q.question, choice_a: q.choice_a, choice_b: q.choice_b,
      choice_c: q.choice_c, choice_d: q.choice_d, correct: q.correct,
      explanation: q.explanation || null, source: q.source || null,
      active: q.active !== false, updated_at: now,
    }));
    const res = await sb.from('quiz_questions').upsert(payload, { onConflict: 'qid' });
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true, count: payload.length };
  },

  async setQuizActive(id, active) {
    const sb = this.getSupabase();
    const res = await sb.from('quiz_questions').update({ active: !!active, updated_at: new Date().toISOString() }).eq('id', id);
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  async deleteQuizQuestion(id) {
    const sb = this.getSupabase();
    const res = await sb.from('quiz_questions').delete().eq('id', id);
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return { ok: true };
  },

  // 段階D: 階層の自動判定（階層1のみ自動・階層2/3は手動）。
  //   - employee_tiers に手動判定があれば最優先
  //   - 自動：所属が「工事部配下の事務所/作業所」のみ（単独所属）→ 監督職（現場監督）
  //   - それ以外（兼任・工事企画室・工事部直属・工事部外）→ 対象外（画面で手動昇格）
  judgeCategory(empNo, depts, tierByEmp) {
    const manual = tierByEmp[String(empNo).trim()];
    if (manual && this.TIER_TO_CATEGORY[manual]) return this.TIER_TO_CATEGORY[manual];
    const isSiteOffice = (d) => {
      const s = String(d || '');
      return s.includes('工事部') && (s.includes('事務所') || s.includes('作業所'));
    };
    if (depts.length === 1 && isSiteOffice(depts[0])) return '現場監督';
    return '対象外';
  },

  // 段階D: organization（構造）＋ employee_tiers（手動階層）＋ 資格ソース から社員オブジェクトを生成。
  // 旧 normalizeEmployees（区分/中計）を置換。返す形は従来と同じ（id/name/department/role/category/...）。
  buildEmployeesFromOrg(orgRows, tierRows, qualSource) {
    const tierByEmp = {};
    (tierRows || []).forEach(t => {
      const no = String(t.emp_no || '').trim();
      if (no) tierByEmp[no] = String(t.tier || '').trim();
    });
    // 段階Q: employee_quals は SmartHR「従業員の資格一覧」(1行=1人×1資格)。社員番号でグルーピングし、
    //   詳細配列(qual_details: 監督ダッシュボード用)と簡易タグ(資格軸/バッジ用)を作る。
    const detailsByEmp = {};
    (qualSource || []).forEach(q => {
      const no = String(q['社員番号'] || q.emp_no || '').trim();
      if (!no) return;
      const path = String(q['保有資格'] || '').trim();          // "種別/資格名"
      const name = String(q['コード'] || '').trim() || (path.includes('/') ? path.split('/').slice(1).join('/') : path);
      const type = path.includes('/') ? path.split('/')[0] : '';  // 資格 / 技能講習 / 特別教育 等
      if (!name) return;
      if (this.isQualHidden(name)) return;   // 段階Q: 運転免許証など個人系は表示しない
      (detailsByEmp[no] = detailsByEmp[no] || []).push({
        name, type,
        acquired: String(q['取得日'] || '').trim(),
        expiry: String(q['有効期限'] || '').trim(),
      });
    });
    const toArr = (v) => Array.isArray(v) ? v : (typeof v === 'string' && v ? (() => { try { return JSON.parse(v); } catch (e) { return []; } })() : []);
    return (orgRows || []).map(r => {
      const empNo = String(r.emp_no || '').trim();
      const depts = [...new Set(toArr(r.depts))];        // 重複部署を除去（単独/兼任判定を正確に）
      const positions = toArr(r.positions);
      const primary = depts[0] || '';
      return {
        id: parseInt(empNo, 10) || empNo,
        name: `${r.last_name || ''} ${r.first_name || ''}`.trim(),
        department: primary ? String(primary).split('/').pop() : '',
        role: positions[0] || '',
        role_title: positions[0] || '',
        qualifications_raw: this.deriveSekouTags(
          (detailsByEmp[empNo] || []).map(d => d.name)
            .concat(this.EXPERIENCE_SEKOU[empNo] ? [this.EXPERIENCE_SEKOU[empNo]] : [])
        ).join('、'),
        qual_details: detailsByEmp[empNo] || [],
        category: this.judgeCategory(empNo, depts, tierByEmp),
        status: 'active',
        rank: '',
        depts,            // 組織図画面用に保持
        positions,        // 同上
        emp_no: empNo,
      };
    }).filter(e => e.id && e.name);
  },

  // 取得済みの生テーブル（this.cache）から employees 正規化・projects/assignments 派生・
  // overrides/status マージを行う。Sheets 経路 / Supabase 経路で共通。
  processRawTables() {
      // 段階D: organization があれば組織図ベースで社員生成（階層1自動＋手動tier）。
      // 無ければ従来の 01_employees ベース（normalizeEmployees）。
      if (this.cache.organization && this.cache.organization.length > 0) {
        try {
          this.cache.employees = this.buildEmployeesFromOrg(
            this.cache.organization, this.cache.employee_tiers, this.cache.employee_quals);
        } catch (e) {
          console.error('組織図ベース社員生成失敗・旧employeesにフォールバック:', e);
          try { this.cache.employees = this.normalizeEmployees(this.cache.employees); }
          catch (e2) { this.cache.employees = MOCK_DATA.employees; }
        }
      } else if (this.cache.employees && this.cache.employees.length > 0) {
        try {
          this.cache.employees = this.normalizeEmployees(this.cache.employees);
        } catch (e) {
          console.warn('employees 正規化失敗・モックにフォールバック:', e);
          this.cache.employees = MOCK_DATA.employees;
        }
      }
      // employees が無い場合はモックを使用
      if (!this.cache.employees || this.cache.employees.length === 0) {
        this.cache.employees = MOCK_DATA.employees;
      }
      // 資格は employees F列のみをソースとする（v0.5方針）
      // - mock_data フォールバック使わない
      // - Salesforce 🔴🔵 派生も使わない（v0.6で別ソース統合時に再検討）
      // - F列が空欄の社員は資格軸に表示されない
      this.cache.qualifications = [];
      this.cache.employee_qualifications = [];
      try {
        const d = this.deriveQualificationsFromEmployees(
          this.cache.employees,
          [],
          []
        );
        this.cache.qualifications = d.qualifications;
        this.cache.employee_qualifications = d.employee_qualifications;
      } catch (e) {
        console.error('deriveQualificationsFromEmployees 失敗:', e);
      }

      // Salesforce + prospects から projects と assignments を派生（個別に try-catch）
      let allProjects = [];
      let allAssignments = [];
      if (this.cache.salesforce_imports && this.cache.salesforce_imports.length > 0) {
        try {
          const d = this.deriveFromSalesforce(this.cache.salesforce_imports, this.cache.employees);
          allProjects = allProjects.concat(d.projects);
          allAssignments = allAssignments.concat(d.assignments);
        } catch (e) {
          console.error('deriveFromSalesforce 失敗:', e);
        }
        // Salesforce 🔴🔵派生は v0.5 で停止（F列のみソース）
        // v0.6 で別ソース統合時に再有効化検討
      }
      if (this.cache.prospects && this.cache.prospects.length > 0) {
        try {
          const d = this.deriveFromProspects(this.cache.prospects, this.cache.employees);
          allProjects = allProjects.concat(d.projects);
          allAssignments = allAssignments.concat(d.assignments);
        } catch (e) {
          console.error('deriveFromProspects 失敗:', e);
        }
      }
      if (allProjects.length > 0 || allAssignments.length > 0) {
        this.cache.projects = allProjects;
        this.cache.assignments = allAssignments;
      } else {
        this.cache.projects = MOCK_DATA.projects;
        this.cache.assignments = MOCK_DATA.assignments;
      }

      // assignment_overrides を assignments にマージ（v4: op 別処理対応）
      if (this.cache.assignment_overrides && this.cache.assignment_overrides.length > 0) {
        try {
          this.cache.assignments = this.mergeOverridesIntoAssignments(
            this.cache.assignments,
            this.cache.assignment_overrides,
            this.cache.projects
          );
        } catch (e) {
          console.error('overrides マージ失敗:', e);
        }
      }

      // project_status_overrides を projects にマージ（v5: completed フラグの手動上書き）
      // 自動判定（planned_end < 今日）の誤判定を手動で修正できる
      if (this.cache.project_status_overrides && this.cache.project_status_overrides.length > 0) {
        try {
          this.cache.projects = this.mergeProjectStatusOverrides(
            this.cache.projects,
            this.cache.project_status_overrides
          );
        } catch (e) {
          console.error('project_status_overrides マージ失敗:', e);
        }
      }
  },

  loadMockData() {
    this.cache = {
      employees: MOCK_DATA.employees,
      projects: MOCK_DATA.projects,
      assignments: MOCK_DATA.assignments,
      qualifications: MOCK_DATA.qualifications,
      employee_qualifications: MOCK_DATA.employee_qualifications,
      departments: [],
      salesforce_imports: [],
    };
  },
};
