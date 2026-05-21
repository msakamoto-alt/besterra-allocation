/**
 * gantt.js - 現場人員配置（4軸ガント＋月→日ドリルダウン）
 *
 * 縦軸：project（現場）/ person（人）/ department（事務所）/ qualification（資格）
 * 横軸：時間（2行ヘッダ：月行＋日行）
 */

const GanttView = {
  currentAxis: 'project',
  expandedMonths: new Set(),  // 'YYYY-M' のキーで展開状態を保持

  MONTH_WIDTH: 70,
  DAY_WIDTH: 26,
  LABEL_WIDTH: 300,
  ROW_HEIGHT: 48,

  AXIS_DESC: {
    project: '縦軸＝現場、横軸＝配置監督。月ヘッダ「⊞」クリックで該当月を日単位にドリルダウン、「⊟」クリックで月表示に戻す。',
    person: '縦軸＝監督職員、横軸＝配置現場。1人複数現場の配置も把握可能。月ヘッダ「⊞」で日次展開。',
    department: '縦軸＝事務所配下の個人、横軸＝配置現場。事務所別の配置状況が個人別に分かる。',
    qualification: '縦軸＝資格別の保有者、横軸＝配置現場。同一人が複数資格を持つ場合は各資格グループに繰り返し表示される。',
  },

  init() {
    document.querySelectorAll('.gantt-axis-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentAxis = btn.dataset.axis;
        this.refresh();
      });
    });
    document.getElementById('gantt-container').addEventListener('click', (e) => {
      const th = e.target.closest('[data-month-key]');
      if (!th) return;
      const key = th.dataset.monthKey;
      if (this.expandedMonths.has(key)) this.expandedMonths.delete(key);
      else this.expandedMonths.add(key);
      this.refresh();
    });
  },

  refresh() {
    document.querySelectorAll('.gantt-axis-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.axis === this.currentAxis);
    });
    document.getElementById('gantt-description').textContent = this.AXIS_DESC[this.currentAxis] || '';

    const container = document.getElementById('gantt-container');
    switch (this.currentAxis) {
      case 'project': container.innerHTML = this.renderProjectAxis(); break;
      case 'person': container.innerHTML = this.renderPersonAxis(); break;
      case 'department': container.innerHTML = this.renderDepartmentAxis(); break;
      case 'qualification': container.innerHTML = this.renderQualificationGantt(); break;
    }
  },

  // ===== 共通：日付・セル =====

  parseDate(s) {
    if (s instanceof Date) return s;
    return new Date(String(s).replace(/\//g, '-'));
  },

  monthKey(date) { return date.getFullYear() + '-' + (date.getMonth() + 1); },

  // 表示範囲：projects と employee_qualifications を考慮
  buildCells(extraDates = []) {
    const projects = Sync.cache.projects || [];
    let dates = projects.flatMap(p => [p.start, p.end]).filter(Boolean).map(s => this.parseDate(s));
    dates = dates.concat(extraDates.filter(Boolean).map(s => this.parseDate(s)));
    if (dates.length === 0) return [];
    let minD = new Date(Math.min(...dates));
    let maxD = new Date(Math.max(...dates));
    minD = new Date(minD.getFullYear(), minD.getMonth(), 1);
    maxD = new Date(maxD.getFullYear(), maxD.getMonth() + 1, 1);

    const cells = [];
    let cur = new Date(minD);
    while (cur < maxD) {
      const key = this.monthKey(cur);
      if (this.expandedMonths.has(key)) {
        const daysInMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
        for (let d = 1; d <= daysInMonth; d++) {
          cells.push({
            type: 'day', date: new Date(cur.getFullYear(), cur.getMonth(), d),
            width: this.DAY_WIDTH, label: d, monthKey: key,
            monthLabel: cur.getFullYear() + '/' + (cur.getMonth() + 1),
          });
        }
      } else {
        cells.push({
          type: 'month', date: new Date(cur),
          width: this.MONTH_WIDTH,
          label: cur.getFullYear() + '/' + (cur.getMonth() + 1), monthKey: key,
        });
      }
      cur.setMonth(cur.getMonth() + 1);
    }
    return cells;
  },

  cellsTotalWidth(cells) {
    return cells.reduce((s, c) => s + c.width, 0);
  },

  // 日付をpx座標に変換
  dateToPx(date, cells) {
    let px = 0;
    for (const cell of cells) {
      let cellEnd;
      if (cell.type === 'month') {
        cellEnd = new Date(cell.date.getFullYear(), cell.date.getMonth() + 1, 1);
      } else {
        cellEnd = new Date(cell.date.getFullYear(), cell.date.getMonth(), cell.date.getDate() + 1);
      }
      if (date < cellEnd) {
        const cellStart = cell.date;
        const cellDur = cellEnd - cellStart;
        const offset = Math.max(0, date - cellStart);
        const ratio = Math.min(1, offset / cellDur);
        return px + ratio * cell.width;
      }
      px += cell.width;
    }
    return px;
  },

  // 2行ヘッダ：月行＋日行（行高さ明示・展開アイコン付き）
  headerHtml(cells) {
    let row1 = `<tr style="height:36px"><th rowspan="2" class="p-2 bg-slate-200 sticky left-0 border-r text-left z-20 align-middle" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px;height:60px">縦軸 / 配置</th>`;
    let row2 = '<tr style="height:24px">';

    let i = 0;
    while (i < cells.length) {
      const c = cells[i];
      if (c.type === 'month') {
        // 月単位表示（クリックで日展開）
        row1 += `<th data-month-key="${c.monthKey}" class="bg-slate-100 border-r px-1 py-1 text-xs cursor-pointer hover:bg-slate-200 align-middle whitespace-nowrap" style="min-width:${c.width}px;width:${c.width}px" title="クリックで日次展開">${c.label} <span class="text-slate-400">⊞</span></th>`;
        row2 += `<th class="bg-slate-50 border-r" style="min-width:${c.width}px;width:${c.width}px;height:24px;border-bottom:2px solid #cbd5e1"></th>`;
        i++;
      } else {
        // 日セル群（同じmonthKeyが連続する範囲）
        let j = i;
        while (j < cells.length && cells[j].type === 'day' && cells[j].monthKey === c.monthKey) j++;
        const span = j - i;
        const totalW = cells.slice(i, j).reduce((s, x) => s + x.width, 0);
        row1 += `<th colspan="${span}" data-month-key="${c.monthKey}" class="bg-amber-200 border-r border-l px-1 py-1 text-xs font-bold cursor-pointer hover:bg-amber-300 text-amber-900 whitespace-nowrap" style="min-width:${totalW}px;width:${totalW}px" title="クリックで月表示に戻す">${c.monthLabel} <span class="text-amber-700">⊟</span></th>`;
        for (let k = i; k < j; k++) {
          row2 += `<th class="bg-amber-50 border-r text-[11px] text-amber-900 font-semibold" style="min-width:${cells[k].width}px;width:${cells[k].width}px;height:24px;padding:2px 0">${cells[k].label}</th>`;
        }
        i = j;
      }
    }
    row1 += '</tr>';
    row2 += '</tr>';
    return '<thead class="sticky top-0 z-10">' + row1 + row2 + '</thead>';
  },

  // 背景の縦罫線
  gridDivs(cells) {
    let html = '';
    let px = 0;
    cells.forEach(c => {
      const bg = c.type === 'day' ? 'background:#fffbeb;' : '';
      html += `<div style="position:absolute;left:${px}px;width:${c.width}px;top:0;bottom:0;border-right:1px solid #e5e7eb;${bg}"></div>`;
      px += c.width;
    });
    return html;
  },

  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // ===== 1. 現場軸 =====

  renderProjectAxis() {
    const projects = Sync.cache.projects || [];
    const assignments = Sync.cache.assignments || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">データなし</p>';
    const totalW = this.cellsTotalWidth(cells);

    let html = `<table class="border-collapse" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    projects.forEach(p => {
      const start = this.parseDate(p.start);
      const end = this.parseDate(p.end);
      const barLeft = this.dateToPx(start, cells);
      const barRight = this.dateToPx(end, cells);
      const barWidth = Math.max(20, barRight - barLeft - 2);
      const empNames = assignments.filter(a => a.project_id === p.project_id)
        .map(a => `${a.emp_name}(${Math.round(a.allocation * 100)}%)`).join(' / ');
      const color = p.amount >= 1e8 ? '#dc2626' : p.amount >= 3e7 ? '#ea580c' : '#0891b2';

      html += '<tr class="border-t">' +
        `<td class="p-2 sticky left-0 bg-white border-r z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-medium text-sm">${this.esc(p.name)}</div>` +
          `<div class="text-xs text-slate-500">${p.project_id} / ¥${(p.amount / 1e6).toFixed(1)}M / ${this.esc(p.dept)}</div>` +
          `<div class="text-xs text-slate-700 mt-1">${empNames || '<span class="text-slate-400">配置未登録</span>'}</div>` +
        '</td>' +
        `<td style="position:relative; height:64px; padding:0; width:${totalW}px">` +
          this.gridDivs(cells) +
          `<div class="gantt-bar" style="left:${barLeft + 1}px;width:${barWidth}px;top:20px;background:${color}">${this.esc(p.name.substring(0, 30))}</div>` +
        '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  },

  // ===== 2. 人軸 =====

  renderPersonAxis() {
    const employees = (Sync.cache.employees || []).filter(e => e.category === '監督職' || e.category === '準監督職');
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">データなし</p>';
    const totalW = this.cellsTotalWidth(cells);

    const assignedIds = new Set(assignments.map(a => a.emp_id));
    const sorted = [...employees].sort((a, b) => {
      const ah = assignedIds.has(a.id) ? 0 : 1;
      const bh = assignedIds.has(b.id) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return (a.department || '').localeCompare(b.department || '');
    });

    let html = `<table class="border-collapse" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    sorted.forEach(e => {
      const myAsgs = assignments.filter(a => a.emp_id === e.id);
      const totalAlloc = myAsgs.reduce((s, a) => s + a.allocation, 0);
      const rowH = Math.max(this.ROW_HEIGHT, 16 + myAsgs.length * 26);

      html += '<tr class="border-t">' +
        `<td class="p-2 sticky left-0 bg-white border-r z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-medium text-sm">${this.esc(e.name)}</div>` +
          `<div class="text-xs text-slate-500">${this.esc(e.department || '')} / 配置率 ${Math.round(totalAlloc * 100)}%</div>` +
          `<div class="mt-1">${PoolView.categoryBadge(e.category)}</div>` +
        '</td>' +
        `<td style="position:relative; height:${rowH}px; padding:0; width:${totalW}px">` +
          this.gridDivs(cells);
      myAsgs.forEach((a, idx) => {
        const proj = projects.find(p => p.project_id === a.project_id);
        if (!proj) return;
        const start = this.parseDate(a.join);
        const end = this.parseDate(a.planned_end || proj.end);
        const barLeft = this.dateToPx(start, cells);
        const barRight = this.dateToPx(end, cells);
        const barWidth = Math.max(20, barRight - barLeft - 2);
        const color = a.role === '主任監督' ? '#1e40af' : '#0891b2';
        const top = 6 + idx * 26;
        html += `<div class="gantt-bar" style="left:${barLeft + 1}px;width:${barWidth}px;top:${top}px;background:${color};height:22px">${this.esc(a.project_name.substring(0, 24))} (${Math.round(a.allocation * 100)}%)</div>`;
      });
      html += '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  },

  // ===== 3. 事務所軸（事務所グループ＋配下に個人別棒表示） =====

  renderDepartmentAxis() {
    const employees = (Sync.cache.employees || []).filter(e => e.category === '監督職' || e.category === '準監督職');
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">データなし</p>';
    const totalW = this.cellsTotalWidth(cells);

    const empByDept = {};
    employees.forEach(e => {
      if (!empByDept[e.department]) empByDept[e.department] = [];
      empByDept[e.department].push(e);
    });
    const depts = Object.keys(empByDept).sort();

    let html = `<table class="border-collapse" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    depts.forEach(dept => {
      const emps = empByDept[dept];
      const assignedInDept = emps.filter(e => assignments.some(a => a.emp_id === e.id)).length;

      // 事務所見出し行
      html += '<tr class="bg-slate-800 text-white">' +
        `<td class="p-2 sticky left-0 bg-slate-800 border-r z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-bold text-sm">${this.esc(dept)}</div>` +
          `<div class="text-xs text-slate-300">在籍 ${emps.length}名 / 配置中 ${assignedInDept}名</div>` +
        '</td>' +
        `<td style="height:36px; padding:0; background:#1e293b; width:${totalW}px"></td>` +
      '</tr>';

      // 個人別行（rank削除）
      emps.forEach(e => {
        const myAsgs = assignments.filter(a => a.emp_id === e.id);
        const totalAlloc = myAsgs.reduce((s, a) => s + a.allocation, 0);
        const rowH = Math.max(this.ROW_HEIGHT, 16 + myAsgs.length * 26);

        html += '<tr class="border-t">' +
          `<td class="p-2 sticky left-0 bg-white border-r z-10 pl-6" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
            `<div class="text-sm font-medium">${this.esc(e.name)}</div>` +
            `<div class="text-xs text-slate-500 mt-1">配置率 ${Math.round(totalAlloc * 100)}% ${PoolView.categoryBadge(e.category)}</div>` +
          '</td>' +
          `<td style="position:relative; height:${rowH}px; padding:0; width:${totalW}px">` +
            this.gridDivs(cells);
        myAsgs.forEach((a, idx) => {
          const proj = projects.find(p => p.project_id === a.project_id);
          if (!proj) return;
          const start = this.parseDate(a.join);
          const end = this.parseDate(a.planned_end || proj.end);
          const barLeft = this.dateToPx(start, cells);
          const barRight = this.dateToPx(end, cells);
          const barWidth = Math.max(20, barRight - barLeft - 2);
          const color = a.role === '主任監督' ? '#1e40af' : '#0891b2';
          const top = 6 + idx * 26;
          html += `<div class="gantt-bar" style="left:${barLeft + 1}px;width:${barWidth}px;top:${top}px;background:${color};height:22px">${this.esc(a.project_name.substring(0, 24))} (${Math.round(a.allocation * 100)}%)</div>`;
        });
        html += '</td></tr>';
      });
    });
    html += '</tbody></table>';
    return html;
  },

  // ===== 4. 資格軸（縦=資格グループ＋配下の保有者、横=配置現場バー） =====

  renderQualificationGantt() {
    const employees = (Sync.cache.employees || []).filter(e => e.category !== '対象外');
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const quals = Sync.cache.qualifications || [];
    const eqs = Sync.cache.employee_qualifications || [];

    if (quals.length === 0 || eqs.length === 0) {
      return '<p class="p-4 text-slate-500">資格データがありません</p>';
    }

    const empMap = {};
    employees.forEach(e => empMap[e.id] = e);
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">データなし</p>';
    const totalW = this.cellsTotalWidth(cells);

    let html = `<table class="border-collapse" style="width:max-content">${this.headerHtml(cells)}<tbody>`;

    quals.forEach(q => {
      // この資格の保有者（対象外を除く）
      const holders = eqs
        .filter(eq => eq.qual_id === q.id)
        .map(eq => ({ emp: empMap[eq.emp_id], eq }))
        .filter(x => x.emp);
      if (holders.length === 0) return;

      // 資格見出し行
      html += '<tr class="bg-blue-900 text-white">' +
        `<td class="p-2 sticky left-0 bg-blue-900 border-r z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-bold text-sm">${this.esc(q.name)}</div>` +
          `<div class="text-xs text-blue-200">${this.esc(q.type)} / 保有者 ${holders.length}名</div>` +
        '</td>' +
        `<td style="height:36px; padding:0; background:#1e3a8a; width:${totalW}px"></td>` +
      '</tr>';

      // 保有者の個人行（配置現場バー）
      holders.forEach(({ emp, eq }) => {
        const myAsgs = assignments.filter(a => a.emp_id === emp.id);
        const rowH = Math.max(this.ROW_HEIGHT, 16 + Math.max(1, myAsgs.length) * 26);

        // 期限警告マーク
        let expWarn = '';
        if (eq.expiry) {
          const now = new Date();
          const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
          const exp = new Date(eq.expiry);
          if (exp < now) expWarn = `<span class="bg-red-100 text-red-700 px-1 py-0.5 rounded text-[10px] ml-1">⚠ 期限切れ ${eq.expiry}</span>`;
          else if (exp <= in90) expWarn = `<span class="bg-amber-100 text-amber-700 px-1 py-0.5 rounded text-[10px] ml-1">! 〜${eq.expiry}</span>`;
        }

        html += '<tr class="border-t">' +
          `<td class="p-2 sticky left-0 bg-white border-r z-10 pl-6" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
            `<div class="text-sm font-medium">${this.esc(emp.name)}${expWarn}</div>` +
            `<div class="text-xs text-slate-500 mt-1">${this.esc(emp.department || '')} ${PoolView.categoryBadge(emp.category)}</div>` +
          '</td>' +
          `<td style="position:relative; height:${rowH}px; padding:0; width:${totalW}px">` +
            this.gridDivs(cells);

        myAsgs.forEach((a, idx) => {
          const proj = projects.find(p => p.project_id === a.project_id);
          if (!proj) return;
          const start = this.parseDate(a.join);
          const end = this.parseDate(a.planned_end || proj.end);
          const barLeft = this.dateToPx(start, cells);
          const barRight = this.dateToPx(end, cells);
          const barWidth = Math.max(20, barRight - barLeft - 2);
          const color = a.role === '主任監督' ? '#1e40af' : '#0891b2';
          const top = 6 + idx * 26;
          html += `<div class="gantt-bar" style="left:${barLeft + 1}px;width:${barWidth}px;top:${top}px;background:${color};height:22px">${this.esc(a.project_name.substring(0, 24))} (${Math.round(a.allocation * 100)}%)</div>`;
        });
        if (myAsgs.length === 0) {
          html += '<div style="position:absolute;left:8px;top:14px;color:#94a3b8;font-size:11px">配置なし</div>';
        }
        html += '</td></tr>';
      });
    });
    html += '</tbody></table>';

    html += '<p class="text-xs text-slate-500 p-3 border-t">※ 縦軸は資格別グループ。同一人が複数資格を保有する場合、各資格グループに重複表示されます。期限・有効期間の詳細は「4.資格管理」タブを参照。</p>';
    return html;
  },
};
