/**
 * sync.js - Google Sheets CSV同期
 *
 * config.js で SHEET_ID が設定されていれば Sheets から取得、
 * 未設定なら MOCK_DATA（mock_data.js）を返す。
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
  },

  cache: {},
  lastSync: null,

  csvUrl(sheetName) {
    if (!this.SHEET_ID) throw new Error('SHEET_ID 未設定');
    return `https://docs.google.com/spreadsheets/d/${this.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  },

  async fetchSheet(sheetName) {
    const response = await fetch(this.csvUrl(sheetName));
    if (!response.ok) throw new Error(`Sheet取得失敗: ${sheetName}`);
    return this.parseCSV(await response.text());
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

  async syncAll() {
    if (this.SHEET_ID) {
      const sheets = Object.values(this.SHEET_NAMES);
      const results = await Promise.allSettled(sheets.map(name => this.fetchSheet(name)));
      results.forEach((r, i) => {
        const name = sheets[i];
        if (r.status === 'fulfilled') this.cache[name] = r.value;
        else console.warn(`${name} 取得失敗:`, r.reason);
      });
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
    };
  },
};
