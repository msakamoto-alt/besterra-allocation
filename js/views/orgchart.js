/**
 * orgchart.js - 組織図（編集者のみ・ヘッダーの「組織図」ボタンから表示）
 *
 * SmartHR名簿(organization)の部署パス（スラッシュ階層）を、社内組織図PDF風の
 * 「トップダウン・ボックス型ツリー」で描画。各組織ボックスに所属者を縦に列挙。
 *
 * 可読性：組織名クリックで配下を開閉（初期は部レベルで折りたたみ）＋ ズーム。
 * D4: 氏名クリックで階層判定（employee_tiers へ upsert・手動優先）を追加予定。
 */

const OrgChartView = {
  TIER_DOT: {
    '現場監督': '#0d9488',
    '準現場監督': '#d97706',
    '監督サポート': '#ea580c',
    '対象外': '',
  },

  // 役職の上位順（小さいほど上位）。組織ボックス内で役職者を上に並べる。
  POSITION_RANK: ['会長', '社長', '代表取締役', '専務', '常務', '本部長', '執行役員', '部長', '副部長', '室長', '所長', '副所長', '課長', '作業所長'],

  DEFAULT_DEPTH: 2,        // この深さ以上は初期状態で折りたたむ（部・室レベル）
  mode: 'default',         // default / all（全展開）/ none（全折りたたみ）
  userExpanded: new Set(), // 個別に開いたパス
  userCollapsed: new Set(),// 個別に閉じたパス
  zoom: 0.8,

  init() {
    const s = document.getElementById('org-search');
    if (s) s.addEventListener('input', () => this.refresh());

    // 組織名クリックで開閉（イベント委譲）
    const content = document.getElementById('orgchart-content');
    if (content) content.addEventListener('click', (e) => {
      const t = e.target.closest('[data-org-path]');
      if (t) this.toggle(t.getAttribute('data-org-path'));
    });

    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    bind('org-zoom-in', () => this.setZoom(this.zoom + 0.1));
    bind('org-zoom-out', () => this.setZoom(this.zoom - 0.1));
    bind('org-expand-all', () => { this.mode = 'all'; this.userExpanded.clear(); this.userCollapsed.clear(); this.refresh(); });
    bind('org-collapse-all', () => { this.mode = 'none'; this.userExpanded.clear(); this.userCollapsed.clear(); this.refresh(); });
  },

  setZoom(z) {
    this.zoom = Math.min(1.5, Math.max(0.4, Math.round(z * 10) / 10));
    const tree = document.querySelector('#orgchart-content .org-tree');
    if (tree) tree.style.zoom = this.zoom;
    const lbl = document.getElementById('org-zoom-label');
    if (lbl) lbl.textContent = Math.round(this.zoom * 100) + '%';
  },

  toggle(path) {
    // 現在の表示状態を反転して個別指定に記録
    if (this.userExpanded.has(path)) { this.userExpanded.delete(path); this.userCollapsed.add(path); }
    else if (this.userCollapsed.has(path)) { this.userCollapsed.delete(path); this.userExpanded.add(path); }
    else {
      // mode 既定状態からの反転
      const wasCollapsed = (this.mode === 'none') || (this.mode === 'default');
      if (wasCollapsed) this.userExpanded.add(path); else this.userCollapsed.add(path);
    }
    this.refresh();
  },

  isCollapsed(path, depth, hasChildren) {
    if (!hasChildren) return false;
    if (this.userExpanded.has(path)) return false;
    if (this.userCollapsed.has(path)) return true;
    if (this.mode === 'all') return false;
    if (this.mode === 'none') return true;
    return depth >= this.DEFAULT_DEPTH;
  },

  refresh() {
    const content = document.getElementById('orgchart-content');
    if (!content) return;
    const orgRows = Sync.cache.organization || [];
    if (orgRows.length === 0) {
      content.innerHTML = '<div class="text-slate-400 py-4">組織図データがありません（「同期」で 01_organization を取り込んでください）</div>';
      document.getElementById('org-count').textContent = '';
      this.renderLegend();
      return;
    }

    this.empByNo = {};
    (Sync.cache.employees || []).forEach(e => { this.empByNo[String(e.id)] = e; });
    this.tierSet = new Set((Sync.cache.employee_tiers || []).map(t => String(t.emp_no || '').trim()));

    const q = (document.getElementById('org-search').value || '').trim().toLowerCase();
    const filtered = q ? orgRows.filter(r => {
      const name = `${r.last_name || ''}${r.first_name || ''}`.toLowerCase();
      return name.includes(q) || String(r.emp_no || '').toLowerCase().includes(q);
    }) : orgRows;
    // 検索中は該当が見えるよう全展開
    if (q) this.mode = 'all';

    document.getElementById('org-count').textContent = `${filtered.length} / ${orgRows.length} 名`;
    const root = this.buildTree(filtered);
    content.innerHTML = this.renderTree(root);
    this.setZoom(this.zoom);
    this.renderLegend();
  },

  buildTree(orgRows) {
    const root = { name: 'ベステラ株式会社', children: {}, members: [] };
    const ensure = (segs) => {
      let node = root;
      segs.forEach(seg => {
        if (!node.children[seg]) node.children[seg] = { name: seg, children: {}, members: [] };
        node = node.children[seg];
      });
      return node;
    };
    orgRows.forEach(r => {
      // 同一部署の重複（SmartHR名簿で部署が二重登録される例：宮内）を除去
      const depts = Array.isArray(r.depts) ? [...new Set(r.depts)] : [];
      if (depts.length === 0) { ensure(['(所属未設定)']).members.push(r); return; }
      depts.forEach(d => {
        const segs = String(d).split('/').map(s => s.trim()).filter(Boolean);
        if (segs.length) ensure(segs).members.push(r);
      });
    });
    return root;
  },

  countMembers(node) {
    let n = node.members.length;
    Object.values(node.children).forEach(c => { n += this.countMembers(c); });
    return n;
  },

  // 役職の上位度（小さいほど上位・該当なしは999）。ボックス内の並べ替え用。
  positionRank(positions) {
    let best = 999;
    (positions || []).forEach(p => {
      const s = String(p || '');
      this.POSITION_RANK.forEach((t, i) => { if (s.includes(t) && i < best) best = i; });
    });
    return best;
  },

  renderTree(root) {
    return `<div class="org-tree"><ul>${this.renderLi(root, 0, '')}</ul></div>`;
  },

  renderLi(node, depth, parentPath) {
    const path = parentPath + '/' + node.name;
    const childNames = Object.keys(node.children).sort();
    const hasChildren = childNames.length > 0;
    const collapsed = this.isCollapsed(path, depth, hasChildren);
    const childrenHtml = (hasChildren && !collapsed)
      ? `<ul>${childNames.map(n => this.renderLi(node.children[n], depth + 1, path)).join('')}</ul>`
      : '';
    return `<li>${this.boxHtml(node, path, hasChildren, collapsed)}${childrenHtml}</li>`;
  },

  boxHtml(node, path, hasChildren, collapsed) {
    const icon = hasChildren ? `<span class="org-toggle-icon">${collapsed ? '▶' : '▼'}</span>` : '';
    const hidden = (hasChildren && collapsed) ? ` <span class="org-box-count">${this.countMembers(node)}名</span>` : '';
    const titleAttrs = hasChildren ? ` data-org-path="${this.esc(path)}" style="cursor:pointer"` : '';
    const members = node.members
      .slice()
      .sort((a, b) => (this.positionRank(a.positions) - this.positionRank(b.positions)) || String(a.emp_no).localeCompare(String(b.emp_no)))
      .map(r => this.memberLine(r)).join('');
    return `<div class="org-box">` +
      `<div class="org-box-title"${titleAttrs}>${icon}${this.esc(node.name)}${hidden}</div>` +
      (members ? `<div class="org-box-members">${members}</div>` : '') +
      `</div>`;
  },

  memberLine(r) {
    const no = String(r.emp_no || '').trim();
    const emp = this.empByNo[no];
    const cat = emp ? emp.category : '対象外';
    const name = `${r.last_name || ''} ${r.first_name || ''}`.trim();
    const positions = Array.isArray(r.positions) ? r.positions : [];
    const pos = positions[0] || '';
    const color = this.TIER_DOT[cat] || '';
    const dot = color ? `<span class="org-dot" style="background:${color}" title="${cat}"></span>` : '<span class="org-dot org-dot-none"></span>';
    const manual = this.tierSet.has(no) ? '<span class="org-manual" title="手動判定済み">*</span>' : '';
    return `<div class="org-member" data-no="${this.esc(no)}">` +
      dot + (pos ? `<span class="org-pos">${this.esc(pos)}</span>` : '') +
      `<span class="org-name">${this.esc(name)}</span>${manual}</div>`;
  },

  renderLegend() {
    const el = document.getElementById('org-legend');
    if (!el) return;
    const items = Object.keys(this.TIER_DOT).map(cat => {
      const c = this.TIER_DOT[cat];
      const dot = c ? `<span class="org-dot" style="background:${c}"></span>` : '<span class="org-dot org-dot-none"></span>';
      return `<span class="inline-flex items-center gap-1">${dot}${cat}</span>`;
    }).join('');
    el.innerHTML = items + '<span class="text-amber-600">* = 手動判定済み</span><span class="text-slate-400">組織名クリックで開閉</span>';
  },

  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
