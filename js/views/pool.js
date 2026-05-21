/**
 * pool.js - 人材プール（3階層表示・社員テーブル）
 * 区分「対象外」は表示しない方針
 */

const PoolView = {
  init() {
    document.getElementById('filter-cat').addEventListener('change', () => this.render());
    document.getElementById('filter-dept').addEventListener('change', () => this.render());
    document.getElementById('filter-name').addEventListener('input', () => this.render());
  },

  // 対象外を除いた表示対象社員
  visibleEmployees() {
    return (Sync.cache.employees || []).filter(e => e.category !== '対象外');
  },

  refresh() {
    const employees = this.visibleEmployees();

    // 3階層カウント
    const cntSup = employees.filter(e => e.category === '監督職').length;
    const cntQuasi = employees.filter(e => e.category === '準監督職').length;
    const cntBroad = employees.filter(e => e.category === '広義監督職').length;
    document.getElementById('cnt-sup').textContent = cntSup;
    document.getElementById('cnt-sup2').textContent = cntSup + cntQuasi;
    document.getElementById('cnt-sup3').textContent = cntSup + cntQuasi + cntBroad;

    // 所属プルダウン更新（対象外社員所属を除外）
    const depts = [...new Set(employees.map(e => e.department).filter(Boolean))].sort();
    const sel = document.getElementById('filter-dept');
    const current = sel.value;
    sel.innerHTML = '<option value="">すべて</option>' +
      depts.map(d => `<option value="${this.escape(d)}">${this.escape(d)}</option>`).join('');
    sel.value = current;

    this.render();
  },

  render() {
    const employees = this.visibleEmployees();
    const fCat = document.getElementById('filter-cat').value;
    const fDept = document.getElementById('filter-dept').value;
    const fName = (document.getElementById('filter-name').value || '').toLowerCase();

    const rows = employees.filter(e =>
      (!fCat || e.category === fCat) &&
      (!fDept || e.department === fDept) &&
      (!fName || (e.name || '').toLowerCase().includes(fName))
    );
    document.getElementById('visible-count').textContent = rows.length;

    const qualMap = {};
    (Sync.cache.qualifications || []).forEach(q => qualMap[q.id] = q);
    const now = new Date();
    const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const tbody = document.getElementById('emp-table-body');
    tbody.innerHTML = rows.map(e => {
      // 現在進行形の配置のみ（完成・未開始は除外）
      const asgs = (Sync.cache.assignments || []).filter(a =>
        a.emp_id === e.id && !a.completed && Sync.isActiveAssignment(a)
      );
      const MAX_SHOW = 3;
      const asgStr = asgs.length
        ? asgs.slice(0, MAX_SHOW).map(a => this.escape(a.project_name)).join(', ')
          + (asgs.length > MAX_SHOW ? `<span class="text-slate-400 text-xs ml-1">…他${asgs.length - MAX_SHOW}件</span>` : '')
        : '<span class="text-slate-400">なし</span>';

      const myQuals = (Sync.cache.employee_qualifications || []).filter(eq => eq.emp_id === e.id);
      const qualStr = myQuals.length
        ? myQuals.map(eq => {
            const q = qualMap[eq.qual_id];
            if (!q) return '';
            let cls = 'bg-emerald-100 text-emerald-800';
            let suffix = '';
            if (eq.expiry) {
              const exp = new Date(eq.expiry);
              if (exp < now) { cls = 'bg-red-100 text-red-800 font-bold'; suffix = '⚠'; }
              else if (exp <= in90Days) { cls = 'bg-amber-100 text-amber-800'; suffix = '!'; }
            }
            return `<span class="${cls} px-1.5 py-0.5 rounded text-xs mr-1 inline-block" title="${this.escape(q.name)}${eq.expiry ? ' / 期限 ' + eq.expiry : ''}">${this.escape(this.shortName(q.name))}${suffix}</span>`;
          }).filter(Boolean).join('')
        : '<span class="text-slate-400 text-xs">-</span>';

      return '<tr class="border-t hover:bg-slate-50">' +
        '<td class="px-3 py-2 font-mono text-xs">' + e.id + '</td>' +
        '<td class="px-3 py-2 font-medium">' + this.escape(e.name) + '</td>' +
        '<td class="px-3 py-2">' + this.escape(e.department || '') + '</td>' +
        '<td class="px-3 py-2">' + this.escape(e.role || '') + '</td>' +
        '<td class="px-3 py-2">' + this.categoryBadge(e.category) + '</td>' +
        '<td class="px-3 py-2">' + qualStr + '</td>' +
        '<td class="px-3 py-2 text-xs">' + asgStr + '</td>' +
        '</tr>';
    }).join('');
  },

  // 資格名を短縮表示（一覧で長いと潰れるため）
  shortName(name) {
    const aliases = {
      '1級土木施工管理技士': '1級土木',
      '解体作業主任者': '解体主',
      '酸素欠乏・硫化水素危険作業主任者': '酸欠主',
      '足場の組立て等作業主任者': '足場主',
      '玉掛け技能講習': '玉掛け',
    };
    return aliases[name] || (name.length > 8 ? name.substring(0, 7) + '…' : name);
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
