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

    // 見積金額：入力中に3桁カンマ区切りで整形（円・1円単位）
    const amtEl = document.getElementById('prospect-amount');
    if (amtEl) amtEl.addEventListener('input', () => this.formatAmountField(amtEl));

    // メンバー追加・解除
    document.getElementById('prospect-add-member-btn').addEventListener('click', () => this.openMemberAdd());
    document.getElementById('prospect-members-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="member-remove"]');
      if (btn) this.removeMember(btn.dataset.asgId);
    });
  },

  // 数値文字列を3桁カンマ区切りに整形（数字以外は除去・空は空のまま）
  fmtAmountStr(v) {
    const digits = String(v == null ? '' : v).replace(/[^0-9]/g, '');
    return digits ? Number(digits).toLocaleString('en-US') : '';
  },

  // 見積金額の入力欄をカンマ整形しつつキャレット位置を保持
  formatAmountField(el) {
    const start = el.selectionStart;
    const digitsBefore = el.value.slice(0, start).replace(/[^0-9]/g, '').length;
    const formatted = this.fmtAmountStr(el.value);
    el.value = formatted;
    // 同じ数字桁数の位置へキャレットを戻す
    let pos = 0, seen = 0;
    while (pos < formatted.length && seen < digitsBefore) {
      if (formatted[pos] >= '0' && formatted[pos] <= '9') seen++;
      pos++;
    }
    el.setSelectionRange(pos, pos);
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

    // 編集モードでないとき（閲覧者）は「新規追加」ボタンを隠す
    const addBtn = document.getElementById('prospects-add-btn');
    if (addBtn) addBtn.classList.toggle('hidden', !Sync.canEdit());

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
    const amountTxt = amountM > 0 ? `¥${amountM.toFixed(1)}M` : '-';
    // Salesforce取込の実工事と工事名が一致＝受注済みで重複の可能性 → ⚠表示
    const hit = this.sfCollision(r);
    const collisionMark = hit
      ? ` <span class="inline-flex items-center bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 rounded text-[10px] font-bold align-middle whitespace-normal" title="Salesforce取込の工事「${this.esc(hit.project_id)} ${this.esc(hit.name)}」と工事名が似ています。すでに受注済みの可能性があります。受注済みなら『受注済』でアーカイブしてください。">⚠ SF重複? ${this.esc(hit.project_id)} ${this.esc(hit.name)}</span>`
      : '';
    const actions = !Sync.canEdit()
      ? '<span class="text-slate-300 text-xs">—</span>'
      : isArchived
      ? `<button data-action="delete" data-id="${this.esc(r.prospect_id)}" class="text-red-600 hover:underline text-xs">削除</button>`
      : `<button data-action="edit" data-id="${this.esc(r.prospect_id)}" class="text-blue-600 hover:underline text-xs mr-2">編集</button>` +
        `<button data-action="archive" data-id="${this.esc(r.prospect_id)}" class="text-emerald-700 hover:underline text-xs mr-2" title="Salesforceで受注確認後に押す">受注済</button>` +
        `<button data-action="delete" data-id="${this.esc(r.prospect_id)}" class="text-slate-500 hover:text-red-600 text-xs">削除</button>`;
    return `<tr class="border-t${archRow}">` +
      `<td class="px-3 py-2">${statusBadge}</td>` +
      `<td class="px-3 py-2">${this.esc(r.customer)}</td>` +
      `<td class="px-3 py-2 font-medium">${this.esc(r.project_name)}${collisionMark}</td>` +
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

  // 工事名の正規化（全半角統一・空白/記号除去）。バッティング照合用。
  normName(s) {
    return String(s || '').normalize('NFKC').replace(/\s+/g, '')
      .replace(/[（）()【】「」『』〔〕［］\[\]{}・,，.．、。/／\\\-－—~〜_|｜:：;；'"”’#＃*＊]/g, '').toLowerCase();
  },

  // 工事種別・会社種別など、どの案件にも現れる一般語。固有部分の重なりを見るため核から除去する。
  // ここを足し引きすれば誤検知/見逃しを調整できる。
  CORE_STOP: /株式会社|有限会社|合同会社|工事|作業|業務|請負|解体|撤去|新設|増設|設置|据付|据置|改修|補修|修繕|更新|更生|分解|工場|設備|機器|装置|建物|建屋|一式|本社|工区|計画|年度|案件|その他|ほか|外|及び|および|並びに/g,

  // 一般語を除いた「核」（固有名詞部分）を返す
  coreName(s) {
    return this.normName(s).replace(this.CORE_STOP, '');
  },

  // 連続する最長共通部分文字列の長さ（DPでO(n*m)）
  lcsLen(a, b) {
    if (!a || !b) return 0;
    let best = 0;
    const dp = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      let prev = 0;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = (a[i - 1] === b[j - 1]) ? prev + 1 : 0;
        if (dp[j] > best) best = dp[j];
        prev = tmp;
      }
    }
    return best;
  },

  // 核どうしの共通部分文字列がこの文字数以上なら重複候補とみなす（小さいほど敏感／誤検知増）
  SIM_MIN_LCS: 4,

  // この見込み案件と工事名が被る Salesforce取込の実工事（見込み由来でない）を返す。
  // SF側は customer が空のため照合は工事名のみ。
  //   ① 完全一致／一方が他方を丸ごと内包（厳密・従来）
  //   ② 一般語を除いた「核」の最長共通部分文字列が SIM_MIN_LCS 以上
  //      （客先名や工事種別が違っても、現場名・対象設備などの固有部分が重なれば拾う）
  sfCollision(r) {
    const pn = this.normName(r.project_name);
    if (pn.length < 3) return null;
    const pCore = this.coreName(r.project_name);
    const projs = Sync.cache.projects || [];
    for (const p of projs) {
      // SF実工事のみ（見込み由来は除外）。完了済みは重複チェック対象外（古い工事への誤検知を防ぐ）。
      if (p.prospect || !p.project_id || p.completed) continue;
      const sn = this.normName(p.name);
      if (!sn) continue;
      // ① 厳密一致／内包
      if (sn === pn || (pn.length >= 5 && (sn.includes(pn) || pn.includes(sn)))) return p;
      // ② 核の固有部分が一定長重なる
      const sCore = this.coreName(p.name);
      if (pCore.length >= this.SIM_MIN_LCS && sCore.length >= this.SIM_MIN_LCS
          && this.lcsLen(pCore, sCore) >= this.SIM_MIN_LCS) return p;
    }
    return null;
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

    const memSection = document.getElementById('prospect-members-section');
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
      document.getElementById('prospect-amount').value = this.fmtAmountStr(r.amount);
      document.getElementById('prospect-note').value = r.note || '';
      // 既存案件はメンバー管理セクションを表示
      memSection.classList.remove('hidden');
      this.refreshMemberList(r.prospect_id);
    } else {
      title.textContent = '見込み案件 新規追加';
      document.getElementById('prospect-form').reset();
      document.getElementById('prospect-id').value = '';
      document.getElementById('prospect-status').value = '見込み';
      // 新規時はメンバー管理を隠す（保存後の再オープンで表示）
      memSection.classList.add('hidden');
    }
    document.getElementById('prospect-form-status').textContent = '';
    modal.classList.remove('hidden');
  },

  // 現在の prospect の担当メンバー一覧を表示
  refreshMemberList(prospectId) {
    const listEl = document.getElementById('prospect-members-list');
    const assignments = (Sync.cache.assignments || []).filter(a => a.project_id === prospectId);
    if (assignments.length === 0) {
      listEl.innerHTML = '<div class="text-slate-400 text-xs py-1">担当監督が未設定です</div>';
      return;
    }
    listEl.innerHTML = assignments.map(a => {
      const role = Sync.normalizeRole ? Sync.normalizeRole(a.role) : a.role;
      const period = `${a.join || '-'} 〜 ${a.planned_end || '-'}`;
      const displayName = (typeof GanttView !== 'undefined' && GanttView.displayEmpName)
        ? GanttView.displayEmpName(a.emp_name)
        : a.emp_name;
      return `<div class="flex items-center justify-between border border-slate-200 rounded px-2 py-1 text-xs">` +
        `<div><span class="font-medium">${this.esc(displayName)}</span> <span class="text-slate-500 ml-1">${this.esc(role)}</span> <span class="text-slate-400 ml-1">${this.esc(period)}</span></div>` +
        `<button data-action="member-remove" data-asg-id="${this.esc(a.assignment_id)}" class="text-red-600 hover:underline text-xs">解除</button>` +
        '</div>';
    }).join('');
  },

  openMemberAdd() {
    const prospectId = document.getElementById('prospect-id').value;
    if (!prospectId) return;
    const r = this.allRows().find(x => String(x.prospect_id) === String(prospectId));
    if (!r) return;
    const meta = `${r.contract_type || '-'} / ${r.managing_dept || '-'} / 見込み`;
    if (typeof MemberAdd !== 'undefined') {
      MemberAdd.open({
        project_id: r.prospect_id,
        project_name: r.project_name,
        start: r.start_date,
        end: r.end_date,
        meta,
      });
    }
  },

  async removeMember(asgId) {
    const a = (Sync.cache.assignments || []).find(x => String(x.assignment_id) === String(asgId));
    if (!a) return;
    if (!confirm(`「${a.emp_name}」をこの案件から解除しますか？`)) return;
    try {
      // 配置未定・不足は emp_name 固定 + 役割付き override_key → assignmentに保存済みのkeyを優先
      const overrideKey = a.override_key || Sync.buildOverrideKey(a.emp_name, a.project_id);
      // 見込みは add 由来のはず → 物理削除
      if (a.source === 'override_add' || a.override_op === 'add') {
        await Sync.postOverride({ action: 'delete', override_key: overrideKey });
      } else {
        await Sync.postOverride({
          action: 'upsert', op: 'remove',
          override_key: overrideKey, emp_name: a.emp_name, project_id: a.project_id,
          updated_by: 'web',
        });
      }
      if (typeof App !== 'undefined' && typeof App.loadData === 'function') {
        await App.loadData();
      }
      // モーダル開いたままリスト更新
      this.refreshMemberList(a.project_id);
    } catch (e) {
      console.error('解除失敗:', e);
      alert('解除失敗: ' + (e.message || e));
    }
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
      amount: document.getElementById('prospect-amount').value.replace(/[^0-9]/g, ''),
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
