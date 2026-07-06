/**
 * modals.js - 配置編集モーダル・案件状態モーダル（Sync書込を伴う編集操作）
 *
 * js/views/gantt.js の GanttView にメソッドを追加するモジュール（2026-07 刷新で分割）。
 * メソッド本体は旧 gantt.js から無変更で移動。gantt.js より後・board.js より前に読み込むこと。
 */
Object.assign(GanttView, {
  // 現在モーダル表示中の assignment（編集対象）
  currentAssignment: null,

  // モーダルで配属詳細を表示
  showAssignmentModal(asgId) {
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const a = assignments.find(x => String(x.assignment_id) === String(asgId));
    if (!a) return;
    this.currentAssignment = a;
    const proj = projects.find(p => p.project_id === a.project_id) || {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isActive = Sync.isActiveAssignment(a);
    const stateBadge = a.prospect
      ? '<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-xs font-medium">⊘ 見込み案件</span>'
      : a.completed
        ? '<span class="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs">完成</span>'
        : isActive
          ? '<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded text-xs font-medium">● 配属中</span>'
          : '<span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-xs">未開始 / 範囲外</span>';

    const start = a.join ? this.parseDate(a.join) : null;
    const end = a.planned_end ? this.parseDate(a.planned_end) : null;
    const periodDays = (start && end && !isNaN(start) && !isNaN(end))
      ? Math.max(1, Math.ceil((end - start) / (24 * 60 * 60 * 1000)) + 1)
      : null;
    const fmt = d => d && !isNaN(d) ? `${d.getFullYear()}/${(d.getMonth() + 1)}/${d.getDate()}` : '-';
    const overrideBadge = a.overridden
      ? '<span class="bg-purple-100 text-purple-700 px-2 py-0.5 rounded text-xs ml-2">✎ 変更済み</span>'
      : '';

    const disp = this.resolveRoleDisplay(a, proj);
    const isPrime = String(proj.contract_type || '').includes('元請');
    const projAmount = Number(proj.amount) || 0;
    const requiresKanri = isPrime && projAmount >= this.KANRI_AMOUNT_THRESHOLD;
    const roleDisplay = `<span style="color:${disp.color};font-weight:600">${this.esc(disp.role || '-')}</span>` +
      (requiresKanri && a.role === '主任技術者' ? '<span class="ml-2 text-[10px] text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded">建設業法上の監理技術者</span>' : '') +
      (a.role_sf ? ` <span class="text-xs text-slate-400">（SF: ${this.esc(a.role_sf)}）</span>` : '');

    const body =
      `<div class="grid grid-cols-3 gap-x-4 gap-y-2 items-baseline">` +
      `<div class="text-slate-500">担当者</div>` +
      `<div class="col-span-2 font-bold text-base">${this.esc(this.displayEmpName(a.emp_name) || '-')}</div>` +
      `<div class="text-slate-500">役割</div>` +
      `<div class="col-span-2">${roleDisplay}</div>` +
      `<div class="text-slate-500">工事番号</div>` +
      `<div class="col-span-2 font-mono text-sm">${this.esc(a.project_id || '-')}</div>` +
      `<div class="text-slate-500">工事名</div>` +
      `<div class="col-span-2">${this.esc(a.project_name || proj.name || '-')}${this.contractBadge(proj.contract_type)}</div>` +
      `<div class="text-slate-500">事務所</div>` +
      `<div class="col-span-2">${this.esc(proj.dept || '-')}</div>` +
      `<div class="text-slate-500">配属期間</div>` +
      `<div class="col-span-2 font-bold">${fmt(start)} 〜 ${fmt(end)}${periodDays ? ` <span class="text-xs text-slate-500">（${periodDays}日）</span>` : ''}${overrideBadge}</div>` +
      (a.prep_start ? `<div class="text-slate-500">準備期間</div><div class="col-span-2">${this.esc(a.prep_start)} 〜 ${this.esc(a.join || '-')}<span class="text-xs text-slate-500 ml-1">（配属開始まで・斜線表示）</span></div>` : '') +
      `<div class="text-slate-500">状態</div>` +
      `<div class="col-span-2">${stateBadge}</div>` +
      (a.override_note ? `<div class="text-slate-500">変更メモ</div><div class="col-span-2 text-slate-600">${this.esc(a.override_note)}</div>` : '') +
      `</div>`;

    document.getElementById('gantt-modal-body').innerHTML = body;

    // 編集ボタンの活性化（API設定がある場合）。表示モードの各ボタンの表示/非表示は
    // exitEditMode に集約（表示モード＝配属解除＋編集する／編集モード＝元値に戻す＋保存）。
    const editBtn = document.getElementById('gantt-modal-edit-btn');
    if (Sync.canEdit()) { editBtn.disabled = false; editBtn.title = ''; }

    this.exitEditMode();  // 編集フォームは閉じた状態で開く（表示モードのボタン状態に整える）
    document.getElementById('gantt-modal').classList.remove('hidden');
  },

  // ISO yyyy-mm-dd への変換（date input 用）
  toIsoDate(s) { return Util.toIsoDate(s); },

  // 編集モードへ（人員タイプに応じて役割セレクト選択肢を切替）
  enterEditMode() {
    const a = this.currentAssignment;
    if (!a) return;
    document.getElementById('edit-join').value = this.toIsoDate(a.join);
    document.getElementById('edit-end').value = this.toIsoDate(a.planned_end);
    document.getElementById('edit-prep-start').value = this.toIsoDate(a.prep_start);
    const normRole = Sync.normalizeRole ? Sync.normalizeRole(a.role) : a.role;
    const roleSel = document.getElementById('edit-role');

    // 人員タイプ判定：派遣 / 配置未定 / 当社社員
    const isDispatch = this.isDispatchName(a.emp_name);
    const isPlaceholder = this.isPlaceholderName(a.emp_name);

    if (isDispatch) {
      // 派遣社員：派遣固定（変更不可）
      roleSel.innerHTML = '<option value="派遣" selected>派遣</option>';
      roleSel.value = '派遣';
      roleSel.disabled = true;
    } else if (isPlaceholder) {
      // 配置未定・不足：3択（派遣枠を未定として確保するケースも許可）
      roleSel.disabled = false;
      roleSel.innerHTML =
        '<option value="主任技術者">主任技術者</option>' +
        '<option value="副監督">副監督</option>' +
        '<option value="派遣">派遣</option>';
      roleSel.value = ['主任技術者', '副監督', '派遣'].includes(normRole) ? normRole : '副監督';
    } else {
      // 当社社員：主任技術者 / 副監督
      roleSel.disabled = false;
      roleSel.innerHTML =
        '<option value="主任技術者">主任技術者</option>' +
        '<option value="副監督">副監督</option>';
      roleSel.value = (normRole === '主任技術者') ? '主任技術者' : '副監督';
    }

    document.getElementById('edit-note').value = a.override_note || '';
    document.getElementById('edit-status').textContent = '';
    document.getElementById('gantt-modal-edit').classList.remove('hidden');
    document.getElementById('gantt-modal-edit-btn').classList.add('hidden');
    document.getElementById('gantt-modal-save-btn').classList.remove('hidden');
    document.getElementById('gantt-modal-cancel-btn').classList.remove('hidden');
    // 配属解除は表示モード専用 → 編集モードでは隠す
    document.getElementById('gantt-modal-remove-btn').classList.add('hidden');
    // 「元値に戻す」は編集モードに置く（保存の隣・変更済みのときのみ）
    document.getElementById('gantt-modal-reset-btn').classList.toggle('hidden',
      !(Sync.canEdit() && this.currentAssignment && this.currentAssignment.overridden));
  },

  // 表示モードに戻す
  exitEditMode() {
    document.getElementById('gantt-modal-edit').classList.add('hidden');
    document.getElementById('gantt-modal-save-btn').classList.add('hidden');
    document.getElementById('gantt-modal-cancel-btn').classList.add('hidden');
    // 「元値に戻す」は編集モード専用 → 表示モードでは隠す
    document.getElementById('gantt-modal-reset-btn').classList.add('hidden');
    if (Sync.canEdit()) {
      document.getElementById('gantt-modal-edit-btn').classList.remove('hidden');
      // 配属解除は表示モードに置く（編集するの隣）
      document.getElementById('gantt-modal-remove-btn').classList.remove('hidden');
    } else {
      document.getElementById('gantt-modal-remove-btn').classList.add('hidden');
    }
  },

  // 保存（GAS へ upsert POST）
  async saveEdit() {
    const a = this.currentAssignment;
    if (!a) return;
    const join = document.getElementById('edit-join').value;
    const end = document.getElementById('edit-end').value;
    const role = document.getElementById('edit-role').value;
    const note = document.getElementById('edit-note').value;
    const prep = document.getElementById('edit-prep-start').value;
    const statusEl = document.getElementById('edit-status');

    if (!join && !end) {
      statusEl.textContent = '⚠ 開始日か終了日のいずれかは入力してください';
      statusEl.className = 'text-xs text-red-600';
      return;
    }
    if (join && end && join > end) {
      statusEl.textContent = '⚠ 終了日は開始日より後にしてください';
      statusEl.className = 'text-xs text-red-600';
      return;
    }
    if (prep && !join) {
      statusEl.textContent = '⚠ 準備期間を使うには配属開始日を入力してください';
      statusEl.className = 'text-xs text-red-600';
      return;
    }
    if (prep && join && prep >= join) {
      statusEl.textContent = '⚠ 準備期間開始日は配属開始日より前にしてください';
      statusEl.className = 'text-xs text-red-600';
      return;
    }

    statusEl.textContent = '保存中…';
    statusEl.className = 'text-xs text-slate-500';
    const saveBtn = document.getElementById('gantt-modal-save-btn');
    saveBtn.disabled = true;

    // Salesforce 由来表記（YYYY/MM/DD）に統一して保存
    const toSlash = s => Util.toSlash(s);
    const joinSlash = toSlash(join);
    const endSlash = toSlash(end);
    const prepSlash = toSlash(prep);  // 空欄なら '' ＝ 準備期間クリア

    // op 判定：source=override_add だった場合は add のまま、そうでなければ update
    const op = (a.source === 'override_add' || a.override_op === 'add') ? 'add' : 'update';

    try {
      // 配置未定・不足は emp_name 固定 + override_key に役割含み → assignmentに保存済みのkeyを優先
      const overrideKey = a.override_key || Sync.buildOverrideKey(a.emp_name, a.project_id);
      const payload = {
        action: 'upsert',
        op,
        override_key: overrideKey,
        emp_name: a.emp_name,
        project_id: a.project_id,
        join_date: joinSlash,
        planned_end: endSlash,
        prep_start: prepSlash,
        role: role || a.role || '',
        note: note,
        updated_by: 'web',
      };
      const result = await Sync.postOverride(payload);

      // ローカル assignments を即時更新（表記統一済み）
      if (joinSlash) a.join = joinSlash;
      if (endSlash) a.planned_end = endSlash;
      if (role) a.role = role;
      a.prep_start = prepSlash;  // 空欄なら準備期間クリア
      a.overridden = true;
      a.override_note = note;
      a.override_op = op;
      // キャッシュにも反映（同一参照なので不要だが念のため）
      const cached = Sync.cache.assignment_overrides || [];
      const idx = cached.findIndex(r => String(r.override_key) === String(overrideKey));
      const row = {
        override_key: overrideKey,
        emp_name: a.emp_name,
        project_id: a.project_id,
        join_date: joinSlash,
        planned_end: endSlash,
        prep_start: prepSlash,
        role: a.role || '',
        note: note,
        updated_at: new Date().toISOString(),
        updated_by: 'web',
      };
      if (idx >= 0) cached[idx] = row; else cached.push(row);
      Sync.cache.assignment_overrides = cached;

      statusEl.textContent = `✓ 保存しました（${result.action || 'ok'}）`;
      statusEl.className = 'text-xs text-emerald-600';
      this.refresh();
      // ダッシュボード側も再描画（現在の配置テーブルに反映）
      if (typeof DashboardView !== 'undefined' && typeof DashboardView.render === 'function') {
        DashboardView.render();
      }

      // 0.8秒後に編集モードを閉じる
      setTimeout(() => this.exitEditMode(), 800);
      // 同じ assignment を再表示してバッジ更新
      setTimeout(() => this.showAssignmentModal(a.assignment_id), 850);
    } catch (e) {
      console.error('保存失敗:', e);
      statusEl.textContent = '× 保存失敗: ' + (e.message || e);
      statusEl.className = 'text-xs text-red-600';
    } finally {
      saveBtn.disabled = false;
    }
  },

  // 配属解除（op=remove で論理削除）
  // - SF 由来：assignment_overrides に op=remove で記録 → マージ時に除外
  // - override_add 由来：override 行を物理削除すれば元に戻る（addが消える）
  async removeAssignment() {
    const a = this.currentAssignment;
    if (!a) return;
    const isAddSource = (a.source === 'override_add' || a.override_op === 'add');
    const msg = isAddSource
      ? `「${a.emp_name}」の追加配置を取り消しますか？`
      : `「${a.emp_name}」を「${a.project_name}」の配属から外しますか？\n（Salesforceで再同期しても解除状態が保持されます）`;
    if (!confirm(msg)) return;

    const statusEl = document.getElementById('edit-status');
    statusEl.textContent = '配属解除中…';
    statusEl.className = 'text-xs text-slate-500';

    try {
      // assignment 内に override_key が保存されている場合（add/update由来）はそれを優先
      const overrideKey = a.override_key || Sync.buildOverrideKey(a.emp_name, a.project_id);
      if (isAddSource) {
        // add 由来：物理削除
        await Sync.postOverride({ action: 'delete', override_key: overrideKey });
      } else {
        // SF 由来：op=remove で論理削除
        await Sync.postOverride({
          action: 'upsert',
          op: 'remove',
          override_key: overrideKey,
          emp_name: a.emp_name,
          project_id: a.project_id,
          note: document.getElementById('edit-note').value || '',
          updated_by: 'web',
        });
      }

      if (typeof App !== 'undefined' && typeof App.loadData === 'function') {
        await App.loadData();
      }
      document.getElementById('gantt-modal').classList.add('hidden');
    } catch (e) {
      console.error('配属解除失敗:', e);
      statusEl.textContent = '× 解除失敗: ' + (e.message || e);
      statusEl.className = 'text-xs text-red-600';
    }
  },

  // override を削除して Salesforce 元値に戻す
  async resetOverride() {
    const a = this.currentAssignment;
    if (!a || !a.overridden) return;
    if (!confirm('この配属の変更を取り消し、Salesforce 元値に戻しますか？')) return;

    try {
      // assignment 内の override_key を優先利用（配置未定・不足の役割付きキー対応）
      const overrideKey = a.override_key || Sync.buildOverrideKey(a.emp_name, a.project_id);
      console.log('[resetOverride] 削除対象 override_key:', overrideKey);
      console.log('[resetOverride] cache 内の override 行:',
        (Sync.cache.assignment_overrides || []).map(r => ({
          override_key: r.override_key,
          emp_name: r.emp_name,
          project_id: r.project_id,
        }))
      );

      try {
        const result = await Sync.postOverride({ action: 'delete', override_key: overrideKey });
        console.log('[resetOverride] 削除結果:', result);
      } catch (e) {
        // not_found = Sheets 側に既に行が無い。UI は元に戻していい
        if (/not_found/.test(String(e.message))) {
          console.warn('[resetOverride] Sheets 側に該当行なし。UIのみ復元します。', e.message);
        } else {
          throw e;
        }
      }

      // overrides キャッシュから削除（emp_name と project_id でも保険）
      Sync.cache.assignment_overrides = (Sync.cache.assignment_overrides || [])
        .filter(r => {
          const rk = String(r.override_key || '');
          const rkAlt = Sync.buildOverrideKey(r.emp_name, r.project_id);
          return rk !== String(overrideKey) && rkAlt !== overrideKey;
        });

      // 元に戻すには Salesforce 元値の再取り込みが必要 → 再同期トリガ
      if (typeof App !== 'undefined' && typeof App.loadData === 'function') {
        await App.loadData();
      } else {
        // 再同期できなければ少なくともフラグだけ落とす
        delete a.overridden;
        delete a.override_note;
        this.refresh();
      }

      document.getElementById('gantt-modal').classList.add('hidden');
    } catch (e) {
      console.error('リセット失敗:', e);
      alert('リセット失敗: ' + (e.message || e) + '\n\nF12 → Console タブのログを確認してください。');
    }
  },

  // ===== プロジェクト状態 override（completed フラグの手動上書き）=====

  // 状態変更モーダルを開く
  openProjectStatusModal(projectId) {
    const proj = (Sync.cache.projects || []).find(p => p.project_id === projectId);
    if (!proj) return;
    const modal = document.getElementById('project-status-modal');
    if (!modal) return;
    this._editingStatusProjectId = projectId;

    document.getElementById('project-status-name').textContent = proj.name + (proj.contract_type ? `（${proj.contract_type}）` : '');
    document.getElementById('project-status-meta').textContent =
      `${proj.project_id} / 工期 ${proj.start || '-'}〜${proj.end || '-'} / ${proj.dept || '-'}`;
    const currentLabel = proj.completed ? '完成' : '進行中';
    const overrideNote = proj._status_overridden ? '（手動で上書き中）' : '（自動判定）';
    document.getElementById('project-status-current').textContent = `${currentLabel} ${overrideNote}`;

    // ラジオの初期選択：状態 override 中はその値、未 override は「自動判定」を選択
    const radios = document.getElementsByName('project-status-radio');
    radios.forEach(r => {
      if (proj._status_overridden) {
        r.checked = (r.value === (proj.completed ? 'completed' : 'in_progress'));
      } else {
        r.checked = (r.value === 'auto');
      }
    });

    // 管轄事務所セレクタ：既存の全事務所（工事の管轄＋監督の所属）から選択肢を生成
    const deptSel = document.getElementById('project-status-dept');
    if (deptSel) {
      const offices = new Set();
      (Sync.cache.projects || []).forEach(p => { const d = String(p.dept || '').trim(); if (d) offices.add(d); });
      (Sync.cache.employees || []).forEach(e => { const d = String(e.department || '').trim(); if (d) offices.add(d); });
      const sorted = Array.from(offices).sort((a, b) => a.localeCompare(b, 'ja'));
      deptSel.innerHTML = '<option value="">自動（Salesforce元値）</option>' +
        sorted.map(d => `<option value="${this.esc(d)}">${this.esc(d)}</option>`).join('');
      // 事務所 override 中はその値を選択、未 override は「自動」
      deptSel.value = proj._dept_overridden ? (proj.dept || '') : '';
    }

    const errEl = document.getElementById('project-status-error');
    if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
    modal.classList.remove('hidden');
  },

  // 状態変更モーダルの保存
  async saveProjectStatus() {
    const pid = this._editingStatusProjectId;
    if (!pid) return;
    const radios = document.getElementsByName('project-status-radio');
    let value = 'auto';
    radios.forEach(r => { if (r.checked) value = r.value; });
    const deptSel = document.getElementById('project-status-dept');
    const dept = deptSel ? deptSel.value : '';
    const errEl = document.getElementById('project-status-error');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };

    // 状態を文字列に（auto＝状態は上書きしない）
    const completed = value === 'completed' ? 'true' : value === 'in_progress' ? 'false' : '';

    const saveBtn = document.getElementById('project-status-save');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    try {
      if (completed === '' && dept === '') {
        // 状態も事務所も自動 → override 行を削除
        await Sync.postOverride({ action: 'project_status_delete', project_id: pid });
      } else {
        await Sync.postOverride({
          action: 'project_status_upsert',
          project_id: pid,
          completed: completed,   // '' なら状態は自動
          dept: dept,             // '' なら管轄事務所は自動
          updated_by: 'web',
        });
      }
      // GAS書込み後に全体再同期（projects は salesforce_imports から再派生 → override 再適用）
      await Sync.syncAll();
      document.getElementById('project-status-modal').classList.add('hidden');
      this.refresh();
      // 監督ダッシュボードが定義されていれば再描画（同じ状態 override を反映）
      if (typeof DashboardView !== 'undefined' && typeof DashboardView.render === 'function') {
        try { DashboardView.render(); } catch (e) { console.warn('Dashboard 再描画失敗:', e); }
      }
    } catch (e) {
      showErr('保存失敗: ' + (e.message || e));
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  },
});
