/**
 * gantt.js - 現場人員配置（4軸ガント＋月→日ドリルダウン＋期間フィルタ＋今日マーカー）
 *
 * 全軸共通：
 * - バー色は役割（主任監督=濃青/副監督=シアン/支援=スレート/視察=ブラウン）
 * - バー内テキストに配置率(%)は表示しない
 * - 表示期間は displayStart 〜 displayEnd で制御
 * - 今日の縦赤線マーカー
 */

const GanttView = {
  currentAxis: 'project',
  expandedMonths: new Set(),

  // 表示期間（初期化時に設定）
  displayStart: null,
  displayEnd: null,

  // 完成工事の表示トグル（デフォルト：非表示）
  showCompleted: false,
  // 見込み案件の表示トグル（デフォルト：非表示）
  showProspects: false,

  MONTH_WIDTH: 70,
  DAY_WIDTH: 26,
  LABEL_WIDTH: 300,
  BAR_HEIGHT: 22,
  BAR_GAP: 4,

  // 役割→色（全軸共通）
  ROLE_COLOR: {
    '主任技術者': '#1e40af',
    '副監督': '#0891b2',
    '支援': '#64748b',
    '視察': '#a16207',
  },

  AXIS_DESC: {
    project: '縦軸＝現場、横軸＝配置期間（join〜leave）。配置監督ごとに個別バー表示。色は役割。',
    person: '縦軸＝現場監督（準現場監督含む）、横軸＝配置現場の期間。色は配置現場での役割。複数現場の配置はバー縦積み。',
    department: '縦軸＝事務所配下の個人、横軸＝配置現場の期間。色は役割。事務所別キャパが個人別に分かる。',
    qualification: '縦軸＝資格別の保有者、横軸＝配置現場の期間。色は役割。同一人複数資格は各グループに繰り返し表示。',
  },

  init() {
    // デフォルト期間：今年1月〜2年後の12月
    const now = new Date();
    this.displayStart = new Date(2026, 0, 1);  // 2026/1
    this.displayEnd = new Date(now.getFullYear() + 2, 11, 31);

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

    // 期間フィルタ
    const startInput = document.getElementById('gantt-start');
    const endInput = document.getElementById('gantt-end');
    startInput.value = this.formatMonth(this.displayStart);
    endInput.value = this.formatMonth(this.displayEnd);
    startInput.addEventListener('change', () => {
      if (startInput.value) {
        const [y, m] = startInput.value.split('-').map(Number);
        this.displayStart = new Date(y, m - 1, 1);
        this.refresh();
      }
    });
    endInput.addEventListener('change', () => {
      if (endInput.value) {
        const [y, m] = endInput.value.split('-').map(Number);
        this.displayEnd = new Date(y, m, 0);
        this.refresh();
      }
    });

    // 今日ボタン
    document.getElementById('gantt-today').addEventListener('click', () => {
      this.scrollToToday();
    });

    // 期間リセット
    document.getElementById('gantt-reset').addEventListener('click', () => {
      this.displayStart = new Date(2026, 0, 1);
      this.displayEnd = new Date(new Date().getFullYear() + 2, 11, 31);
      this.expandedMonths.clear();
      startInput.value = this.formatMonth(this.displayStart);
      endInput.value = this.formatMonth(this.displayEnd);
      this.refresh();
    });

    // 完成工事トグル
    const showCompletedCb = document.getElementById('gantt-show-completed');
    if (showCompletedCb) {
      showCompletedCb.checked = this.showCompleted;
      showCompletedCb.addEventListener('change', () => {
        this.showCompleted = showCompletedCb.checked;
        this.refresh();
      });
    }

    // 見込み案件トグル
    const showProspectsCb = document.getElementById('gantt-show-prospects');
    if (showProspectsCb) {
      showProspectsCb.checked = this.showProspects;
      showProspectsCb.addEventListener('change', () => {
        this.showProspects = showProspectsCb.checked;
        this.refresh();
      });
    }

    // 今日ラベル
    const today = new Date();
    document.getElementById('gantt-today-label').textContent =
      `今日: ${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;
  },

  formatMonth(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },

  refresh() {
    document.querySelectorAll('.gantt-axis-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.axis === this.currentAxis);
    });
    const descEl = document.getElementById('gantt-description');
    if (descEl) descEl.textContent = this.AXIS_DESC[this.currentAxis] || '';

    const container = document.getElementById('gantt-container');
    if (!container) return;
    try {
      switch (this.currentAxis) {
        case 'project': container.innerHTML = this.renderProjectAxis(); break;
        case 'person': container.innerHTML = this.renderPersonAxis(); break;
        case 'department': container.innerHTML = this.renderDepartmentAxis(); break;
        case 'qualification': container.innerHTML = this.renderQualificationGantt(); break;
      }
    } catch (e) {
      console.error('Gantt render失敗 (' + this.currentAxis + '):', e);
      container.innerHTML = '<div class="p-4 text-red-600">ガント描画でエラーが発生しました。F12 → Console タブのエラー詳細を共有してください。<br><span class="text-xs text-slate-500">' + (e.message || e) + '</span></div>';
    }
  },

  scrollToToday() {
    const cells = this.buildCells();
    if (cells.length === 0) return;
    const today = new Date();
    const px = this.dateToPx(today, cells);
    const container = document.getElementById('gantt-container');
    // スクロール位置：今日が画面中央付近に来るように
    const scrollX = Math.max(0, this.LABEL_WIDTH + px - container.clientWidth / 2);
    container.scrollTo({ left: scrollX, behavior: 'smooth' });
  },

  // ===== セル生成（期間フィルタ反映） =====

  parseDate(s) {
    if (s instanceof Date) return s;
    return new Date(String(s).replace(/\//g, '-'));
  },

  monthKey(date) { return date.getFullYear() + '-' + (date.getMonth() + 1); },

  buildCells() {
    const minD = new Date(this.displayStart.getFullYear(), this.displayStart.getMonth(), 1);
    const maxD = new Date(this.displayEnd.getFullYear(), this.displayEnd.getMonth() + 1, 1);
    if (maxD <= minD) return [];

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

  // 期間にバー範囲をクリップ（表示範囲外なら null）
  clipRange(start, end, cells) {
    if (cells.length === 0) return null;
    const rangeStart = cells[0].date;
    const last = cells[cells.length - 1];
    const rangeEnd = last.type === 'month'
      ? new Date(last.date.getFullYear(), last.date.getMonth() + 1, 1)
      : new Date(last.date.getFullYear(), last.date.getMonth(), last.date.getDate() + 1);
    if (end < rangeStart || start > rangeEnd) return null;
    return {
      start: start < rangeStart ? rangeStart : start,
      end: end > rangeEnd ? rangeEnd : end,
      truncStart: start < rangeStart,
      truncEnd: end > rangeEnd,
    };
  },

  headerHtml(cells) {
    let row1 = `<tr><th rowspan="2" class="p-2 bg-slate-200 sticky left-0 border-r text-left z-20 align-middle" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px;height:60px">縦軸 / 配置</th>`;
    let row2 = '<tr>';

    let i = 0;
    while (i < cells.length) {
      const c = cells[i];
      if (c.type === 'month') {
        row1 += `<th data-month-key="${c.monthKey}" class="bg-slate-100 border-r px-1 py-1 text-xs cursor-pointer hover:bg-slate-200 align-middle whitespace-nowrap" style="min-width:${c.width}px;width:${c.width}px;height:36px" title="クリックで日次展開">${c.label} <span class="text-slate-400">⌄</span></th>`;
        row2 += `<th class="bg-slate-50 border-r" style="min-width:${c.width}px;width:${c.width}px;height:24px;border-bottom:2px solid #cbd5e1"></th>`;
        i++;
      } else {
        let j = i;
        while (j < cells.length && cells[j].type === 'day' && cells[j].monthKey === c.monthKey) j++;
        const span = j - i;
        const totalW = cells.slice(i, j).reduce((s, x) => s + x.width, 0);
        row1 += `<th colspan="${span}" data-month-key="${c.monthKey}" class="bg-amber-200 border-r border-l px-1 py-1 text-xs font-bold cursor-pointer hover:bg-amber-300 text-amber-900 whitespace-nowrap" style="min-width:${totalW}px;width:${totalW}px;height:36px" title="クリックで月表示に戻す">${c.monthLabel} <span class="text-amber-700">⌃</span></th>`;
        for (let k = i; k < j; k++) {
          row2 += `<th class="bg-amber-50 border-r text-[11px] text-amber-900 font-semibold whitespace-nowrap" style="min-width:${cells[k].width}px;width:${cells[k].width}px;height:24px;padding:2px 0">${cells[k].label}</th>`;
        }
        i = j;
      }
    }
    row1 += '</tr>';
    row2 += '</tr>';
    return '<thead>' + row1 + row2 + '</thead>';
  },

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

  // 今日マーカー（縦赤線）
  todayMarker(cells) {
    const today = new Date();
    const clip = this.clipRange(today, today, cells);
    if (!clip) return '';
    const px = this.dateToPx(today, cells);
    return `<div class="gantt-today-line" style="position:absolute;left:${px}px;top:0;bottom:0;width:2px;background:#ef4444;z-index:2;pointer-events:none"><div style="position:absolute;top:-4px;left:-4px;width:10px;height:10px;background:#ef4444;border-radius:50%"></div></div>`;
  },

  // バー描画（左切れ・右切れの矢印付き・prospect は点線枠で区別）
  renderBar(start, end, cells, color, label, top, title, prospect = false) {
    const clip = this.clipRange(start, end, cells);
    if (!clip) return '';
    const left = this.dateToPx(clip.start, cells);
    const right = this.dateToPx(clip.end, cells);
    const width = Math.max(16, right - left - 2);
    const truncLeft = clip.truncStart ? 'border-left:2px dashed #fff;' : '';
    const truncRight = clip.truncEnd ? 'border-right:2px dashed #fff;' : '';
    const prospectStyle = prospect ? 'opacity:0.6;border:2px dashed #fff;outline:1px solid ' + color + ';' : '';
    const prospectIcon = prospect ? '⊘ ' : '';
    return `<div class="gantt-bar" style="left:${left + 1}px;width:${width}px;top:${top}px;background:${color};height:${this.BAR_HEIGHT}px;${truncLeft}${truncRight}${prospectStyle}" title="${this.esc(title || '')}">${prospectIcon}${this.esc(label || '')}</div>`;
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
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    // 表示範囲フィルタ・完成/見込みトグル
    const visibleProjects = projects.filter(p => {
      if (p.completed && !this.showCompleted) return false;
      if (p.prospect && !this.showProspects) return false;
      const s = this.parseDate(p.start);
      const e = this.parseDate(p.end);
      return this.clipRange(s, e, cells);
    });

    let html = `<table class="border-collapse gantt-table" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    visibleProjects.forEach(p => {
      const projAsgs = assignments.filter(a => a.project_id === p.project_id);
      const rowH = Math.max(64, 16 + Math.max(1, projAsgs.length) * (this.BAR_HEIGHT + this.BAR_GAP));

      const labelMembers = projAsgs.map(a =>
        `<span class="inline-block mr-2 font-medium">${this.esc(a.emp_name)}</span>`
      ).join('');

      html += '<tr class="border-t">' +
        `<td class="p-2 sticky left-0 bg-white border-r z-10 align-top" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-medium text-sm">${this.esc(p.name)}</div>` +
          `<div class="text-xs text-slate-500">${this.esc(p.project_id)} / ¥${(p.amount / 1e6).toFixed(1)}M / ${this.esc(p.dept)}</div>` +
          `<div class="text-xs mt-1">${labelMembers || '<span class="text-slate-400">配置未登録</span>'}</div>` +
        '</td>' +
        `<td colspan="${colCount}" style="position:relative; height:${rowH}px; padding:0">` +
          this.gridDivs(cells) +
          todayMarkerHtml;

      if (projAsgs.length === 0) {
        const start = this.parseDate(p.start);
        const end = this.parseDate(p.end);
        html += this.renderBar(start, end, cells, '#cbd5e1', '配置未登録', 8, `${p.name}（${p.start}〜${p.end}）配置未登録`);
      } else {
        projAsgs.forEach((a, idx) => {
          const start = this.parseDate(a.join);
          const end = this.parseDate(a.planned_end || p.end);
          const color = this.ROLE_COLOR[a.role] || '#64748b';
          const top = 8 + idx * (this.BAR_HEIGHT + this.BAR_GAP);
          html += this.renderBar(start, end, cells, color, a.emp_name, top, `${a.emp_name}（${a.role}） ${a.join}〜${a.planned_end || p.end}${a.prospect ? '【見込み】' : ''}`, a.prospect);
        });
      }
      html += '</td></tr>';
    });
    html += '</tbody></table>';

    html += this.legendRole();
    return html;
  },

  // ===== 2. 人軸 =====

  renderPersonAxis() {
    const employees = (Sync.cache.employees || []).filter(e => e.category === '現場監督' || e.category === '準現場監督');
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    const assignedIds = new Set(assignments.map(a => a.emp_id));
    const sorted = [...employees].sort((a, b) => {
      const ah = assignedIds.has(a.id) ? 0 : 1;
      const bh = assignedIds.has(b.id) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return (a.department || '').localeCompare(b.department || '');
    });

    let html = `<table class="border-collapse gantt-table" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    sorted.forEach(e => {
      const myAsgs = assignments.filter(a => a.emp_id === e.id && (this.showCompleted || !a.completed) && (this.showProspects || !a.prospect));
      const rowH = Math.max(48, 16 + Math.max(1, myAsgs.length) * (this.BAR_HEIGHT + this.BAR_GAP));

      html += '<tr class="border-t">' +
        `<td class="p-2 sticky left-0 bg-white border-r z-10 align-top" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-medium text-sm">${this.esc(e.name)}</div>` +
          `<div class="text-xs text-slate-500">${this.esc(e.department || '')}</div>` +
          `<div class="mt-1">${PoolView.categoryBadge(e.category)}</div>` +
        '</td>' +
        `<td colspan="${colCount}" style="position:relative; height:${rowH}px; padding:0">` +
          this.gridDivs(cells) +
          todayMarkerHtml;

      myAsgs.forEach((a, idx) => {
        const proj = projects.find(p => p.project_id === a.project_id);
        if (!proj) return;
        const start = this.parseDate(a.join);
        const end = this.parseDate(a.planned_end || proj.end);
        const color = this.ROLE_COLOR[a.role] || '#64748b';
        const top = 8 + idx * (this.BAR_HEIGHT + this.BAR_GAP);
        html += this.renderBar(start, end, cells, color, a.project_name, top, `${a.project_name}（${a.role}） ${a.join}〜${a.planned_end || proj.end}${a.prospect ? '【見込み】' : ''}`, a.prospect);
      });
      html += '</td></tr>';
    });
    html += '</tbody></table>';

    html += this.legendRole();
    return html;
  },

  // ===== 3. 事務所軸 =====

  renderDepartmentAxis() {
    const employees = (Sync.cache.employees || []).filter(e => e.category === '現場監督' || e.category === '準現場監督');
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    const empByDept = {};
    employees.forEach(e => {
      if (!empByDept[e.department]) empByDept[e.department] = [];
      empByDept[e.department].push(e);
    });
    const depts = Object.keys(empByDept).sort();

    let html = `<table class="border-collapse gantt-table" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    depts.forEach(dept => {
      const emps = empByDept[dept];
      const assignedInDept = emps.filter(e => assignments.some(a => a.emp_id === e.id && (this.showCompleted || !a.completed) && (this.showProspects || !a.prospect))).length;

      html += '<tr class="bg-slate-800 text-white">' +
        `<td class="p-2 sticky left-0 bg-slate-800 border-r z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-bold text-sm">${this.esc(dept)}</div>` +
          `<div class="text-xs text-slate-300">在籍 ${emps.length}名 / 配置中 ${assignedInDept}名</div>` +
        '</td>' +
        `<td colspan="${colCount}" style="height:36px; padding:0; background:#1e293b"></td>` +
      '</tr>';

      emps.forEach(e => {
        const myAsgs = assignments.filter(a => a.emp_id === e.id && (this.showCompleted || !a.completed) && (this.showProspects || !a.prospect));
        const rowH = Math.max(48, 16 + Math.max(1, myAsgs.length) * (this.BAR_HEIGHT + this.BAR_GAP));

        html += '<tr class="border-t">' +
          `<td class="p-2 sticky left-0 bg-white border-r z-10 pl-6 align-top" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
            `<div class="text-sm font-medium">${this.esc(e.name)}</div>` +
            `<div class="text-xs text-slate-500 mt-1">${PoolView.categoryBadge(e.category)}</div>` +
          '</td>' +
          `<td colspan="${colCount}" style="position:relative; height:${rowH}px; padding:0">` +
            this.gridDivs(cells) +
            todayMarkerHtml;
        myAsgs.forEach((a, idx) => {
          const proj = projects.find(p => p.project_id === a.project_id);
          if (!proj) return;
          const start = this.parseDate(a.join);
          const end = this.parseDate(a.planned_end || proj.end);
          const color = this.ROLE_COLOR[a.role] || '#64748b';
          const top = 8 + idx * (this.BAR_HEIGHT + this.BAR_GAP);
          html += this.renderBar(start, end, cells, color, a.project_name, top, `${a.project_name}（${a.role}） ${a.join}〜${a.planned_end || proj.end}${a.prospect ? '【見込み】' : ''}`, a.prospect);
        });
        html += '</td></tr>';
      });
    });
    html += '</tbody></table>';

    html += this.legendRole();
    return html;
  },

  // ===== 4. 資格軸 =====

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
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    let html = `<table class="border-collapse gantt-table" style="width:max-content">${this.headerHtml(cells)}<tbody>`;

    quals.forEach(q => {
      const holders = eqs
        .filter(eq => eq.qual_id === q.id)
        .map(eq => ({ emp: empMap[eq.emp_id], eq }))
        .filter(x => x.emp);
      if (holders.length === 0) return;

      html += '<tr class="bg-blue-900 text-white">' +
        `<td class="p-2 sticky left-0 bg-blue-900 border-r z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-bold text-sm">${this.esc(q.name)}</div>` +
          `<div class="text-xs text-blue-200">${this.esc(q.type)} / 保有者 ${holders.length}名</div>` +
        '</td>' +
        `<td colspan="${colCount}" style="height:36px; padding:0; background:#1e3a8a"></td>` +
      '</tr>';

      holders.forEach(({ emp, eq }) => {
        const myAsgs = assignments.filter(a => a.emp_id === emp.id && (this.showCompleted || !a.completed) && (this.showProspects || !a.prospect));
        const rowH = Math.max(48, 16 + Math.max(1, myAsgs.length) * (this.BAR_HEIGHT + this.BAR_GAP));

        let expWarn = '';
        if (eq.expiry) {
          const now = new Date();
          const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
          const exp = new Date(eq.expiry);
          if (exp < now) expWarn = `<span class="bg-red-100 text-red-700 px-1 py-0.5 rounded text-[10px] ml-1">⚠ 期限切れ ${eq.expiry}</span>`;
          else if (exp <= in90) expWarn = `<span class="bg-amber-100 text-amber-700 px-1 py-0.5 rounded text-[10px] ml-1">! 〜${eq.expiry}</span>`;
        }

        html += '<tr class="border-t">' +
          `<td class="p-2 sticky left-0 bg-white border-r z-10 pl-6 align-top" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
            `<div class="text-sm font-medium">${this.esc(emp.name)}${expWarn}</div>` +
            `<div class="text-xs text-slate-500 mt-1">${this.esc(emp.department || '')} ${PoolView.categoryBadge(emp.category)}</div>` +
          '</td>' +
          `<td colspan="${colCount}" style="position:relative; height:${rowH}px; padding:0">` +
            this.gridDivs(cells) +
            todayMarkerHtml;

        myAsgs.forEach((a, idx) => {
          const proj = projects.find(p => p.project_id === a.project_id);
          if (!proj) return;
          const start = this.parseDate(a.join);
          const end = this.parseDate(a.planned_end || proj.end);
          const color = this.ROLE_COLOR[a.role] || '#64748b';
          const top = 8 + idx * (this.BAR_HEIGHT + this.BAR_GAP);
          html += this.renderBar(start, end, cells, color, a.project_name, top, `${a.project_name}（${a.role}） ${a.join}〜${a.planned_end || proj.end}${a.prospect ? '【見込み】' : ''}`, a.prospect);
        });
        if (myAsgs.length === 0) {
          html += '<div style="position:absolute;left:8px;top:14px;color:#94a3b8;font-size:11px">配置なし</div>';
        }
        html += '</td></tr>';
      });
    });
    html += '</tbody></table>';

    html += this.legendRole();
    html += '<p class="text-xs text-slate-500 p-3 border-t">※ 縦軸は資格別グループ。同一人が複数資格を保有する場合、各資格グループに重複表示されます。期限詳細は「4.資格管理」タブを参照。</p>';
    return html;
  },

  legendRole() {
    let html = '<div class="p-3 border-t bg-slate-50 text-xs flex flex-wrap gap-3 items-center">' +
      '<span class="font-semibold text-slate-700">色＝役割:</span>';
    Object.entries(this.ROLE_COLOR).forEach(([k, v]) => {
      html += `<span class="inline-flex items-center gap-1"><span style="display:inline-block;width:14px;height:14px;background:${v};border-radius:3px"></span>${this.esc(k)}</span>`;
    });
    html += '<span class="inline-flex items-center gap-1 ml-3"><span style="display:inline-block;width:14px;height:14px;background:#cbd5e1;border-radius:3px"></span>配置未登録</span>';
    html += '<span class="inline-flex items-center gap-1 ml-3"><span style="display:inline-block;width:2px;height:14px;background:#ef4444"></span>今日</span>';
    html += '</div>';
    return html;
  },
};
