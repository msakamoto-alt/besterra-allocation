/**
 * gantt.js - ガントビュー（4軸ボタン切替 + 月→日ドリルダウン）
 *
 * 縦軸：project（現場）/ person（人）/ department（事務所）/ qualification（資格）
 * 横軸：時間（月単位・クリックで該当月を日単位に展開）
 */

const GanttView = {
  currentAxis: 'project',
  expandedMonths: new Set(),  // 'YYYY-M' のキーで展開状態を保持

  MONTH_WIDTH: 60,
  DAY_WIDTH: 22,
  LABEL_WIDTH: 300,
  ROW_HEIGHT: 48,

  AXIS_DESC: {
    project: '各現場の工期と配置されている監督職を時系列で可視化。月ヘッダクリックで該当月を日単位にドリルダウン。',
    person: '各監督職の配置状況を時系列で可視化。1人複数現場の配置も把握可能。月ヘッダクリックで日単位展開。',
    department: '事務所ごとに、所属する監督職を個人別に縦に並べて配置を表示。事務所別キャパが視覚で分かる。',
    qualification: '資格ごとの保有者と期限を可視化。期限切れ予定が直近にある資格は警告表示。',
  },

  init() {
    document.querySelectorAll('.gantt-axis-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentAxis = btn.dataset.axis;
        this.refresh();
      });
    });
    // 月ヘッダクリックでドリルダウン
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
      case 'qualification': container.innerHTML = this.renderQualificationAxis(); break;
    }
  },

  // ===== 共通：セル配列とヘッダ生成 =====

  parseDate(s) { return new Date(s.replace(/\//g, '-')); },

  monthKey(date) { return date.getFullYear() + '-' + (date.getMonth() + 1); },

  // 月単位＋展開月の日セルを混在した cells 配列を生成
  buildCells() {
    const projects = Sync.cache.projects || [];
    const dates = projects.flatMap(p => [p.start, p.end]).filter(Boolean).map(s => this.parseDate(s));
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
        // 日セルに展開
        const daysInMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
        for (let d = 1; d <= daysInMonth; d++) {
          cells.push({
            type: 'day',
            date: new Date(cur.getFullYear(), cur.getMonth(), d),
            width: this.DAY_WIDTH,
            label: d,
            monthKey: key,
            isFirstOfMonth: d === 1,
          });
        }
      } else {
        cells.push({
          type: 'month',
          date: new Date(cur),
          width: this.MONTH_WIDTH,
          label: cur.getFullYear() + '/' + (cur.getMonth() + 1),
          monthKey: key,
        });
      }
      cur.setMonth(cur.getMonth() + 1);
    }
    return cells;
  },

  cellsTotalWidth(cells) {
    return cells.reduce((s, c) => s + c.width, 0);
  },

  cellLeft(cells, idx) {
    let px = 0;
    for (let i = 0; i < idx; i++) px += cells[i].width;
    return px;
  },

  // 日付をpx座標に変換（cellsを走査）
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

  headerHtml(cells) {
    let html = '<thead><tr>' +
      `<th class="p-2 bg-slate-100 sticky left-0 border-r text-left z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">縦軸 / 配置</th>`;
    cells.forEach(c => {
      if (c.type === 'month') {
        html += `<th data-month-key="${c.monthKey}" class="bg-slate-100 border-r px-1 py-2 text-xs cursor-pointer hover:bg-slate-200" style="min-width:${c.width}px;width:${c.width}px" title="クリックで日次展開">${c.label}</th>`;
      } else {
        const monthLabel = c.isFirstOfMonth ? `<div class="text-[10px] text-slate-500">${c.date.getFullYear()}/${c.date.getMonth() + 1}</div>` : '';
        html += `<th data-month-key="${c.monthKey}" class="bg-amber-50 border-r px-0.5 py-1 text-[11px] cursor-pointer hover:bg-amber-100" style="min-width:${c.width}px;width:${c.width}px" title="クリックで月表示に戻す">${monthLabel}${c.label}</th>`;
      }
    });
    html += '</tr></thead>';
    return html;
  },

  // 背景の縦罫線（バー領域）
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

    // 事務所別グループ
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

      // 個人別行
      emps.forEach(e => {
        const myAsgs = assignments.filter(a => a.emp_id === e.id);
        const totalAlloc = myAsgs.reduce((s, a) => s + a.allocation, 0);
        const rowH = Math.max(this.ROW_HEIGHT, 16 + myAsgs.length * 26);

        html += '<tr class="border-t">' +
          `<td class="p-2 sticky left-0 bg-white border-r z-10 pl-6" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
            `<div class="text-sm">${this.esc(e.name)} <span class="text-xs text-slate-500">${this.esc(e.rank || '')}</span></div>` +
            `<div class="text-xs text-slate-500">配置率 ${Math.round(totalAlloc * 100)}% ${PoolView.categoryBadge(e.category)}</div>` +
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

  // ===== 4. 資格軸 =====

  renderQualificationAxis() {
    const quals = Sync.cache.qualifications || [];
    const eqs = Sync.cache.employee_qualifications || [];
    const employees = Sync.cache.employees || [];
    if (quals.length === 0) {
      return `<div class="p-8 text-center text-slate-500">
        <p class="font-medium mb-2">資格データが未登録です</p>
        <p class="text-sm">仕様書 §3.5/§3.6 の qualifications / employee_qualifications シートを Google Sheets に投入してください。</p>
      </div>`;
    }

    const empMap = {};
    employees.forEach(e => empMap[e.id] = e);
    const now = new Date();
    const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    let html = '<table class="border-collapse w-full">' +
      '<thead><tr class="bg-slate-100">' +
        '<th class="p-3 text-left">資格</th>' +
        '<th class="p-3 text-center">区分</th>' +
        '<th class="p-3 text-center">保有者数</th>' +
        '<th class="p-3 text-center">90日以内に期限切れ</th>' +
        '<th class="p-3 text-left">保有者</th>' +
      '</tr></thead><tbody>';

    quals.forEach(q => {
      const holders = eqs.filter(eq => eq.qual_id === q.id);
      const expiringSoon = holders.filter(eq => {
        if (!eq.expiry) return false;
        const exp = new Date(eq.expiry);
        return exp >= now && exp <= in90Days;
      });
      const expired = holders.filter(eq => eq.expiry && new Date(eq.expiry) < now);

      const holderNames = holders.map(eq => {
        const emp = empMap[eq.emp_id];
        if (!emp) return '';
        const isExpiring = eq.expiry && new Date(eq.expiry) >= now && new Date(eq.expiry) <= in90Days;
        const isExpired = eq.expiry && new Date(eq.expiry) < now;
        const cls = isExpired ? 'text-red-600 font-bold' : isExpiring ? 'text-amber-600 font-medium' : '';
        const suffix = isExpired ? `(期限切れ ${eq.expiry})` : isExpiring ? `(〜${eq.expiry})` : '';
        return `<span class="${cls}">${this.esc(emp.name)}${suffix}</span>`;
      }).filter(Boolean).join(' / ');

      const alertCount = expiringSoon.length + expired.length;
      const alertHtml = alertCount > 0
        ? `<span class="bg-amber-100 text-amber-800 px-2 py-1 rounded font-bold">⚠ ${alertCount}名</span>`
        : `<span class="text-slate-400">-</span>`;

      html += '<tr class="border-t hover:bg-slate-50">' +
        `<td class="p-3 font-medium">${this.esc(q.name)}</td>` +
        `<td class="p-3 text-center text-xs text-slate-600">${this.esc(q.type)}</td>` +
        `<td class="p-3 text-center font-bold text-lg">${holders.length}</td>` +
        `<td class="p-3 text-center">${alertHtml}</td>` +
        `<td class="p-3 text-xs">${holderNames || '<span class="text-slate-400">なし</span>'}</td>` +
        '</tr>';
    });
    html += '</tbody></table>' +
      '<p class="text-xs text-slate-500 p-3 border-t">※ Phase 2b で時系列ガント表示を本格実装予定（取得日〜期限を時間軸でバー表示）</p>';
    return html;
  },
};
