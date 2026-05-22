/**
 * member_add.js - メンバー追加モーダル（共通UI）
 *
 * 現場（受注案件 or 見込み案件）に対し、新規に担当監督を紐付ける。
 * - GAS Web App の assignment_overrides に op=add で保存
 * - ガントの現場行・見込み案件タブから呼び出し
 *
 * 使用例:
 *   MemberAdd.open({ project_id: 'K0001-01', project_name: '...', start: '2026/05/01', end: '2026/12/31', meta: '元請 / 京浜事務所' });
 */

const MemberAdd = {
  currentContext: null,  // { project_id, project_name, start, end, meta }

  init() {
    document.getElementById('member-add-close').addEventListener('click', () => this.close());
    document.getElementById('member-add-cancel').addEventListener('click', () => this.close());
    document.getElementById('member-add-save').addEventListener('click', () => this.save());
    document.getElementById('member-add-search').addEventListener('input', () => this.populateEmployeeList());

    // モーダル背景クリックで閉じる
    const modal = document.getElementById('member-add-modal');
    modal.addEventListener('click', (e) => { if (e.target === modal) this.close(); });
  },

  open(ctx) {
    this.currentContext = ctx || {};
    document.getElementById('member-add-project-name').textContent = ctx.project_name || '-';
    document.getElementById('member-add-project-meta').textContent = ctx.meta || '';

    // 既定の期間：現場の工期と一致
    const toIso = (s) => {
      if (!s) return '';
      const d = new Date(String(s).replace(/\//g, '-'));
      if (isNaN(d)) return '';
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    document.getElementById('member-add-start').value = toIso(ctx.start);
    document.getElementById('member-add-end').value = toIso(ctx.end);
    document.getElementById('member-add-role').value = '副監督';
    document.getElementById('member-add-note').value = '';
    document.getElementById('member-add-search').value = '';
    document.getElementById('member-add-status').textContent = '';

    this.populateEmployeeList();
    document.getElementById('member-add-modal').classList.remove('hidden');
  },

  close() {
    document.getElementById('member-add-modal').classList.add('hidden');
    this.currentContext = null;
  },

  populateEmployeeList() {
    const sel = document.getElementById('member-add-emp');
    const search = (document.getElementById('member-add-search').value || '').toLowerCase().trim();
    // 配置プール：現場監督 + 準現場監督
    const all = (Sync.cache.employees || [])
      .filter(e => e.category === '現場監督' || e.category === '準現場監督')
      .slice()
      .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    const filtered = search
      ? all.filter(e =>
          String(e.id).includes(search) ||
          (e.name || '').toLowerCase().includes(search) ||
          (e.name || '').replace(/\s+/g, '').toLowerCase().includes(search) ||
          (e.department || '').toLowerCase().includes(search)
        )
      : all;
    sel.innerHTML = filtered.map(e =>
      `<option value="${e.id}|${this.esc(e.name)}">${this.esc(e.id)}  ${this.esc(e.name)}  (${this.esc(e.department || '-')} / ${this.esc(e.category)})</option>`
    ).join('');
  },

  async save() {
    const sel = document.getElementById('member-add-emp');
    const selected = sel.value;
    const statusEl = document.getElementById('member-add-status');
    if (!selected) {
      statusEl.textContent = '⚠ 監督を選択してください';
      statusEl.className = 'text-xs text-red-600';
      return;
    }
    const [empId, empName] = selected.split('|');
    const role = document.getElementById('member-add-role').value;
    const start = document.getElementById('member-add-start').value;
    const end = document.getElementById('member-add-end').value;
    const note = document.getElementById('member-add-note').value;
    const ctx = this.currentContext || {};

    if (!start || !end) {
      statusEl.textContent = '⚠ 配属開始日と終了日を入力してください';
      statusEl.className = 'text-xs text-red-600';
      return;
    }
    if (start > end) {
      statusEl.textContent = '⚠ 終了日は開始日より後にしてください';
      statusEl.className = 'text-xs text-red-600';
      return;
    }
    if (!ctx.project_id) {
      statusEl.textContent = '⚠ 現場情報が取得できません';
      statusEl.className = 'text-xs text-red-600';
      return;
    }

    const toSlash = s => s ? String(s).replace(/-/g, '/') : '';

    statusEl.textContent = '追加中…';
    statusEl.className = 'text-xs text-slate-500';
    const saveBtn = document.getElementById('member-add-save');
    saveBtn.disabled = true;

    try {
      const overrideKey = Sync.buildOverrideKey(empName, ctx.project_id);
      await Sync.postOverride({
        action: 'upsert',
        op: 'add',
        override_key: overrideKey,
        emp_name: empName,
        project_id: ctx.project_id,
        join_date: toSlash(start),
        planned_end: toSlash(end),
        role,
        note,
        updated_by: 'web',
      });
      statusEl.textContent = '✓ 追加しました';
      statusEl.className = 'text-xs text-emerald-600';
      if (typeof App !== 'undefined' && typeof App.loadData === 'function') {
        await App.loadData();
      }
      setTimeout(() => this.close(), 600);
    } catch (e) {
      console.error('メンバー追加 失敗:', e);
      statusEl.textContent = '× 追加失敗: ' + (e.message || e);
      statusEl.className = 'text-xs text-red-600';
    } finally {
      saveBtn.disabled = false;
    }
  },

  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
