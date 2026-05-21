/**
 * gantt.js - ガントビュー（4軸ボタン切替）
 *
 * 縦軸：project（現場）/ person（人）/ department（事務所）/ qualification（資格）
 * 横軸：時間（月単位）
 */

const GanttView = {
  currentAxis: 'project',
  CELL_WIDTH: 60,
  LABEL_WIDTH: 300,

  AXIS_DESC: {
    project: '各現場の工期と配置されている監督職を時系列で可視化。バー上の名前は配置監督。',
    person: '各監督職の配置状況を時系列で可視化。1人が複数現場にまたがる配置も把握できる。',
    department: '事務所ごとに、所属する監督職の配置状況を集約表示。事務所別キャパシティの目安。',
    qualification: '資格ごとの保有者と期限を可視化。期限切れ予定が直近にある資格は警告表示。',
  },

  init() {
    document.querySelectorAll('.gantt-axis-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentAxis = btn.dataset.axis;
        this.refresh();
      });
    });
  },

  refresh() {
    // ボタン状態更新
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

  // ===== 共通 =====
  parseDate(s) { return new Date(s.replace(/\//g, '-')); },

  buildMonths() {
    const projects = Sync.cache.projects || [];
    const dates = projects.flatMap(p => [p.start, p.end]).filter(Boolean).map(s => this.parseDate(s));
    if (dates.length === 0) return [];
    let minD = new Date(Math.min(...dates));
    let maxD = new Date(Math.max(...dates));
    minD = new Date(minD.getFullYear(), minD.getMonth(), 1);
    maxD = new Date(maxD.getFullYear(), maxD.getMonth() + 1, 1);
    const months = [];
    let cur = new Date(minD);
    while (cur < maxD) {
      months.push(new Date(cur));
      cur.setMonth(cur.getMonth() + 1);
    }
    return months;
  },

  monthIndex(months, d) {
    return months.findIndex(m => m.getFullYear() === d.getFullYear() && m.getMonth() === d.getMonth());
  },

  headerRow(months) {
    let html = '<thead><tr>' +
      `<th class="p-2 bg-slate-100 sticky left-0 border-r text-left" style="width:${this.LABEL_WIDTH}px">縦軸 / 配置</th>`;
    months.forEach(m => {
      html += `<th class="bg-slate-100 border-r px-1 py-2 text-xs" style="min-width:${this.CELL_WIDTH}px">${m.getFullYear()}/${m.getMonth() + 1}</th>`;
    });
    html += '</tr></thead>';
    return html;
  },

  // ===== 1. 現場軸 =====
  renderProjectAxis() {
    const projects = Sync.cache.projects || [];
    const assignments = Sync.cache.assignments || [];
    const months = this.buildMonths();
    if (months.length === 0) return '<p class="p-4 text-slate-500">データなし</p>';

    let html = '<table class="border-collapse" style="width:max-content">' + this.headerRow(months) + '<tbody>';
    projects.forEach(p => {
      const start = this.parseDate(p.start);
      const end = this.parseDate(p.end);
      const sIdx = this.monthIndex(months, start);
      const eIdx = this.monthIndex(months, end);
      const span = Math.max(1, eIdx - sIdx + 1);
      const barLeft = sIdx * this.CELL_WIDTH + 4;
      const barWidth = span * this.CELL_WIDTH - 8;
      const empNames = assignments.filter(a => a.project_id === p.project_id)
        .map(a => `${a.emp_name}(${Math.round(a.allocation * 100)}%)`).join(' / ');
      const color = p.amount >= 1e8 ? '#dc2626' : p.amount >= 3e7 ? '#ea580c' : '#0891b2';

      html += '<tr class="border-t">' +
        `<td class="p-2 sticky left-0 bg-white border-r" style="width:${this.LABEL_WIDTH}px">` +
          `<div class="font-medium text-sm">${this.esc(p.name)}</div>` +
          `<div class="text-xs text-slate-500">${p.project_id} / ¥${(p.amount / 1e6).toFixed(1)}M / ${this.esc(p.dept)}</div>` +
          `<div class="text-xs text-slate-700 mt-1">${empNames || '<span class="text-slate-400">配置未登録</span>'}</div>` +
        '</td>' +
        `<td colspan="${months.length}" style="position:relative; height:64px">`;
      months.forEach((_, i) => {
        html += `<div style="position:absolute;left:${i * this.CELL_WIDTH}px;width:${this.CELL_WIDTH}px;height:64px;border-right:1px solid #e5e7eb"></div>`;
      });
      html += `<div class="gantt-bar" style="left:${barLeft}px;width:${barWidth}px;top:20px;background:${color}">${this.esc(p.name.substring(0, 24))}</div>` +
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
    const months = this.buildMonths();
    if (months.length === 0) return '<p class="p-4 text-slate-500">データなし</p>';

    // 配置のある人だけを優先表示、配置なしは後ろ
    const assignedIds = new Set(assignments.map(a => a.emp_id));
    const sorted = [...employees].sort((a, b) => {
      const aHas = assignedIds.has(a.id) ? 0 : 1;
      const bHas = assignedIds.has(b.id) ? 0 : 1;
      return aHas - bHas;
    });

    let html = '<table class="border-collapse" style="width:max-content">' + this.headerRow(months) + '<tbody>';
    sorted.forEach(e => {
      const myAsgs = assignments.filter(a => a.emp_id === e.id);
      const totalAlloc = myAsgs.reduce((s, a) => s + a.allocation, 0);
      const allocStr = myAsgs.length ? `${Math.round(totalAlloc * 100)}%` : '0%';

      html += '<tr class="border-t">' +
        `<td class="p-2 sticky left-0 bg-white border-r" style="width:${this.LABEL_WIDTH}px">` +
          `<div class="font-medium text-sm">${this.esc(e.name)}</div>` +
          `<div class="text-xs text-slate-500">${this.esc(e.department || '')} / ${this.esc(e.rank || '-')} / 配置率 ${allocStr}</div>` +
          `<div class="mt-1">${PoolView.categoryBadge(e.category)}</div>` +
        '</td>' +
        `<td colspan="${months.length}" style="position:relative; height:64px">`;
      months.forEach((_, i) => {
        html += `<div style="position:absolute;left:${i * this.CELL_WIDTH}px;width:${this.CELL_WIDTH}px;height:64px;border-right:1px solid #e5e7eb"></div>`;
      });
      // 各アサインメントをバーで表示（複数あれば上下に積む）
      myAsgs.forEach((a, idx) => {
        const proj = projects.find(p => p.project_id === a.project_id);
        if (!proj) return;
        const start = this.parseDate(a.join);
        const end = this.parseDate(a.planned_end || proj.end);
        const sIdx = this.monthIndex(months, start);
        const eIdx = this.monthIndex(months, end);
        const span = Math.max(1, eIdx - sIdx + 1);
        const barLeft = sIdx * this.CELL_WIDTH + 4;
        const barWidth = span * this.CELL_WIDTH - 8;
        const color = a.role === '主任監督' ? '#1e40af' : '#0891b2';
        const top = 6 + idx * 28;
        html += `<div class="gantt-bar" style="left:${barLeft}px;width:${barWidth}px;top:${top}px;background:${color};height:22px">${this.esc(a.project_name.substring(0, 18))}</div>`;
      });
      html += '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  },

  // ===== 3. 事務所軸 =====
  renderDepartmentAxis() {
    const employees = Sync.cache.employees || [];
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const months = this.buildMonths();
    if (months.length === 0) return '<p class="p-4 text-slate-500">データなし</p>';

    // 事務所別の監督職（監督職＋準監督職）集約
    const empByDept = {};
    employees.filter(e => e.category === '監督職' || e.category === '準監督職').forEach(e => {
      if (!empByDept[e.department]) empByDept[e.department] = [];
      empByDept[e.department].push(e);
    });
    const depts = Object.keys(empByDept).sort();

    let html = '<table class="border-collapse" style="width:max-content">' + this.headerRow(months) + '<tbody>';
    depts.forEach(dept => {
      const emps = empByDept[dept];
      const empIds = new Set(emps.map(e => e.id));
      const deptAsgs = assignments.filter(a => empIds.has(a.emp_id));

      // 月別稼働人数（重複配置は1名カウント）
      const monthlyOccupied = months.map(m => {
        const occupied = new Set();
        deptAsgs.forEach(a => {
          const proj = projects.find(p => p.project_id === a.project_id);
          if (!proj) return;
          const start = this.parseDate(a.join);
          const end = this.parseDate(a.planned_end || proj.end);
          if (start <= new Date(m.getFullYear(), m.getMonth() + 1, 0) && end >= m) {
            occupied.add(a.emp_id);
          }
        });
        return occupied.size;
      });

      html += '<tr class="border-t">' +
        `<td class="p-2 sticky left-0 bg-white border-r" style="width:${this.LABEL_WIDTH}px">` +
          `<div class="font-medium text-sm">${this.esc(dept)}</div>` +
          `<div class="text-xs text-slate-500">在籍 ${emps.length}名・稼働中 ${new Set(deptAsgs.map(a => a.emp_id)).size}名</div>` +
        '</td>' +
        `<td colspan="${months.length}" style="position:relative; height:48px">`;
      months.forEach((_, i) => {
        const occ = monthlyOccupied[i];
        const ratio = emps.length ? occ / emps.length : 0;
        // 色濃度で表現
        const bg = ratio === 0 ? '#f1f5f9' : ratio < 0.5 ? '#bfdbfe' : ratio < 0.8 ? '#60a5fa' : ratio < 1 ? '#2563eb' : '#1e3a8a';
        const textColor = ratio >= 0.5 ? 'white' : '#1e293b';
        html += `<div style="position:absolute;left:${i * this.CELL_WIDTH}px;width:${this.CELL_WIDTH}px;height:48px;border-right:1px solid #e5e7eb;background:${bg};display:flex;align-items:center;justify-content:center;color:${textColor};font-size:12px;font-weight:600">${occ}/${emps.length}</div>`;
      });
      html += '</td></tr>';
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

  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
