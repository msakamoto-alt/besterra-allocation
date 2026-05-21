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

  SHEET_NAMES: {
    employees: 'employees',
    departments: 'departments',
    projects: 'projects',
    assignments: 'assignments',
    qualifications: 'qualifications',
    employee_qualifications: 'employee_qualifications',
    salesforce_imports: 'salesforce_imports',
    prospects: 'prospects',
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
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const c = this.parseRow(lines[i]);
      if ((c[1] || '').includes('合計')) continue;
      const emp_name = this.normalizeName(c[3] || '');
      const project_id = (c[6] || '').trim();
      if (!emp_name || !project_id) continue;
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

  // 完成工事の判定
  isCompletedProject(status) {
    const s = String(status || '');
    return /完成|完工|完了|終了/.test(s);
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
      const completed = this.isCompletedProject(r.status);

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
      // 各シートの取得（並列・失敗してもキャッシュにフォールバック）
      const tasks = [
        { name: 'employees', sheet: this.SHEET_NAMES.employees, parser: 'normal' },
        { name: 'departments', sheet: this.SHEET_NAMES.departments, parser: 'normal' },
        { name: 'qualifications', sheet: this.SHEET_NAMES.qualifications, parser: 'normal' },
        { name: 'employee_qualifications', sheet: this.SHEET_NAMES.employee_qualifications, parser: 'normal' },
        { name: 'salesforce_imports', sheet: this.SHEET_NAMES.salesforce_imports, parser: 'salesforce' },
        { name: 'prospects', sheet: this.SHEET_NAMES.prospects, parser: 'normal' },
      ];
      const results = await Promise.allSettled(tasks.map(t => this.fetchSheetRaw(t.sheet)));

      results.forEach((r, i) => {
        const task = tasks[i];
        if (r.status === 'fulfilled') {
          try {
            if (task.parser === 'salesforce') {
              this.cache.salesforce_imports = this.parseSalesforceCsv(r.value);
            } else {
              this.cache[task.name] = this.parseCSV(r.value);
            }
          } catch (e) {
            console.warn(`${task.name} パース失敗:`, e);
          }
        } else {
          console.warn(`${task.name} 取得失敗:`, r.reason);
        }
      });

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

      // Salesforce + prospects から projects と assignments を派生
      let allProjects = [];
      let allAssignments = [];
      if (this.cache.salesforce_imports && this.cache.salesforce_imports.length > 0) {
        const d = this.deriveFromSalesforce(this.cache.salesforce_imports, this.cache.employees);
        allProjects = allProjects.concat(d.projects);
        allAssignments = allAssignments.concat(d.assignments);
      }
      if (this.cache.prospects && this.cache.prospects.length > 0) {
        const d = this.deriveFromProspects(this.cache.prospects, this.cache.employees);
        allProjects = allProjects.concat(d.projects);
        allAssignments = allAssignments.concat(d.assignments);
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
