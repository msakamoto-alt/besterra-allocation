/**
 * pool.js - 人材プール（3階層表示・社員テーブル）
 */

const PoolView = {
  init() {
    document.getElementById('filter-cat').addEventListener('change', () => this.render());
    document.getElementById('filter-dept').addEventListener('change', () => this.render());
    document.getElementById('filter-name').addEventListener('input', () => this.render());
  },

  refresh() {
    const employees = Sync.cache.employees || [];

    // 3階層カウント
    const cntSup = employees.filter(e => e.category === '監督職').length;
    const cntQuasi = employees.filter(e => e.category === '準監督職').length;
    const cntBroad = employees.filter(e => e.category === '広義監督職').length;
    document.getElementById('cnt-sup').textContent = cntSup;
    document.getElementById('cnt-sup2').textContent = cntSup + cntQuasi;
    document.getElementById('cnt-sup3').textContent = cntSup + cntQuasi + cntBroad;

    // 所属プルダウン更新
    const depts = [...new Set(employees.map(e => e.department).filter(Boolean))].sort();
    const sel = document.getElementById('filter-dept');
    const current = sel.value;
    sel.innerHTML = '<option value="">すべて</option>' +
      depts.map(d => `<option value="${this.escape(d)}">${this.escape(d)}</option>`).join('');
    sel.value = current;

    this.render();
  },

  render() {
    const employees = Sync.cache.employees || [];
    const fCat = document.getElementById('filter-cat').value;
    const fDept = document.getElementById('filter-dept').value;
    const fName = (document.getElementById('filter-name').value || '').toLowerCase();

    const rows = employees.filter(e =>
      (!fCat || e.category === fCat) &&
      (!fDept || e.department === fDept) &&
      (!fName || (e.name || '').toLowerCase().includes(fName))
    );
    document.getElementById('visible-count').textContent = rows.length;

    const tbody = document.getElementById('emp-table-body');
    tbody.innerHTML = rows.map(e => {
      const asgs = (Sync.cache.assignments || []).filter(a => a.emp_id === e.id);
      const asgStr = asgs.length
        ? asgs.map(a => this.escape(a.project_name) + ' (' + Math.round(a.allocation * 100) + '%)').join(', ')
        : '<span class="text-slate-400">なし</span>';
      return '<tr class="border-t hover:bg-slate-50">' +
        '<td class="px-3 py-2 font-mono text-xs">' + e.id + '</td>' +
        '<td class="px-3 py-2 font-medium">' + this.escape(e.name) + '</td>' +
        '<td class="px-3 py-2">' + this.escape(e.department || '') + '</td>' +
        '<td class="px-3 py-2">' + this.escape(e.rank || '') + '</td>' +
        '<td class="px-3 py-2">' + this.escape(e.role || '') + '</td>' +
        '<td class="px-3 py-2">' + this.categoryBadge(e.category) + '</td>' +
        '<td class="px-3 py-2 text-xs">' + asgStr + '</td>' +
        '</tr>';
    }).join('');
  },

  categoryBadge(cat) {
    const klass = { '監督職': 'badge-sup', '準監督職': 'badge-quasi', '広義監督職': 'badge-broad', '対象外': 'badge-out' }[cat] || '';
    return '<span class="' + klass + ' px-2 py-0.5 rounded text-xs">' + this.escape(cat || '') + '</span>';
  },

  escape(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
