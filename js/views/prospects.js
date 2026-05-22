/**
 * prospects.js - 見込み案件管理（4タブ目）
 *
 * 11_prospects シートに対する CRUD UI。
 * GAS Web App 経由で書き込み（assignment_overrides と同じパターン）。
 */

const ProspectsView = {
  init() {
    document.getElementById('prospects-add-btn').addEventListener('click', () => this.openModal());
    document.getElementById('prospects-filter-status').addEventListener('change', () => this.refresh());
    document.getElementById('prospects-show-archived').addEventListener('change', () => this.refresh());
    document.getElementById('prospects-search').addEventListener('input', () => this.refresh());

    // 一覧行のアクション
    document.getElementById('prospects-table-body').addEventListener('click', (e) => {
      const editBtn = e.target.closest('button[data-action="edit"]');
      if (editBtn) { this.openModal(editBtn.dataset.id); return; }
      const archBtn = e.target.closest('button[data-action="archive"]');
      if (archBtn) { this.archive(archBtn.dataset.id); return; }
      const delBtn = e.target.closest('button[data-action="delete"]');
      if (delBtn) { this.delete(delBtn.dataset.id); return; }
    });

    // モーダル閉じる
    const modal = document.getElementById('prospect-modal');
    const closeFn = () => modal.classList.add('hidden');
    document.getElementById('prospect-modal-close').addEventListener('click', closeFn);
    document.getElementById('prospect-modal-cancel').addEventListener('click', closeFn);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeFn(); });

    // 保存
    document.getElementById('prospect-modal-save').addEventListener('click', () => this.save());
  },

  // 全 prospects 行（archived 除外しない元データ）を取得
  allRows() {
    return Sync.cache.prospects || [];
  },

  // フィルタ適用済み行
  filteredRows() {
    const status = document.getElementById('prospects-filter-status').value;
    const showArchived = document.getElementById('prospects-show-archived').checked;
    const search = (document.getElementById('prospects-search').value || '').toLowerCase().trim();
    return this.allRows().filter(r => {
      const arch = String(r.archived || '').toUpperCase();
      const isArchived = arch === 'TRUE' || arch === '1' || arch === 'YES';
      if (isArchived && !showArchived) return false;
      if (status && r.status !== status) return false;
      if (search) {
        const hay = `${r.customer || ''} ${r.project_name || ''} ${r.managing_dept || ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  },

  refresh() {
    // 事務所セレクトの選択肢を employees から動的生成
    this.populateDeptSelect();

    const rows = this.filteredRows();
    document.getElementById('prospects-count').textContent = rows.length;
    const tbody = document.getElementById('prospects-table-body');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-400 py-6">該当する見込み案件はありません</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => this.renderRow(r)).join('');
  },

  renderRow(r) {
    const statusBadge = this.statusBadge(r.status);
    const arch = String(r.archived || '').toUpperCase();
    const isArchived = arch === 'TRUE' || arch === '1' || arch === 'YES';
    const archRow = isArchived ? ' opacity-50' : '';
    const period = (r.start_date || '') + (r.end_date ? ' 〜 ' + r.end_date : '');
    const amountM = this.parseAmount(r.amount);
    const amountTxt = amountM >= 100 ? `¥${(amountM / 100).toFixed(1)}億`
                    : amountM > 0 ? `¥${amountM.toFixed(1)}M`
                    : '-';
    const actions = isArchived
      ? `<button data-action="delete" data-id="${this.esc(r.prospect_id)}" class="text-red-600 hover:underline text-xs">削除</button>`
      : `<button data-action="edit" data-id="${this.esc(r.prospect_id)}" class="text-blue-600 hover:underline text-xs mr-2">編集</button>` +
        `<button data-action="archive" data-id="${this.esc(r.prospect_id)}" class="text-emerald-700 hover:underline text-xs mr-2" title="Salesforceで受注確認後に押す">受注済</button>` +
        `<button data-action="delete" data-id="${this.esc(r.prospect_id)}" class="text-slate-500 hover:text-red-600 text-xs">削除</button>`;
    return `<tr class="border-t${archRow}">` +
      `<td class="px-3 py-2">${statusBadge}</td>` +
      `<td class="px-3 py-2">${this.esc(r.customer)}</td>` +
      `<td class="px-3 py-2 font-medium">${this.esc(r.project_name)}</td>` +
      `<td class="px-3 py-2 text-center text-xs">${this.esc(r.contract_type || '-')}</td>` +
      `<td class="px-3 py-2 text-center text-xs">${this.esc(r.area || '-')}</td>` +
      `<td class="px-3 py-2 text-center text-xs">${this.esc(r.managing_dept || '-')}</td>` +
      `<td class="px-3 py-2 text-center text-xs">${this.esc(period || '-')}</td>` +
      `<td class="px-3 py-2 text-right text-xs">${this.esc(amountTxt)}</td>` +
      `<td class="px-3 py-2 text-center whitespace-nowrap">${actions}</td>` +
      '</tr>';
  },

  statusBadge(status) {
    const colors = {
      '見込み': 'bg-slate-100 text-slate-700',
      '見積中': 'bg-blue-100 text-blue-700',
      '内示': 'bg-amber-100 text-amber-700',
      '確定': 'bg-emerald-100 text-emerald-700',
      '失注': 'bg-red-100 text-red-700',
      '受注済み': 'bg-purple-100 text-purple-700',
    };
    const cls = colors[status] || 'bg-slate-100 text-slate-700';
    return `<span class="inline-block ${cls} px-2 py-0.5 rounded text-xs font-medium">${this.esc(status || '見込み')}</span>`;
  },

  // 数値・通貨文字列を 百万円単位に変換
  parseAmount(s) {
    if (!s) return 0;
    const n = Number(String(s).replace(/[^\d.-]/g, ''));
    return isNaN(n) ? 0 : n / 1e6;
  },

  populateDeptSelect() {
    const sel = document.getElementById('prospect-managing-dept');
    if (!sel) return;
    const employees = Sync.cache.employees || [];
    const depts = Array.from(new Set(employees.map(e => e.department).filter(Boolean))).sort();
    const cur = sel.value;
    sel.innerHTML = '<option value="">未定</option>' +
      depts.map(d => `<option value="${this.esc(d)}">${this.esc(d)}</option>`).join('');
    if (cur) sel.value = cur;
  },

  openModal(prospectId) {
    const modal = document.getElementById('prospect-modal');
    const title = document.getElementById('prospect-modal-title');
    this.populateDeptSelect();

    if (prospectId) {
      const r = this.allRows().find(x => String(x.prospect_id) === String(prospectId));
      if (!r) return;
      title.textContent = '見込み案件 編集';
      document.getElementById('prospect-id').value = r.prospect_id;
      document.getElementById('prospect-status').value = r.status || '見込み';
      document.getElementById('prospect-contract-type').value = r.contract_type || '';
      document.getElementById('prospect-customer').value = r.customer || '';
      document.getElementById('prospect-project-name').value = r.project_name || '';
      document.getElementById('prospect-area').value = r.area || '';
      document.getElementById('prospect-managing-dept').value = r.managing_dept || '';
      document.getElementById('prospect-start-date').value = this.toIsoDate(r.start_date);
      document.getElementById('prospect-end-date').value = this.toIsoDate(r.end_date);
      document.getElementById('prospect-amount').value = r.amount || '';
      document.getElementById('prospect-note').value = r.note || '';
    } else {
      title.textContent = '見込み案件 新規追加';
      document.getElementById('prospect-form').reset();
      document.getElementById('prospect-id').value = '';
      document.getElementById('prospect-status').value = '見込み';
    }
    document.getElementById('prospect-form-status').textContent = '';
    modal.classList.remove('hidden');
  },

  toIsoDate(s) {
    if (!s) return '';
    const d = new Date(String(s).replace(/\//g, '-'));
    if (isNaN(d)) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  toSlashDate(s) {
    return s ? String(s).replace(/-/g, '/') : '';
  },

  async save() {
    const statusEl = document.getElementById('prospect-form-status');
    const id = document.getElementById('prospect-id').value;
    const customer = document.getElementById('prospect-customer').value.trim();
    const projectName = document.getElementById('prospect-project-name').value.trim();
    if (!customer || !projectName) {
      statusEl.textContent = '⚠ 客先名と工事名は必須です';
      statusEl.className = 'text-xs text-red-600';
      return;
    }

    const payload = {
      action: 'prospect_upsert',
      prospect_id: id || undefined,
      status: document.getElementById('prospect-status').value,
      contract_type: document.getElementById('prospect-contract-type').value,
      customer,
      project_name: projectName,
      area: document.getElementById('prospect-area').value,
      managing_dept: document.getElementById('prospect-managing-dept').value,
      start_date: this.toSlashDate(document.getElementById('prospect-start-date').value),
      end_date: this.toSlashDate(document.getElementById('prospect-end-date').value),
      amount: document.getElementById('prospect-amount').value,
      note: document.getElementById('prospect-note').value,
      updated_by: 'web',
    };

    statusEl.textContent = '保存中…';
    statusEl.className = 'text-xs text-slate-500';
    const saveBtn = document.getElementById('prospect-modal-save');
    saveBtn.disabled = true;
    try {
      const result = await Sync.postOverride(payload);
      statusEl.textContent = `✓ 保存しました（${result.action || 'ok'}）`;
      statusEl.className = 'text-xs text-emerald-600';
      // 全データ再同期
      if (typeof App !== 'undefined' && typeof App.loadData === 'function') {
        await App.loadData();
      }
      setTimeout(() => document.getElementById('prospect-modal').classList.add('hidden'), 500);
    } catch (e) {
      console.error('見込み案件 保存失敗:', e);
      statusEl.textContent = '× 保存失敗: ' + (e.message || e);
      statusEl.className = 'text-xs text-red-600';
    } finally {
      saveBtn.disabled = false;
    }
  },

  async archive(prospectId) {
    const r = this.allRows().find(x => String(x.prospect_id) === String(prospectId));
    if (!r) return;
    if (!confirm(`「${r.customer} / ${r.project_name}」を受注済みにしてアーカイブしますか？\n（一覧から非表示になります）`)) return;
    try {
      await Sync.postOverride({ action: 'prospect_archive', prospect_id: prospectId, updated_by: 'web' });
      if (typeof App !== 'undefined' && typeof App.loadData === 'function') await App.loadData();
    } catch (e) {
      console.error('アーカイブ失敗:', e);
      alert('アーカイブ失敗: ' + (e.message || e));
    }
  },

  async delete(prospectId) {
    const r = this.allRows().find(x => String(x.prospect_id) === String(prospectId));
    if (!r) return;
    if (!confirm(`「${r.customer} / ${r.project_name}」を完全に削除しますか？\n（取り消しできません）`)) return;
    try {
      await Sync.postOverride({ action: 'prospect_delete', prospect_id: prospectId });
      if (typeof App !== 'undefined' && typeof App.loadData === 'function') await App.loadData();
    } catch (e) {
      console.error('削除失敗:', e);
      alert('削除失敗: ' + (e.message || e));
    }
  },

  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
