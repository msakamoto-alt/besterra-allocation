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
  },

  // 各シートの形式バリデータ（先頭行で判定）
  SHEET_VALIDATORS: {
    employees: txt => /employee_id|社員番号|名前/i.test((txt || '').split('\n')[0] || ''),
    departments: txt => /department_id|department_name|事務所|部署/i.test((txt || '').split('\n')[0] || ''),
    qualifications: txt => /qualification_id|qualification_name|資格/i.test((txt || '').split('\n')[0] || ''),
    employee_qualifications: txt => /record_id|qualification_id|emp_id|社員|資格/i.test((txt || '').split('\n')[0] || ''),
    salesforce_imports: txt => /工事部員|工事番号|人事配置一覧|現場管理表/i.test((txt || '').split('\n')[0] || ''),
    prospects: txt => /prospect_id|project_name|customer|見込み/i.test((txt || '').split('\n')[0] || ''),
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

  // === Salesforce レポート専用パーサ ===
  // 構造：1行目=タイトル兼ヘッダ、2行目〜=データ、末尾=「合計」行
  // 列：A=空, B=所属, C=空, D=工事部員, E=ロール, F=ロール詳細,
  //     G=工事番号, H=工事名, I=着工, J=完工, K=総売上, L=受注金額, M=状態, N=空
  parseSalesforceCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    // ヘッダ検証：Salesforce形式かどうか
    const firstLine = lines[0] || '';
    const isSalesforce = firstLine.includes('工事部員') || firstLine.includes('工事番号')
      || firstLine.includes('人事配置一覧') || firstLine.includes('現場管理表');
    if (!isSalesforce) {
      console.warn('salesforce_imports シートが Salesforce形式ではありません。スキップします。', firstLine.substring(0, 100));
      return [];
    }

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const c = this.parseRow(lines[i]);
      if ((c[1] || '').includes('合計')) continue;
      const emp_name = this.normalizeName(c[3] || '');
      const project_id = (c[6] || '').trim();
      // 工事番号必須・空/合計/プレースホルダー/英数字-形式外をスキップ
      if (!emp_name || !project_id) continue;
      if (/^(-|nan|null|na|n\/a|undefined)$/i.test(project_id)) continue;
      // 工事番号は通常 K\d+-\d+ 形式。最低限「英字 + 数字」が含まれていること
      if (!/[A-Za-z]/.test(project_id) || !/\d/.test(project_id)) continue;
      rows.push({
        department: c[1] || '',
        emp_name,
        emp_name_raw: c[3] || '',
        role: c[4] || '',
        role_detail: c[5] || '',
        project_id,
        project_name: c[7] || '',
        start: this.normalizeDate(c[8]),
        end: this.normalizeDate(c[9]),
        total_revenue: c[10] || '',
        order_amount: c[11] || '',
        status: c[12] || '',
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
        category: r.category || '対象外',
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
          if (kubun.includes('準') || kubun.includes('準監督')) category = '準監督職';
          else if (kubun === '監督職') category = '監督職';
          else category = '広義監督職';
        } else {
          // 中計外でも区分から判定（フェイルセーフ）
          if (kubun.includes('準')) category = '準監督職';
          else if (kubun === '監督職') category = '監督職';
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

  // ロールマッピング：Salesforceロール → 役割色（主任技術者/副監督/支援/視察）
  mapRole(sfRole) {
    if (!sfRole) return '支援';
    if (sfRole.includes('責任者')) return '主任技術者';
    if (sfRole.includes('メンバー')) return '副監督';
    if (sfRole.includes('応援')) return '支援';
    if (sfRole.includes('視察')) return '視察';
    return '支援';
  },

  // 役割表示順（バー描画・ソート用）
  ROLE_ORDER: { '主任技術者': 0, '副監督': 1, '支援': 2, '視察': 3 },

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

  // 氏名先頭の絵文字から資格を判定（🔴=専任技術者 / 🔵=主任技術者）
  detectQualMarker(rawName) {
    if (!rawName) return null;
    if (rawName.includes('🔴')) return 'Q-DED';   // 専任技術者
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

  // 見込み案件（prospects）から projects と assignments を派生
  // 1行 = 1配置候補（人×現場×期間）。同じ prospect_id の複数行は projects は1件、assignments は複数
  deriveFromProspects(prospectRows, employees) {
    const projectsMap = {};
    const assignments = [];
    const empByName = {};
    (employees || []).forEach(e => {
      const key = (e.name || '').replace(/\s+/g, '');
      if (key) empByName[key] = e;
    });

    let asgIdSeq = 10000;  // Salesforce由来と衝突しないよう大きな値から
    prospectRows.forEach(r => {
      const pid = String(r.prospect_id || '').trim();
      if (!pid) return;

      if (!projectsMap[pid]) {
        projectsMap[pid] = {
          project_id: pid,
          name: r.project_name,
          customer: r.customer,
          start: this.normalizeDate(r.start_date),
          end: this.normalizeDate(r.end_date),
          amount: this.parseAmount(r.amount),
          kind: '見込み',
          dept: r.managing_dept || '',
          status: r.status || '見込み',
          probability: r.probability || '',
          prospect: true,
          completed: false,
        };
      }

      const empName = this.normalizeName(r.proposed_member || '');
      if (!empName) return;
      const empKey = empName.replace(/\s+/g, '');
      const emp = empByName[empKey];

      assignments.push({
        assignment_id: asgIdSeq++,
        emp_id: emp ? emp.id : null,
        emp_name: empName,
        project_id: pid,
        project_name: r.project_name,
        allocation: 1,
        join: this.normalizeDate(r.start_date),
        leave: null,
        planned_end: this.normalizeDate(r.end_date),
        role: this.mapRole(r.role) || (r.role || '副監督'),
        role_sf: r.role,
        confirmed: false,
        completed: false,
        prospect: true,
        source: 'prospect',
      });
    });

    // 役割順→氏名でソート
    assignments.sort((a, b) => {
      const ra = this.ROLE_ORDER[a.role] ?? 99;
      const rb = this.ROLE_ORDER[b.role] ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.emp_name || '').localeCompare(b.emp_name || '');
    });

    return {
      projects: Object.values(projectsMap),
      assignments,
    };
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

    // 役割順→氏名でソート（主任技術者を一番上に）
    assignments.sort((a, b) => {
      const ra = this.ROLE_ORDER[a.role] ?? 99;
      const rb = this.ROLE_ORDER[b.role] ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.emp_name || '').localeCompare(b.emp_name || '');
    });

    return {
      projects: Object.values(projectsMap),
      assignments,
    };
  },

  async syncAll() {
    if (this.SHEET_ID) {
      // 各シートを候補名でフォールバック取得（バリデータでヘッダ確認）
      const keys = ['employees', 'departments', 'qualifications', 'employee_qualifications', 'salesforce_imports', 'prospects'];
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
