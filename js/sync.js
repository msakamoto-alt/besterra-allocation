/**
 * sync.js - Google Sheets CSV同期
 *
 * Sheets を「リンクを知っている全員 閲覧可」に設定し、
 * 各シートを CSV export URL で取得する。
 */

const Sync = {
  /**
   * Google Sheets ID（config で設定）
   * Sheets作成後に config.js で上書き
   */
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
    if (!this.SHEET_ID) {
      throw new Error('SHEET_ID が未設定です。js/config.js を作成してください。');
    }
    return `https://docs.google.com/spreadsheets/d/${this.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  },

  async fetchSheet(sheetName) {
    const response = await fetch(this.csvUrl(sheetName));
    if (!response.ok) throw new Error(`Sheet取得失敗: ${sheetName}`);
    const text = await response.text();
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

  async syncAll() {
    const sheets = Object.values(this.SHEET_NAMES);
    const results = await Promise.allSettled(
      sheets.map(name => this.fetchSheet(name))
    );
    results.forEach((r, i) => {
      const name = sheets[i];
      if (r.status === 'fulfilled') {
        this.cache[name] = r.value;
      } else {
        console.warn(`${name} 取得失敗:`, r.reason);
        this.cache[name] = this.cache[name] || [];
      }
    });
    this.lastSync = new Date();
    return this.cache;
  },

  /**
   * モックデータ（SHEET_ID未設定時のフォールバック）
   * 初回動作確認用
   */
  loadMockData() {
    this.cache = {
      employees: [
        { employee_id: '2001', name: 'サンプル太郎', department_id: 'D001', role_title: '監督', category: '監督職', status: 'active', hired_at: '2010-04-01' },
        { employee_id: '2002', name: 'サンプル花子', department_id: 'D002', role_title: '主任', category: '監督職', status: 'active', hired_at: '2015-04-01' },
        { employee_id: '2003', name: 'サンプル次郎', department_id: 'D001', role_title: '副主任', category: '準監督職', status: 'active', hired_at: '2018-04-01' },
      ],
      departments: [
        { department_id: 'D001', department_name: '千葉事務所' },
        { department_id: 'D002', department_name: '京浜事務所' },
      ],
      projects: [],
      assignments: [],
      qualifications: [],
      employee_qualifications: [],
    };
    this.lastSync = new Date();
    return this.cache;
  },
};
