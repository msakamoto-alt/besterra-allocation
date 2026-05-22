/**
 * dashboard.js - 監督ダッシュボード（個人ビュー）
 */

const DashboardView = {
  init() {
    document.getElementById('dash-select').addEventListener('change', () => this.render());

    // 「現在の配置」行クリックでガント詳細モーダルを開く（編集UI共通化）
    document.getElementById('dash-content').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-asg-id]');
      if (!tr) return;
      const asgId = tr.dataset.asgId;
      if (typeof GanttView !== 'undefined' && typeof GanttView.showAssignmentModal === 'function') {
        GanttView.showAssignmentModal(asgId);
      }
    });
  },

  // 配置編集後に呼ばれる：選択中の監督の現在配置を再描画
  refreshCurrentEmployee() {
    this.render();
  },

  refresh() {
    const employees = (Sync.cache.employees || []).filter(e => e.category === '現場監督' || e.category === '準現場監督');
    const sel = document.getElementById('dash-select');
    const current = sel.value;
    sel.innerHTML = employees.map(e =>
      `<option value="${e.id}">${this.esc(e.name)} (${this.esc(e.department || '-')} / ${this.esc(e.category)})</option>`
    ).join('');
    if (current && employees.some(e => String(e.id) === current)) sel.value = current;
    this.render();
  },

  render() {
    const sel = document.getElementById('dash-select');
    const empId = parseInt(sel.value);
    if (!empId) {
      document.getElementById('dash-content').innerHTML = '<p class="text-slate-500">監督を選択してください</p>';
      return;
    }
    const emp = (Sync.cache.employees || []).find(e => e.id === empId);
    if (!emp) return;
    // 現在進行形の配置のみ（完成・未開始は除外）
    const asgs = (Sync.cache.assignments || []).filter(a =>
      a.emp_id === empId && !a.completed && Sync.isActiveAssignment(a)
    );

    // G工番モック（仕様書 §3.7 g_work_logs 投入前のデモ）
    const gMockCats = { '資料作成・事務': 18, '安全衛生・KY': 6, '視察・調査': 4, '会議・打合せ': 2, '教育・研修': 3 };
    const gTotal = Object.values(gMockCats).reduce((s, v) => s + v, 0);

    // 保有資格
    const myQuals = (Sync.cache.employee_qualifications || []).filter(eq => eq.emp_id === empId);
    const qualMap = {};
    (Sync.cache.qualifications || []).forEach(q => qualMap[q.id] = q);
    const now = new Date();
    const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const canEdit = !!(Sync.OVERRIDE_API_URL && Sync.OVERRIDE_TOKEN);
    let asgTbl = '';
    if (asgs.length === 0) {
      asgTbl = '<p class="text-slate-400 text-sm">配置なし</p>';
    } else {
      asgTbl = '<table class="w-full text-sm"><thead class="bg-slate-50"><tr>' +
        '<th class="p-2 text-left">現場</th><th class="p-2">役割</th><th class="p-2">開始</th><th class="p-2">予定終了</th>' +
        (canEdit ? '<th class="p-2 w-20"></th>' : '') +
        '</tr></thead><tbody>';
      asgs.forEach(a => {
        const overrideMark = a.overridden
          ? '<span class="ml-2 bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded text-[10px]">✎ 変更済み</span>'
          : '';
        const editLink = canEdit
          ? '<td class="p-2 text-center"><span class="text-blue-600 text-xs underline">期間を変更</span></td>'
          : '';
        const rowClass = canEdit
          ? 'border-t hover:bg-blue-50 cursor-pointer'
          : 'border-t';
        const titleAttr = canEdit ? ' title="クリックして配属期間を変更"' : '';
        asgTbl += `<tr class="${rowClass}" data-asg-id="${this.esc(a.assignment_id)}"${titleAttr}>` +
          `<td class="p-2">${this.esc(a.project_name)}${overrideMark}</td>` +
          `<td class="p-2 text-center">${this.esc(a.role)}</td>` +
          `<td class="p-2 text-center text-xs">${this.fmtDate(a.join)}</td>` +
          `<td class="p-2 text-center text-xs">${this.fmtDate(a.planned_end)}</td>` +
          editLink +
          '</tr>';
      });
      asgTbl += '</tbody></table>';
    }

    let gHtml = '';
    Object.entries(gMockCats).forEach(([k, v]) => {
      gHtml += '<div class="border rounded p-2 text-center">' +
        `<div class="text-xs text-slate-600">${this.esc(k)}</div>` +
        `<div class="text-lg font-bold">${v}h</div>` +
        `<div class="h-2 bg-slate-200 rounded mt-1"><div class="h-2 bg-blue-500 rounded" style="width:${(v / gTotal * 100)}%"></div></div>` +
        '</div>';
    });

    let qualHtml = '';
    if (myQuals.length === 0) {
      qualHtml = '<p class="text-slate-400 text-sm">保有資格データなし</p>';
    } else {
      qualHtml = '<div class="flex flex-wrap gap-2">';
      myQuals.forEach(eq => {
        const q = qualMap[eq.qual_id];
        if (!q) return;
        let badge = 'bg-emerald-100 text-emerald-800';
        let suffix = '';
        if (eq.expiry) {
          const exp = new Date(eq.expiry);
          if (exp < now) { badge = 'bg-red-100 text-red-800 font-bold'; suffix = ` (期限切れ ${eq.expiry})`; }
          else if (exp <= in90Days) { badge = 'bg-amber-100 text-amber-800 font-medium'; suffix = ` (〜${eq.expiry})`; }
        }
        qualHtml += `<span class="${badge} px-2 py-1 rounded text-xs">${this.esc(q.name)}${suffix}</span>`;
      });
      qualHtml += '</div>';
    }

    document.getElementById('dash-content').innerHTML =
      '<div class="grid grid-cols-2 gap-4 mb-4">' +
        '<div class="bg-white rounded-lg shadow p-4">' +
          '<div class="text-sm text-slate-600">監督名</div>' +
          `<div class="text-xl font-bold mt-1">${this.esc(emp.name)}</div>` +
          `<div class="text-xs text-slate-500 mt-1">${this.esc(emp.department || '-')} / ${this.esc(emp.role || '一般')}</div>` +
          `<div class="mt-2">${PoolView.categoryBadge(emp.category)}</div>` +
        '</div>' +
        '<div class="bg-white rounded-lg shadow p-4">' +
          '<div class="text-sm text-slate-600">配置現場数</div>' +
          `<div class="text-3xl font-bold mt-1">${asgs.length}</div>` +
          '<div class="text-xs text-slate-500 mt-1">アクティブな配置</div>' +
        '</div>' +
      '</div>' +
      '<div class="bg-white rounded-lg shadow p-4 mb-4">' +
        '<h3 class="font-bold mb-3">現在の配置</h3>' + asgTbl +
      '</div>' +
      '<div class="bg-white rounded-lg shadow p-4 mb-4">' +
        '<h3 class="font-bold mb-3">保有資格</h3>' + qualHtml +
      '</div>' +
      '<div class="bg-white rounded-lg shadow p-4">' +
        '<h3 class="font-bold mb-3">今月のG工番カテゴリ内訳（モック・参考可視化）</h3>' +
        `<div class="grid grid-cols-5 gap-2">${gHtml}</div>` +
        '<p class="text-xs text-slate-500 mt-3">※ 配置自動化のロジックには使用しません（仕様書v4.0方針）。可視化のみ。</p>' +
      '</div>';
  },

  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // 表記統一：'2025-07-31' / '2025/07/31' どちらも 'YYYY/MM/DD' で表示
  fmtDate(s) {
    if (!s) return '-';
    return this.esc(String(s).replace(/-/g, '/'));
  },
};
