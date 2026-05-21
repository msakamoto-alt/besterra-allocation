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
    project: '各現場の工期と配置されている監督職を時系列で可視化。月ヘッダクリックで該当月を日単位にドリルダウン。',
    person: '各監督職の配置状況を時系列で可視化。1人複数現場の配置も把握可能。月ヘッダクリックで日単位展開。',
    department: '事務所ごとに、所属する監督職を個人別に縦に並べて配置を表示。事務所別キャパが視覚で分かる。',
    qualification: '各監督職の保有資格を時系列バーで表示。期限切れは赤、期限間近(90日)はアンバー、有効は資格種別の色。',
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

  // 2行ヘッダ：月行＋日行
  headerHtml(cells) {
    let row1 = `<tr><th rowspan="2" class="p-2 bg-slate-100 sticky left-0 border-r text-left z-20 align-middle" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">縦軸 / 配置</th>`;
    let row2 = '<tr>';

    let i = 0;
    while (i < cells.length) {
      const c = cells[i];
      if (c.type === 'month') {
        row1 += `<th data-month-key="${c.monthKey}" class="bg-slate-100 border-r px-1 py-2 text-xs cursor-pointer hover:bg-slate-200 align-middle" style="min-width:${c.width}px;width:${c.width}px" title="クリックで日次展開">${c.label}</th>`;
        row2 += `<th class="bg-slate-50 border-r" style="min-width:${c.width}px;width:${c.width}px;height:24px"></th>`;
        i++;
      } else {
        // 日セル群（同じmonthKeyが連続する範囲）
        let j = i;
        while (j < cells.length && cells[j].type === 'day' && cells[j].monthKey === c.monthKey) j++;
        const span = j - i;
        const totalW = cells.slice(i, j).reduce((s, x) => s + x.width, 0);
        row1 += `<th colspan="${span}" data-month-key="${c.monthKey}" class="bg-amber-100 border-r border-l px-1 py-2 text-xs font-bold cursor-pointer hover:bg-amber-200 text-amber-900" style="min-width:${totalW}px;width:${totalW}px" title="クリックで月表示に戻す">${c.monthLabel}</th>`;
        for (let k = i; k < j; k++) {
          row2 += `<th class="bg-amber-50 border-r text-[10px] text-amber-800 px-0 py-0.5" style="min-width:${cells[k].width}px;width:${cells[k].width}px">${cells[k].label}</th>`;
        }
        i = j;
      }
    }
    row1 += '</tr>';
    row2 += '</tr>';
    return '<thead>' + row1 + row2 + '</thead>';
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

  // ===== 4. 資格軸（時系列ガント・各監督職の保有資格を有効期間バー表示） =====

  renderQualificationGantt() {
    const employees = Sync.cache.employees || [];
    const quals = Sync.cache.qualifications || [];
    const eqs = Sync.cache.employee_qualifications || [];

    if (quals.length === 0 || eqs.length === 0) {
      return '<p class="p-4 text-slate-500">資格データがありません</p>';
    }

    const qualMap = {};
    quals.forEach(q => qualMap[q.id] = q);
    const empMap = {};
    employees.forEach(e => empMap[e.id] = e);

    // 期限切れ＋取得日も表示範囲に含める
    const extraDates = eqs.flatMap(eq => [eq.acquired, eq.expiry]).filter(Boolean);
    const cells = this.buildCells(extraDates);
    if (cells.length === 0) return '<p class="p-4 text-slate-500">データなし</p>';
    const totalW = this.cellsTotalWidth(cells);
    const rangeStart = cells[0].date;
    const rangeEnd = (() => {
      const last = cells[cells.length - 1];
      return last.type === 'month'
        ? new Date(last.date.getFullYear(), last.date.getMonth() + 1, 0)
        : last.date;
    })();

    // 保有資格者リスト（対象外を除外し、保有資格1つ以上のみ）
    const holderIds = [...new Set(eqs.map(eq => eq.emp_id))];
    const holders = holderIds
      .map(id => empMap[id])
      .filter(e => e && e.category !== '対象外')
      .sort((a, b) => (a.department || '').localeCompare(b.department || ''));

    const now = new Date();
    const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    // 資格種別ごとの色
    const typeColor = {
      '国家資格': '#1e40af',
      '作業主任者': '#ea580c',
      '技能講習': '#059669',
      '特別教育': '#7c3aed',
      '安全衛生': '#0891b2',
    };

    let html = `<table class="border-collapse" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    holders.forEach(e => {
      const myQuals = eqs.filter(eq => eq.emp_id === e.id);
      const rowH = Math.max(this.ROW_HEIGHT, 16 + myQuals.length * 24);

      html += '<tr class="border-t">' +
        `<td class="p-2 sticky left-0 bg-white border-r z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-medium text-sm">${this.esc(e.name)}</div>` +
          `<div class="text-xs text-slate-500">${this.esc(e.department || '')} (保有資格 ${myQuals.length}件)</div>` +
        '</td>' +
        `<td style="position:relative; height:${rowH}px; padding:0; width:${totalW}px">` +
          this.gridDivs(cells);

      myQuals.forEach((eq, idx) => {
        const q = qualMap[eq.qual_id];
        if (!q) return;
        const acquired = this.parseDate(eq.acquired);
        const expiry = eq.expiry ? this.parseDate(eq.expiry) : rangeEnd;

        // 表示範囲にクリップ
        const startD = acquired < rangeStart ? rangeStart : acquired;
        const endD = expiry > rangeEnd ? rangeEnd : expiry;
        if (endD < rangeStart || startD > rangeEnd) return;

        const barLeft = this.dateToPx(startD, cells);
        const barRight = this.dateToPx(endD, cells);
        const barWidth = Math.max(20, barRight - barLeft - 2);

        let color = typeColor[q.type] || '#64748b';
        let extraStyle = '';
        let icon = '';
        if (eq.expiry) {
          if (expiry < now) {
            color = '#dc2626';
            extraStyle = 'border:2px solid #991b1b;';
            icon = '⚠ ';
          } else if (expiry <= in90Days) {
            color = '#f59e0b';
            extraStyle = 'border:2px solid #b45309;';
            icon = '! ';
          }
        }
        const top = 6 + idx * 24;
        const label = icon + q.name + (eq.expiry ? ` (〜${eq.expiry})` : '');
        html += `<div class="gantt-bar" style="left:${barLeft + 1}px;width:${barWidth}px;top:${top}px;background:${color};height:20px;${extraStyle}" title="${this.esc(label)}">${this.esc(q.name.length > 16 ? q.name.substring(0, 15) + '…' : q.name)}</div>`;
      });
      html += '</td></tr>';
    });
    html += '</tbody></table>';

    // 凡例
    html += '<div class="p-3 border-t bg-slate-50 text-xs flex flex-wrap gap-3 items-center">' +
      '<span class="font-semibold text-slate-700">凡例:</span>';
    Object.entries(typeColor).forEach(([k, v]) => {
      html += `<span class="inline-flex items-center gap-1"><span style="display:inline-block;width:14px;height:14px;background:${v};border-radius:3px"></span>${k}</span>`;
    });
    html += '<span class="inline-flex items-center gap-1 ml-4"><span style="display:inline-block;width:14px;height:14px;background:#f59e0b;border:2px solid #b45309;border-radius:3px"></span>期限間近(90日)</span>';
    html += '<span class="inline-flex items-center gap-1"><span style="display:inline-block;width:14px;height:14px;background:#dc2626;border:2px solid #991b1b;border-radius:3px"></span>期限切れ</span>';
    html += '</div>';

    return html;
  },
};
