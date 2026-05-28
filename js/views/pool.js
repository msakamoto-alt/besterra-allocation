/**
 * pool.js - 監督リスト（3階層表示・社員テーブル）
 * 区分「対象外」は表示しない方針
 */

const PoolView = {
  // 階層フィルタ：null=フィルタなし、1=現場監督のみ、2=現場監督+準現場監督、3=全員
  currentTier: null,

  // 階層 → 表示対象カテゴリ
  TIER_CATEGORIES: {
    1: ['現場監督'],
    2: ['現場監督', '準現場監督'],
    3: ['現場監督', '準現場監督', '監督サポート'],
  },

  init() {
    document.getElementById('filter-cat').addEventListener('change', () => this.render());
    document.getElementById('filter-dept').addEventListener('change', () => this.render());
    document.getElementById('filter-name').addEventListener('input', () => this.render());

    // 階層カードクリックでフィルタ切替（同じ階層を再クリックで解除）
    document.querySelectorAll('.pool-tier-card').forEach(card => {
      card.addEventListener('click', () => {
        const tier = Number(card.dataset.tier);
        this.currentTier = (this.currentTier === tier) ? null : tier;
        this.updateTierActiveUI();
        this.render();
      });
    });
  },

  // アクティブな階層カードに .active クラスを付与
  updateTierActiveUI() {
    document.querySelectorAll('.pool-tier-card').forEach(card => {
      card.classList.toggle('active', Number(card.dataset.tier) === this.currentTier);
    });
  },

  // 対象外を除いた表示対象社員
  visibleEmployees() {
    return (Sync.cache.employees || []).filter(e => e.category !== '対象外');
  },

  refresh() {
    const employees = this.visibleEmployees();

    // 3階層カウント（新表記）
    const cntSup = employees.filter(e => e.category === '現場監督').length;
    const cntQuasi = employees.filter(e => e.category === '準現場監督').length;
    const cntBroad = employees.filter(e => e.category === '監督サポート').length;
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
    const tierCats = this.currentTier ? this.TIER_CATEGORIES[this.currentTier] : null;

    const rows = employees.filter(e =>
      (!tierCats || tierCats.includes(e.category)) &&
      (!fCat || e.category === fCat) &&
      (!fDept || e.department === fDept) &&
      (!fName || (e.name || '').toLowerCase().includes(fName))
    );
    document.getElementById('visible-count').textContent = rows.length;

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

      return '<tr class="border-t hover:bg-slate-50">' +
        '<td class="px-3 py-2 font-mono text-xs">' + e.id + '</td>' +
        '<td class="px-3 py-2 font-medium">' + this.escape(e.name) + '</td>' +
        '<td class="px-3 py-2">' + this.escape(e.department || '') + '</td>' +
        '<td class="px-3 py-2"><span class="inline-flex flex-wrap items-center gap-1">' + this.categoryBadge(e.category) + this.workModeBadge(e.work_mode) + '</span></td>' +
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
    const klass = {
      '現場監督': 'badge-sup',
      '準現場監督': 'badge-quasi',
      '監督サポート': 'badge-broad',
      '対象外': 'badge-out',
    }[cat] || '';
    return '<span class="' + klass + ' px-2 py-0.5 rounded text-xs">' + this.escape(cat || '') + '</span>';
  },

  // 稼働形態バッジ（監督派遣/事務所専従/構内専従）。通常/未設定は何も出さない。
  workModeBadge(mode) {
    const wm = (typeof Sync !== 'undefined' && Sync.WORK_MODES) ? Sync.WORK_MODES[mode] : null;
    if (!wm) return '';
    return '<span class="' + wm.badge + ' px-1.5 py-0.5 rounded text-[10px] font-medium">' + this.escape(wm.short) + '</span>';
  },

  escape(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
