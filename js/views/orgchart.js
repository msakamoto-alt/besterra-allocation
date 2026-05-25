/**
 * orgchart.js - 組織図（編集者のみ・ヘッダーの「組織図」ボタンから表示）
 *
 * Sync.cache.organization（SmartHR名簿）の部署パス（スラッシュ階層）を解析して、
 * 社内組織図PDFと同様の「トップダウン・ボックス型ツリー」で描画する。
 * 各組織ボックスに所属者（役職・氏名・階層ドット）を縦に列挙。兼任は複数組織に出現。
 *
 * D3: 表示。D4: 氏名クリックで階層判定（employee_tiers へ upsert・手動優先）を追加予定。
 */

const OrgChartView = {
  // category（監督リストと同一表記）→ 階層ドット色
  TIER_DOT: {
    '現場監督': '#0d9488',   // ティール
    '準現場監督': '#d97706', // アンバー
    '監督サポート': '#ea580c', // オレンジ
    '対象外': '',            // ドットなし
  },

  init() {
    const s = document.getElementById('org-search');
    if (s) s.addEventListener('input', () => this.refresh());
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

    document.getElementById('org-count').textContent = `${filtered.length} / ${orgRows.length} 名`;
    const root = this.buildTree(filtered);
    content.innerHTML = this.renderTree(root);
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
      const depts = Array.isArray(r.depts) ? r.depts : [];
      if (depts.length === 0) { ensure(['(所属未設定)']).members.push(r); return; }
      depts.forEach(d => {
        const segs = String(d).split('/').map(s => s.trim()).filter(Boolean);
        if (segs.length) ensure(segs).members.push(r);
      });
    });
    return root;
  },

  renderTree(root) {
    return `<div class="org-tree"><ul>${this.renderLi(root)}</ul></div>`;
  },

  renderLi(node) {
    const childNames = Object.keys(node.children).sort();
    const childrenHtml = childNames.length
      ? `<ul>${childNames.map(n => this.renderLi(node.children[n])).join('')}</ul>`
      : '';
    return `<li>${this.boxHtml(node)}${childrenHtml}</li>`;
  },

  boxHtml(node) {
    const members = node.members
      .slice()
      .sort((a, b) => String(a.emp_no).localeCompare(String(b.emp_no)))
      .map(r => this.memberLine(r)).join('');
    return `<div class="org-box">` +
      `<div class="org-box-title">${this.esc(node.name)}</div>` +
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
      dot +
      (pos ? `<span class="org-pos">${this.esc(pos)}</span>` : '') +
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
    el.innerHTML = items + '<span class="text-amber-600">* = 手動判定済み</span>';
  },

  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
