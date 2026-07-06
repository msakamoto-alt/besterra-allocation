/**
 * sync.js - データ層コア（接続・同期パイプライン・パース・照合）
 *
 * グローバル Sync の本体。責務別モジュールが Object.assign(Sync, {...}) で
 * メソッドを追加する構成（2026-07 刷新で分割）:
 *   js/sync/sheets.js  Sheets取込（同期ボタン）
 *   js/sync/derive.js  派生・変換（processRawTables ほか）
 *   js/sync/db.js      Supabase書込CRUD
 *   js/sync/auth.js    認証・アカウント管理
 * 読込順は index.html 参照（sync.js → sync/*.js → views/*.js → config.js → app.js）。
 * ※検証スクリプト(verify_normname/empno/audit)が本ファイルを単体ロードするため、
 *   normEmpKey / mergeOverridesIntoAssignments / auditUnresolvedAssignments と
 *   その依存はコアに残すこと。
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
  role: null,        // 段階E1: ログインユーザーのロール（admin/editor/executive/manager/viewer/accounting）
  ADMIN_FN: 'admin-users',  // 段階E1.5: アカウント管理 Edge Function 名（config.js で実デプロイ名に上書き可）

  cache: {},
  lastSync: null,

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

  // 氏名の異体字を代表字へ畳む対応表（旧字体・人名異体字 → 常用字）。
  // 例：髙橋⇔高橋 / 﨑⇔崎 / 邉邊⇔辺 / 齋齊⇔斉。照合キー生成専用（表示名は変えない）。
  // 新たな食い違いが出たら1行追記すれば対応できる。
  NAME_VARIANT_MAP: {
    '髙': '高', '﨑': '崎', '邉': '辺', '邊': '辺',
    '齋': '斉', '齊': '斉', '斎': '斉',
    '濵': '浜', '濱': '浜', '冨': '富', '廣': '広',
    '德': '徳', '桒': '桑', '栁': '柳', '舘': '館',
  },

  // 氏名照合キー：NFKC正規化 → 全空白除去 → 異体字を代表字へ畳む。
  // emp_name → emp_id の突合専用。表示名・override_key には使わない（既存データ互換のため）。
  normEmpKey(name) {
    const s = String(name == null ? '' : name).normalize('NFKC').replace(/\s+/g, '');
    let out = '';
    for (const ch of s) out += (this.NAME_VARIANT_MAP[ch] || ch);
    return out;
  },

  // 健全性チェック：当社社員として登録された配置のうち emp_id が解決できていないものを返す。
  // 派遣社員・配置未定/不足は対象外（意図的に emp_id を持たない）。
  // ★進行中・今後の案件のみ対象（完成・終了済みは除外）。退職者の過去配置は履歴でありエラーではないが、
  //   退職者が「現役の案件」の担当に残っているのは是正すべきエラーとして検出する。
  // 使い方（編集ログイン中のコンソール）：Sync.auditUnresolvedAssignments()
  auditUnresolvedAssignments() {
    const isDispatch = n => /^派遣社員\s*#\d+$/.test(String(n || '').trim());
    const isPlaceholder = n => String(n || '').trim() === '配置未定・不足';
    const projById = {};
    (this.cache.projects || []).forEach(p => { projById[p.project_id] = p; });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const parseEnd = s => { const d = new Date(String(s || '').replace(/\//g, '-')); return isNaN(d) ? null : d; };
    return (this.cache.assignments || [])
      .filter(a => (a.emp_id == null) && !isDispatch(a.emp_name) && !isPlaceholder(a.emp_name))
      .filter(a => {
        const p = projById[a.project_id];
        if (p && p.completed) return false;                 // 完成案件は履歴扱い
        const end = parseEnd(a.planned_end || (p && p.end));
        if (end && end < today) return false;               // 終了日が過去＝履歴（日付不明は安全側で残す）
        return true;                                        // 進行中・今後のみ＝現役の不一致
      })
      .map(a => ({
        emp_name: a.emp_name, emp_no: a.emp_no || '',
        project_id: a.project_id, project_name: a.project_name,
        role: a.role, join: a.join, planned_end: a.planned_end || '', source: a.source || '',
      }));
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
    const empById = {};   // 社員番号(e.id) → 社員。emp_no による恒久紐付けの引き先
    employees.forEach(e => {
      const k = this.normEmpKey(e.name);
      if (k) empByName[k] = e;
      if (e.id != null && String(e.id) !== '') empById[String(e.id).trim()] = e;
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

      // 社員番号(emp_no)があれば最優先で引く（氏名変更・異体字に影響されない恒久キー）。
      // 無い既存行は氏名の正規化照合へフォールバック。
      const empNo = String(o.emp_no || '').trim();
      const emp = (empNo && empById[empNo]) || empByName[this.normEmpKey(empName)];
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
      // Supabase も SHEET_ID も未設定＝設定不備。空キャッシュのまま警告する
      // （旧 loadMockData のモック起動経路は削除済み。config.js は常にリポジトリに存在する）。
      console.error('config.js 未設定: SUPABASE_URL / SHEET_ID のいずれも無いため データを取得できません');
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
    const [sf, pro, ov, gw, ps, org, tiers, quals, absences] = await Promise.all([
      fetchTable('salesforce_imports', 'id'),
      fetchTable('prospects', null),
      fetchTable('assignment_overrides', null),
      fetchTable('g_work_logs', 'id'),
      fetchTable('project_status_overrides', null),
      fetchTable('organization', 'id'),       // 段階D: 組織図名簿（無ければ[]）
      fetchTable('employee_tiers', null),      // 段階D: 階層判定（無ければ[]）
      fetchTable('employee_quals', 'id'),      // 段階D5: 資格マスタ（無ければ[]）
      fetchTable('employee_absences', 'id'),   // 不在（長期休暇/休職/育休等・無ければ[]）
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
    this.cache.employee_absences = absences;
    console.info('Supabaseから取得:',
      `sf=${sf.length}`, `prospects=${pro.length}`,
      `overrides=${ov.length}`, `glogs=${gw.length}`, `status=${ps.length}`,
      `org=${org.length}`, `tiers=${tiers.length}`, `quals=${quals.length}`, `absences=${absences.length}`);
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

  // ===== 監査ログ（audit_logs・admin のみ＝RLSでもサーバー強制）=====
  // 記録はDBトリガー（add_audit_logs.sql）が自動で行う。ここは閲覧のみ。
  // beforeId より古いログを limit 件（id降順＝新しい順）。
  async fetchAuditLogs({ table = '', op = '', beforeId = null, limit = 100 } = {}) {
    const sb = this.getSupabase();
    let q = sb.from('audit_logs').select('*').order('id', { ascending: false }).limit(limit);
    if (table) q = q.eq('table_name', table);
    if (op) q = q.eq('op', op);
    if (beforeId) q = q.lt('id', beforeId);
    const res = await q;
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return res.data || [];
  },
};
