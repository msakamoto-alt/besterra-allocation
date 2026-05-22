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
    const headers = this.parseRow(lines[0]);
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
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuote = !inQuote;
      else if (c === ',' && !inQuote) { result.push(cur); cur = ''; }
      else cur += c;
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

      // 工事番号がある場合のバリデーション
      let pid = project_id;
      if (project_id) {
        if (/^(-|nan|null|na|n\/a|undefined)$/i.test(project_id)) continue;
        if (!/[A-Za-z]/.test(project_id) || !/\d/.test(project_id)) continue;
      } else {
        // 工事番号列が無い場合は工事名をフォールバックIDに（暫定）
        const pname = (c[cols.project_name] || '').trim();
        if (!pname) continue;
        pid = 'NOID-' + pname.substring(0, 20);
      }

      rows.push({
        department: c[cols.dept] || '',
        emp_name,
        emp_name_raw: c[cols.emp] || '',
        role: c[cols.role] || '',
        role_detail: c[cols.role_detail] || '',
        contract_type: c[cols.contract_type] || '',
        project_id: pid,
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

    // Phase 0 ベース形式（No, 社員番号, 名前, 部門, 役職, 区分, 中計, 所属（最終判定））
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
          category,
          status: 'active',
          rank: '',
        };
      }).filter(e => e.id && e.name);
    }

    // どちらでもなければ生データのまま返す
    return raw;
  },

  // ロールマッピング：Salesforceロール → 役割色（主任技術者/副監督/応援）
  // 旧「視察」「支援」は「応援」に統合
  mapRole(sfRole) {
    if (!sfRole) return '応援';
    if (sfRole.includes('責任者')) return '主任技術者';
    if (sfRole.includes('メンバー')) return '副監督';
    return '応援';  // 応援・視察・支援・その他すべて応援
  },

  // 旧表記「支援」「視察」を新表記「応援」に正規化
  normalizeRole(role) {
    const r = String(role || '').trim();
    if (r === '支援' || r === '視察') return '応援';
    return r;
  },

  // 役割表示順（バー描画・ソート用）
  ROLE_ORDER: { '主任技術者': 0, '監理技術者': 0, '副監督': 1, '応援': 2 },

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

  // override 行を assignments にマージ（同一 emp_name × project_id を上書き）
  // override 側に値があるカラムのみ上書き、空欄は元値を尊重
  mergeOverridesIntoAssignments(assignments, overrideRows) {
    if (!Array.isArray(overrideRows) || overrideRows.length === 0) return assignments;
    const map = {};
    overrideRows.forEach(r => {
      const key = String(r.override_key || this.buildOverrideKey(r.emp_name, r.project_id) || '').trim();
      if (!key) return;
      map[key] = r;
    });

    let appliedCount = 0;
    const merged = assignments.map(a => {
      const key = this.buildOverrideKey(a.emp_name, a.project_id);
      const o = map[key];
      if (!o) return a;
      appliedCount++;
      const next = { ...a };
      if (o.join_date) next.join = this.normalizeDate(o.join_date);
      if (o.planned_end) next.planned_end = this.normalizeDate(o.planned_end);
      if (o.role) next.role = o.role;
      next.overridden = true;
      next.override_note = o.note || '';
      next.override_updated_at = o.updated_at || '';
      return next;
    });

    if (appliedCount > 0) {
      console.info(`assignment_overrides: ${appliedCount} 件をマージ`);
    } else {
      console.info(`assignment_overrides: ${overrideRows.length} 行あるが対応する配置に一致なし`);
    }
    return merged;
  },

  // GAS Web App に POST（配属期間 override の upsert / delete）
  // Content-Type を text/plain にして CORS preflight を回避
  async postOverride(payload) {
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

  async syncAll() {
    if (this.SHEET_ID) {
      // 各シートを候補名でフォールバック取得（バリデータでヘッダ確認）
      const keys = ['employees', 'departments', 'qualifications', 'employee_qualifications', 'salesforce_imports', 'prospects', 'assignment_overrides', 'g_work_logs'];
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

      // employees の正規化（仕様書テンプレ / Phase0ベース 両形式対応）
      if (this.cache.employees && this.cache.employees.length > 0) {
        try {
          this.cache.employees = this.normalizeEmployees(this.cache.employees);
        } catch (e) {
          console.warn('employees 正規化失敗・モックにフォールバック:', e);
          this.cache.employees = MOCK_DATA.employees;
        }
      }
      // employees が Sheets に無い場合はモックを使用
      if (!this.cache.employees || this.cache.employees.length === 0) {
        this.cache.employees = MOCK_DATA.employees;
      }
      if (!this.cache.qualifications || this.cache.qualifications.length === 0) {
        this.cache.qualifications = MOCK_DATA.qualifications;
      }
      if (!this.cache.employee_qualifications || this.cache.employee_qualifications.length === 0) {
        this.cache.employee_qualifications = MOCK_DATA.employee_qualifications;
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
        try {
          this.cache.employee_qualifications = this.deriveQualificationsFromSalesforce(
            this.cache.salesforce_imports,
            this.cache.employees,
            this.cache.employee_qualifications
          );
        } catch (e) {
          console.error('deriveQualificationsFromSalesforce 失敗:', e);
        }
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

      // assignment_overrides を assignments にマージ（Salesforce由来のみ対象）
      if (this.cache.assignment_overrides && this.cache.assignment_overrides.length > 0) {
        try {
          this.cache.assignments = this.mergeOverridesIntoAssignments(
            this.cache.assignments,
            this.cache.assignment_overrides
          );
        } catch (e) {
          console.error('overrides マージ失敗:', e);
        }
      }
    } else {
      this.loadMockData();
      console.info('SHEET_ID未設定のためモックデータで動作中');
    }
    this.lastSync = new Date();
    return this.cache;
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
