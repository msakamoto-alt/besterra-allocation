/**
 * dashboard.js - 監督ダッシュボード（個人ビュー）
 */

const DashboardView = {
  // Point2: 値が入ると「その社員番号の監督1名のみ」表示（閲覧者＝自分のみ）。null で全員閲覧可。
  restrictEmpId: null,

  init() {
    document.getElementById('dash-select').addEventListener('change', () => this.render());

    // 検索ボックス：入力ごとに絞り込み
    document.getElementById('dash-search').addEventListener('input', () => {
      this.populateSelect();
      this.render();
    });

    // 「現在の配置」行クリックでガント詳細モーダルを開く（編集UI共通化）
    document.getElementById('dash-content').addEventListener('click', async (e) => {
      // 不在の追加（行クリックより優先）
      const absAdd = e.target.closest('#dash-abs-add');
      if (absAdd) {
        e.stopPropagation();
        await this.addAbsenceFromForm(absAdd.dataset.emp);
        return;
      }
      // 不在の修正モードへ切替（✎）
      const absEdit = e.target.closest('.dash-abs-edit');
      if (absEdit) {
        e.stopPropagation();
        const row = absEdit.closest('.dash-abs-row');
        if (row) {
          row.querySelector('.dash-abs-disp').classList.add('hidden');
          row.querySelector('.dash-abs-editrow').classList.remove('hidden');
        }
        return;
      }
      // 不在の修正キャンセル
      const absCancel = e.target.closest('.dash-abs-cancel');
      if (absCancel) {
        e.stopPropagation();
        const row = absCancel.closest('.dash-abs-row');
        if (row) {
          row.querySelector('.dash-abs-editrow').classList.add('hidden');
          row.querySelector('.dash-abs-disp').classList.remove('hidden');
        }
        return;
      }
      // 不在の修正を保存
      const absSave = e.target.closest('.dash-abs-save');
      if (absSave) {
        e.stopPropagation();
        await this.saveAbsenceEdit(absSave);
        return;
      }
      // 不在の削除
      const absDel = e.target.closest('.dash-abs-del');
      if (absDel) {
        e.stopPropagation();
        if (!confirm('この不在予定を削除しますか？')) return;
        absDel.disabled = true;
        try {
          await Sync.deleteAbsence(parseInt(absDel.dataset.id, 10));
          if (typeof App !== 'undefined' && App.loadData) await App.loadData();
        } catch (err) {
          alert('不在の削除に失敗しました: ' + (err.message || err));
          absDel.disabled = false;
        }
        return;
      }
      // 状態変更ボタン（行クリックより優先）
      const statusBtn = e.target.closest('.dash-status-edit');
      if (statusBtn) {
        e.stopPropagation();
        const pid = statusBtn.dataset.projectId;
        if (typeof GanttView !== 'undefined' && typeof GanttView.openProjectStatusModal === 'function') {
          GanttView.openProjectStatusModal(pid);
        }
        return;
      }
      const tr = e.target.closest('tr[data-asg-id]');
      if (!tr) return;
      const asgId = tr.dataset.asgId;
      if (typeof GanttView !== 'undefined' && typeof GanttView.showAssignmentModal === 'function') {
        GanttView.showAssignmentModal(asgId);
      }
    });

    // 稼働形態（監督派遣/事務所専従/構内専従）＋色帯期間の変更を保存
    document.getElementById('dash-content').addEventListener('change', async (e) => {
      const t = e.target.closest('#dash-workmode, #dash-workmode-start, #dash-workmode-end');
      if (!t) return;
      const modeSel = document.getElementById('dash-workmode');
      const empNo = (modeSel && modeSel.dataset.emp) || t.dataset.emp;
      const mode = modeSel ? modeSel.value : '';
      const start = (document.getElementById('dash-workmode-start') || {}).value || '';
      const end = (document.getElementById('dash-workmode-end') || {}).value || '';
      if (start && end && start > end) { alert('色帯期間の開始が終了より後になっています'); return; }
      const inputs = ['dash-workmode', 'dash-workmode-start', 'dash-workmode-end']
        .map(id => document.getElementById(id)).filter(Boolean);
      inputs.forEach(el => el.disabled = true);
      try {
        await Sync.setEmployeeWorkMode(empNo, mode, start, end);
        if (typeof App !== 'undefined' && App.loadData) await App.loadData();  // 再同期→全ビュー再描画
      } catch (err) {
        alert('稼働形態の保存に失敗しました: ' + (err.message || err));
        inputs.forEach(el => el.disabled = false);
      }
    });
  },

  // 配置編集後に呼ばれる：選択中の監督の現在配置を再描画
  refreshCurrentEmployee() {
    this.render();
  },

  refresh() {
    this.applyRestrictionUI();
    this.populateSelect();
    this.render();
  },

  // 自分の監督ダッシュボードへフォーカス（社員番号で選択し描画）。app.js のログイン着地から呼ぶ。
  focusEmployee(empNo) {
    this.applyRestrictionUI();
    this.populateSelect();
    if (empNo != null && empNo !== '') {
      const match = (Sync.cache.employees || []).find(e =>
        String(e.id) === String(empNo) || String(e.emp_no) === String(empNo));
      if (match) document.getElementById('dash-select').value = String(match.id);
    }
    this.render();
  },

  // 閲覧制限（閲覧者＝自分のみ）のとき、監督セレクタ行を隠す
  applyRestrictionUI() {
    const search = document.getElementById('dash-search');
    const controls = search && search.parentElement;   // 「監督を選択」行
    if (controls) controls.style.display = this.restrictEmpId ? 'none' : '';
  },

  // セレクトボックスを社員番号順 + 検索フィルタで再構築
  populateSelect() {
    let all = (Sync.cache.employees || [])
      .filter(e => e.category === '現場監督' || e.category === '準現場監督')
      .slice()
      .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));

    // Point2: 閲覧制限中は自分（社員番号一致）の1名だけに絞る
    if (this.restrictEmpId) {
      all = all.filter(e => String(e.id) === String(this.restrictEmpId) || String(e.emp_no) === String(this.restrictEmpId));
    }

    const search = (document.getElementById('dash-search').value || '').trim().toLowerCase();
    const filtered = search
      ? all.filter(e =>
          String(e.id).toLowerCase().includes(search) ||
          (e.name || '').toLowerCase().includes(search) ||
          (e.name || '').replace(/\s+/g, '').toLowerCase().includes(search) ||
          (e.department || '').toLowerCase().includes(search)
        )
      : all;

    const sel = document.getElementById('dash-select');
    const current = sel.value;
    sel.innerHTML = filtered.map(e =>
      `<option value="${e.id}">${this.esc(e.id)}  ${this.esc(e.name)}  (${this.esc(e.department || '-')} / ${this.esc(e.category)})</option>`
    ).join('');

    // 現在選択中の人が結果に残るなら維持
    if (current && filtered.some(e => String(e.id) === current)) sel.value = current;

    const cntEl = document.getElementById('dash-select-count');
    if (cntEl) cntEl.textContent = `${filtered.length}名`;
  },

  render() {
    const sel = document.getElementById('dash-select');
    const empId = parseInt(sel.value);
    if (!empId) {
      const msg = this.restrictEmpId
        ? 'あなたのアカウントに紐付く監督データが見つかりません。<br>社員番号の紐付けを管理者にご確認ください。'
        : '監督を選択してください';
      document.getElementById('dash-content').innerHTML = `<p class="text-slate-500">${msg}</p>`;
      return;
    }
    const emp = (Sync.cache.employees || []).find(e => e.id === empId);
    if (!emp) return;

    // 全配置を取得して分類（active / past / future）
    const allAsgs = (Sync.cache.assignments || []).filter(a => a.emp_id === empId);
    const todayD = new Date();
    todayD.setHours(0, 0, 0, 0);
    const parseEnd = a => a.planned_end ? new Date(String(a.planned_end).replace(/\//g, '-')) : null;
    const parseStart = a => a.join ? new Date(String(a.join).replace(/\//g, '-')) : null;

    const asgs = allAsgs.filter(a => !a.completed && Sync.isActiveAssignment(a));
    const pastAsgs = allAsgs.filter(a => {
      if (a.prospect) return false;  // 見込みは過去扱いしない
      if (a.completed) return true;
      const end = parseEnd(a);
      return end && !isNaN(end) && end < todayD;
    }).sort((x, y) => {
      // 終了日の新しい順
      const ex = parseEnd(x); const ey = parseEnd(y);
      const tx = ex && !isNaN(ex) ? ex.getTime() : 0;
      const ty = ey && !isNaN(ey) ? ey.getTime() : 0;
      return ty - tx;
    });

    // G工番：先月の実データ集計（g_work_logs シートから）
    const prevYm = Sync.previousYearMonthKey();
    const gSummary = Sync.computeGSummaryForEmployee(empId, prevYm);
    const [prevY, prevM] = prevYm.split('-');
    const prevMonthLabel = `${Number(prevY)}年${Number(prevM)}月`;

    // 保有資格（段階Q: SmartHR詳細 emp.qual_details を種別ごとに表示＋期限アラート）
    const qualDetails = (emp.qual_details || []);
    const now = new Date();

    const canEdit = Sync.canEdit();
    // projects マップ（現在配置・過去配置の両方で参照）
    const projectsMap0 = {};
    (Sync.cache.projects || []).forEach(p => { projectsMap0[p.project_id] = p; });
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
        // プロジェクト状態バッジ（completed / 状態 override 中）
        const proj = projectsMap0[a.project_id] || {};
        const statusBadge = proj._status_overridden
          ? `<span class="ml-2 ${proj.completed ? 'bg-slate-200 text-slate-700' : 'bg-blue-100 text-blue-700'} px-1.5 py-0.5 rounded text-[10px]" title="手動で状態を上書き中">${proj.completed ? '完成' : '進行中'}</span>`
          : (proj.completed ? '<span class="ml-2 bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded text-[10px]">完成</span>' : '');
        const statusEditLink = canEdit
          ? `<button class="dash-status-edit ml-2 text-slate-500 hover:text-slate-900 text-[11px] underline" data-project-id="${this.esc(a.project_id)}" title="案件の修正（状態・管轄事務所）">修正</button>`
          : '';
        const editLink = canEdit
          ? '<td class="p-2 text-center"><span class="text-blue-600 text-xs underline">期間を変更</span></td>'
          : '';
        const rowClass = canEdit
          ? 'border-t hover:bg-blue-50 cursor-pointer'
          : 'border-t';
        const titleAttr = canEdit ? ' title="クリックして配属期間を変更"' : '';
        const dispRole = Sync.normalizeRole ? Sync.normalizeRole(a.role) : a.role;
        asgTbl += `<tr class="${rowClass}" data-asg-id="${this.esc(a.assignment_id)}"${titleAttr}>` +
          `<td class="p-2">${this.esc(a.project_name)}${overrideMark}${statusBadge}${statusEditLink}</td>` +
          `<td class="p-2 text-center">${this.esc(dispRole)}</td>` +
          `<td class="p-2 text-center text-xs">${this.fmtDate(a.join)}</td>` +
          `<td class="p-2 text-center text-xs">${this.fmtDate(a.planned_end)}</td>` +
          editLink +
          '</tr>';
      });
      asgTbl += '</tbody></table>';
    }

    // ===== 過去の配置（経験現場一覧）=====
    const projectsMap = {};
    (Sync.cache.projects || []).forEach(p => { projectsMap[p.project_id] = p; });

    // 役割別カウント（旧表記「支援」「視察」を「応援」に正規化）
    const projsById = {};
    (Sync.cache.projects || []).forEach(p => { projsById[p.project_id] = p; });
    const roleOf = (a) => {
      const norm = Sync.normalizeRole ? Sync.normalizeRole(a.role) : a.role;
      const proj = projsById[a.project_id];
      if (proj && String(proj.contract_type || '').includes('元請') && norm === '主任技術者') return '監理技術者';
      return norm;
    };
    const roleCount = {};
    pastAsgs.forEach(a => {
      const r = roleOf(a);
      roleCount[r] = (roleCount[r] || 0) + 1;
    });
    // 重複現場除外したユニーク数
    const uniqProjectIds = new Set(pastAsgs.map(a => a.project_id));

    let pastTbl = '';
    if (pastAsgs.length === 0) {
      pastTbl = '<p class="text-slate-400 text-sm">過去の配置データがありません</p>';
    } else {
      // 役割別カウントチップ（旧「支援」「視察」は「応援」に正規化済み）
      const ROLE_ORDER = ['主任技術者', '監理技術者', '副監督', '応援'];
      const chips = ROLE_ORDER
        .filter(r => roleCount[r])
        .map(r => `<span class="inline-block bg-slate-100 border border-slate-300 px-2 py-0.5 rounded text-xs mr-2">${this.esc(r)} <b>${roleCount[r]}</b>件</span>`)
        .join('');
      const otherRoles = Object.keys(roleCount).filter(r => !ROLE_ORDER.includes(r));
      const otherChips = otherRoles
        .map(r => `<span class="inline-block bg-slate-100 border border-slate-300 px-2 py-0.5 rounded text-xs mr-2">${this.esc(r)} <b>${roleCount[r]}</b>件</span>`)
        .join('');

      pastTbl = '<div class="mb-3 text-sm flex flex-wrap items-center gap-y-1">' +
        `<span class="text-slate-700 mr-3">経験現場 <b class="text-base">${uniqProjectIds.size}</b> 件 / 配置回数 <b>${pastAsgs.length}</b> 回</span>` +
        chips + otherChips +
      '</div>';

      pastTbl += '<div class="overflow-auto max-h-[420px] border rounded">';
      pastTbl += '<table class="w-full text-sm"><thead class="bg-slate-100 sticky top-0"><tr>' +
        '<th class="px-3 py-2 text-left">工事番号</th>' +
        '<th class="px-3 py-2 text-left">現場</th>' +
        '<th class="px-3 py-2">役割</th>' +
        '<th class="px-3 py-2">期間</th>' +
        '<th class="px-3 py-2 text-right">売上規模</th>' +
        '</tr></thead><tbody>';
      pastAsgs.forEach(a => {
        const proj = projectsMap[a.project_id] || {};
        const amountTxt = proj.amount > 0 ? Util.fmtMillions(proj.amount) : '-';
        // 期間：YYYY/M〜YYYY/M に省略
        const s = parseStart(a); const e = parseEnd(a);
        const fmtYM = d => d && !isNaN(d) ? `${d.getFullYear()}/${d.getMonth() + 1}` : '-';
        const periodTxt = `${fmtYM(s)} 〜 ${fmtYM(e)}`;
        const overrideMark = a.overridden
          ? '<span class="ml-1 bg-purple-100 text-purple-700 px-1 py-0 rounded text-[10px]">✎</span>'
          : '';
        // プロジェクト状態バッジ（過去配置でも override 状況は表示）
        const statusBadge = proj._status_overridden
          ? `<span class="ml-1 ${proj.completed ? 'bg-slate-200 text-slate-700' : 'bg-blue-100 text-blue-700'} px-1 py-0 rounded text-[10px]" title="手動で状態を上書き中">${proj.completed ? '完成' : '進行中'}</span>`
          : '';
        const statusEditLink = canEdit
          ? `<button class="dash-status-edit ml-1 text-slate-500 hover:text-slate-900 text-[10px] underline" data-project-id="${this.esc(a.project_id)}" title="案件の修正（状態・管轄事務所）">修正</button>`
          : '';
        const rowClass = canEdit
          ? 'border-t hover:bg-blue-50 cursor-pointer'
          : 'border-t';
        const titleAttr = canEdit ? ' title="クリックして配属期間を変更"' : '';
        pastTbl += `<tr class="${rowClass}" data-asg-id="${this.esc(a.assignment_id)}"${titleAttr}>` +
          `<td class="px-3 py-2 font-mono text-xs text-slate-500">${this.esc(a.project_id)}</td>` +
          `<td class="px-3 py-2">${this.esc(a.project_name)}${overrideMark}${statusBadge}${statusEditLink}</td>` +
          `<td class="px-3 py-2 text-center">${this.esc(roleOf(a))}</td>` +
          `<td class="px-3 py-2 text-center text-xs">${this.esc(periodTxt)}</td>` +
          `<td class="px-3 py-2 text-right text-xs">${this.esc(amountTxt)}</td>` +
          '</tr>';
      });
      pastTbl += '</tbody></table></div>';
    }

    // G工番カテゴリ内訳：時間が多い順にソート
    const gMaxHours = Math.max(...Object.values(gSummary.categories), 0);
    const sortedCats = Object.entries(gSummary.categories).sort((a, b) => b[1] - a[1]);
    let gHtml = '';
    if (sortedCats.length === 0) {
      gHtml = '<div class="col-span-5 text-center text-sm text-slate-400 py-4">この月のG工番ログはありません</div>';
    } else {
      sortedCats.forEach(([k, v]) => {
        const widthPct = gMaxHours > 0 ? (v / gMaxHours * 100) : 0;
        const pctOfG = gSummary.gHours > 0 ? (v / gSummary.gHours * 100) : 0;
        gHtml += '<div class="border rounded p-2">' +
          `<div class="text-xs text-slate-600">${this.esc(k)}</div>` +
          `<div class="text-lg font-bold mt-1">${v.toFixed(1)}<span class="text-xs font-normal text-slate-500">h</span></div>` +
          `<div class="text-[10px] text-slate-500">G工番内 ${pctOfG.toFixed(0)}%</div>` +
          `<div class="h-2 bg-slate-200 rounded mt-1"><div class="h-2 bg-blue-500 rounded" style="width:${widthPct}%"></div></div>` +
          '</div>';
      });
    }

    let qualHtml = '';
    if (qualDetails.length === 0) {
      qualHtml = '<p class="text-slate-400 text-sm">保有資格データなし</p>';
    } else {
      const STATUS_CLS = {
        expired: 'bg-red-100 text-red-800 font-bold',
        warn30: 'bg-orange-100 text-orange-800 font-medium',
        warn90: 'bg-amber-100 text-amber-800',
        ok: 'bg-emerald-50 text-emerald-800',
        none: 'bg-slate-100 text-slate-700',
        unknown: 'bg-slate-100 text-slate-700',
      };
      // 期限アラートのサマリー（対象＝技術者・登録系の更新資格のみ。職長教育・個人系は除外）
      const statuses = qualDetails.filter(d => Sync.isExpiryTracked(d.name)).map(d => Sync.qualExpiryStatus(d.expiry));
      const nExpired = statuses.filter(s => s.status === 'expired').length;
      const nWarn = statuses.filter(s => s.status === 'warn30' || s.status === 'warn90').length;
      let banner = '';
      if (nExpired || nWarn) {
        const parts = [];
        if (nExpired) parts.push(`<span class="text-red-700 font-bold">期限切れ ${nExpired}件</span>`);
        if (nWarn) parts.push(`<span class="text-amber-700 font-medium">期限間近 ${nWarn}件</span>`);
        banner = `<div class="mb-3 text-sm bg-red-50 border border-red-200 rounded px-3 py-2">⚠ ${parts.join(' / ')}<span class="text-xs text-slate-500 ml-2">（期限管理対象資格）</span></div>`;
      }
      // 種別ごとにグループ化（資格→技能講習→特別教育→その他）
      const byType = {};
      qualDetails.forEach(d => { (byType[d.type || 'その他'] = byType[d.type || 'その他'] || []).push(d); });
      const order = ['資格', '技能講習', '特別教育', 'その他'];
      const types = Object.keys(byType).sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'ja');
      });
      const groups = types.map(t => {
        const items = byType[t].map(d => {
          const tracked = Sync.isExpiryTracked(d.name);
          const st = Sync.qualExpiryStatus(d.expiry);
          const status = tracked ? st.status : 'none';    // 非対象は色を付けない
          const cls = STATUS_CLS[status] || STATUS_CLS.none;
          let exp = '';
          if (tracked && st.status !== 'none') {
            exp = ` <span class="text-[10px] opacity-80">(${st.status === 'expired' ? '⚠' : ''}${this.esc(st.label)})</span>`;
          } else if (d.expiry && d.expiry !== '期限なし') {
            exp = ` <span class="text-[10px] text-slate-400">(期限 ${this.esc(d.expiry)})</span>`;
          }
          const acq = d.acquired ? `<span class="text-[10px] text-slate-400 whitespace-nowrap">取得 ${this.esc(d.acquired)}</span>` : '';
          return `<div class="${cls} px-2 py-1 rounded text-xs flex items-center justify-between gap-2"><span>${this.esc(d.name)}${exp}</span>${acq}</div>`;
        }).join('');
        return `<div class="mb-3"><div class="text-xs font-semibold text-slate-500 mb-1">${this.esc(t)} <span class="text-slate-400">（${byType[t].length}）</span></div><div class="grid md:grid-cols-2 gap-1.5">${items}</div></div>`;
      }).join('');
      qualHtml = banner + groups;
    }

    // 施工管理技士タグ（qualifications_raw＝1級/2級 施工管理技士）を区分バッジの横に表示。
    // 1級＝インディゴ（上位）／2級＝スカイ（下位）で等級を色分け。
    const sekouClass = (t) => t.includes('1級')
      ? 'bg-indigo-100 text-indigo-800 border-indigo-300'
      : 'bg-sky-100 text-sky-700 border-sky-300';
    const sekouBadges = String(emp.qualifications_raw || '').split('、').map(s => s.trim()).filter(Boolean)
      .map(t => `<span class="${sekouClass(t)} border px-2 py-0.5 rounded text-xs font-medium">${this.esc(t)}</span>`).join('');

    // 稼働形態（監督派遣/事務所専従/構内専従）。canEdit はプルダウン、閲覧者は設定時のみバッジ表示。
    const WM = (typeof Sync !== 'undefined' && Sync.WORK_MODES) || {};
    let wmCtrl = '';
    if (canEdit) {
      const cur = emp.work_mode || '';
      const opts = [['', '通常（現場配置可）']].concat(Object.keys(WM).map(k => [k, WM[k].label]));
      const empKey = this.esc(emp.emp_no || emp.id);
      const isoS = this.toIsoDate(emp.work_mode_start);
      const isoE = this.toIsoDate(emp.work_mode_end);
      wmCtrl =
        '<div class="mt-3 pt-3 border-t">' +
          '<label class="text-xs text-slate-500 block mb-1">稼働形態</label>' +
          '<div class="flex flex-wrap items-center gap-2">' +
            `<select id="dash-workmode" data-emp="${empKey}" class="border rounded px-2 py-1 text-sm">` +
              opts.map(([v, l]) => `<option value="${this.esc(v)}"${v === cur ? ' selected' : ''}>${this.esc(l)}</option>`).join('') +
            '</select>' +
            '<span class="text-xs text-slate-500 ml-1">色帯期間</span>' +
            `<input type="date" id="dash-workmode-start" data-emp="${empKey}" value="${isoS}" class="border rounded px-2 py-1 text-sm">` +
            '<span class="text-xs text-slate-400">〜</span>' +
            `<input type="date" id="dash-workmode-end" data-emp="${empKey}" value="${isoE}" class="border rounded px-2 py-1 text-sm">` +
          '</div>' +
          '<div class="text-[11px] text-slate-400 mt-1">※「通常」以外はガントで色帯表示。期間を入れるとその期間だけ色帯（空欄＝全期間）。配置可否・空きには影響しません。</div>' +
        '</div>';
    } else if (Sync.isSpecialWorkMode && Sync.isSpecialWorkMode(emp.work_mode)) {
      const wm = WM[emp.work_mode];
      wmCtrl =
        '<div class="mt-3 pt-3 border-t text-sm">' +
          '<span class="text-slate-500 text-xs mr-2">稼働形態</span>' +
          `<span class="${wm.badge} px-2 py-0.5 rounded text-xs">${this.esc(wm.label)}</span>` +
        '</div>';
    }

    const absCtrl = this.absenceSectionHtml(emp, canEdit);

    document.getElementById('dash-content').innerHTML =
      '<div class="grid grid-cols-2 gap-4 mb-4">' +
        '<div class="bg-white rounded-lg shadow p-4">' +
          '<div class="text-sm text-slate-600">監督名</div>' +
          `<div class="text-xl font-bold mt-1">${this.esc(emp.name)}</div>` +
          `<div class="text-xs text-slate-500 mt-1">${this.esc(emp.department || '-')} / ${this.esc(emp.role || '一般')}</div>` +
          `<div class="mt-2 flex flex-wrap items-center gap-1.5">${PoolView.categoryBadge(emp.category)}${sekouBadges}</div>` +
        '</div>' +
        '<div class="bg-white rounded-lg shadow p-4">' +
          '<div class="text-sm text-slate-600">配置状況</div>' +
          `<div class="text-3xl font-bold mt-1">${asgs.length} <span class="text-base text-slate-500 font-normal">アクティブ</span></div>` +
          `<div class="text-xs text-slate-500 mt-1">経験現場 ${uniqProjectIds.size}件 / 過去 ${pastAsgs.length}回</div>` +
          wmCtrl +
          absCtrl +
        '</div>' +
      '</div>' +
      '<div class="bg-white rounded-lg shadow p-4 mb-4">' +
        '<h3 class="font-bold mb-3">現在の配置</h3>' + asgTbl +
      '</div>' +
      '<div class="bg-white rounded-lg shadow p-4 mb-4">' +
        '<h3 class="font-bold mb-3">過去の配置（経験現場一覧）</h3>' + pastTbl +
      '</div>' +
      '<div class="bg-white rounded-lg shadow p-4 mb-4">' +
        '<h3 class="font-bold mb-3">保有資格</h3>' + qualHtml +
      '</div>' +
      '<div class="bg-white rounded-lg shadow p-4">' +
        `<div class="flex items-baseline justify-between mb-3 flex-wrap gap-2">` +
          `<h3 class="font-bold">${this.esc(prevMonthLabel)} G工番カテゴリ内訳</h3>` +
          (gSummary.totalHours > 0
            ? `<div class="text-sm text-slate-600">` +
                `総勤務 <span class="font-bold text-slate-900">${gSummary.totalHours.toFixed(1)}h</span>` +
                ` / G工番 <span class="font-bold text-blue-700">${gSummary.gHours.toFixed(1)}h</span>` +
                ` = <span class="font-bold text-lg ${gSummary.gRatio >= 0.4 ? 'text-red-600' : gSummary.gRatio >= 0.25 ? 'text-amber-600' : 'text-emerald-700'}">${(gSummary.gRatio * 100).toFixed(1)}%</span>` +
              '</div>'
            : '<div class="text-sm text-slate-400">勤務データなし</div>') +
        '</div>' +
        `<div class="grid grid-cols-5 gap-2">${gHtml}</div>` +
        '<p class="text-xs text-slate-500 mt-3">※ G工番＝直接工事以外の時間（教育/会議/事務等）。配置自動化のロジックには使用しません（仕様書v4.0方針）。可視化のみ。</p>' +
      '</div>';
  },

  // 不在種別の <option> 群。selected を選択状態に。リスト外の旧種別（育休/産休等）は先頭に温存。
  absKindOptions(selected) {
    const base = (typeof Sync !== 'undefined' && Sync.ABSENCE_KINDS) || ['長期休暇', '休職', '産休・育休', 'その他'];
    const KINDS = (selected && base.indexOf(selected) < 0) ? [selected].concat(base) : base;
    return KINDS.map(k => `<option value="${this.esc(k)}"${k === selected ? ' selected' : ''}>${this.esc(k)}</option>`).join('');
  },

  // 不在予定セクション（カード内）。閲覧者は登録があれば一覧のみ・編集者は一覧＋追加フォーム＋行ごとの修正/削除。
  absenceSectionHtml(emp, canEdit) {
    const list = (emp.absences || []).slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const empKey = this.esc(emp.emp_no || emp.id);
    const rows = list.length
      ? list.map(a => {
          const period = `${this.esc(a.start || '')}${(a.start || a.end) ? '〜' : ''}${this.esc(a.end || '')}`;
          const noteDisp = a.note ? ` <span class="text-slate-400">（${this.esc(a.note)}）</span>` : '';
          const kindBadge = `<span class="bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded">${this.esc(a.kind || '不在')}</span>`;
          if (!canEdit) {
            return '<div class="flex items-center gap-2 text-xs py-1 border-b last:border-0">' +
              `${kindBadge}<span class="text-slate-600">${period}</span>${noteDisp}</div>`;
          }
          const idA = this.esc(a.id);
          // 表示モード＋編集モード（初期非表示）を1行に同梱。✎で切替。
          return `<div class="dash-abs-row border-b last:border-0 py-1" data-id="${idA}">` +
            '<div class="dash-abs-disp flex items-center gap-2 text-xs">' +
              `${kindBadge}<span class="text-slate-600">${period}</span>${noteDisp}<span class="flex-1"></span>` +
              `<button class="dash-abs-edit text-blue-600 hover:text-blue-800 text-sm" data-id="${idA}" title="修正">✎</button>` +
              `<button class="dash-abs-del text-rose-600 hover:text-rose-800 text-sm" data-id="${idA}" title="削除">🗑</button>` +
            '</div>' +
            '<div class="dash-abs-editrow hidden flex flex-wrap items-center gap-2 mt-1">' +
              `<select class="abs-e-kind border rounded px-2 py-1 text-sm">${this.absKindOptions(a.kind || '')}</select>` +
              `<input type="date" class="abs-e-start border rounded px-2 py-1 text-sm" value="${this.toIsoDate(a.start)}">` +
              '<span class="text-xs text-slate-400">〜</span>' +
              `<input type="date" class="abs-e-end border rounded px-2 py-1 text-sm" value="${this.toIsoDate(a.end)}">` +
              `<input type="text" class="abs-e-note border rounded px-2 py-1 text-sm" style="width:110px" value="${this.esc(a.note || '')}" placeholder="メモ">` +
              `<button class="dash-abs-save bg-slate-700 text-white px-2 py-1 rounded text-xs hover:bg-slate-800" data-id="${idA}">保存</button>` +
              '<button class="dash-abs-cancel text-slate-500 px-2 py-1 text-xs">キャンセル</button>' +
            '</div>' +
          '</div>';
        }).join('')
      : '<div class="text-xs text-slate-400">登録なし</div>';

    if (!canEdit) {
      if (!list.length) return '';   // 閲覧者は登録ゼロならカードを汚さない
      return '<div class="mt-3 pt-3 border-t">' +
        '<label class="text-xs text-slate-500 block mb-1">不在予定</label>' + rows + '</div>';
    }

    const addForm = '<div class="flex flex-wrap items-center gap-2 mt-2">' +
      `<select id="dash-abs-kind" class="border rounded px-2 py-1 text-sm">${this.absKindOptions('')}</select>` +
      '<input type="date" id="dash-abs-start" class="border rounded px-2 py-1 text-sm">' +
      '<span class="text-xs text-slate-400">〜</span>' +
      '<input type="date" id="dash-abs-end" class="border rounded px-2 py-1 text-sm">' +
      '<input type="text" id="dash-abs-note" placeholder="メモ（任意）" class="border rounded px-2 py-1 text-sm" style="width:120px">' +
      `<button id="dash-abs-add" data-emp="${empKey}" class="bg-slate-700 text-white px-3 py-1 rounded text-sm hover:bg-slate-800">＋追加</button>` +
      '</div>';
    return '<div class="mt-3 pt-3 border-t">' +
      '<label class="text-xs text-slate-500 block mb-1">不在予定（長期休暇・休職・産休育休等）</label>' +
      rows + addForm +
      '<div class="text-[11px] text-slate-400 mt-1">※ 監督軸・事務所モニターでグレーの網掛け帯（「産育休中 約6か月」等）。不在期間は「空き」表示を抑制します。</div>' +
      '</div>';
  },

  // 行ごとの修正フォームの値を読んで更新→再描画
  async saveAbsenceEdit(btn) {
    const row = btn.closest('.dash-abs-row');
    if (!row) return;
    const id = parseInt(btn.dataset.id, 10);
    const kind = (row.querySelector('.abs-e-kind') || {}).value || '';
    const start = (row.querySelector('.abs-e-start') || {}).value || '';
    const end = (row.querySelector('.abs-e-end') || {}).value || '';
    const note = (row.querySelector('.abs-e-note') || {}).value || '';
    if (!start && !end) { alert('開始日または終了日を入力してください'); return; }
    if (start && end && start > end) { alert('開始が終了より後になっています'); return; }
    btn.disabled = true;
    try {
      await Sync.updateAbsence(id, kind, start, end, note);
      if (typeof App !== 'undefined' && App.loadData) await App.loadData();
    } catch (err) {
      alert('不在の修正に失敗しました: ' + (err.message || err));
      btn.disabled = false;
    }
  },

  // 不在の追加フォームの値を読んで保存→再描画
  async addAbsenceFromForm(empNo) {
    const kind = (document.getElementById('dash-abs-kind') || {}).value || '';
    const start = (document.getElementById('dash-abs-start') || {}).value || '';
    const end = (document.getElementById('dash-abs-end') || {}).value || '';
    const note = (document.getElementById('dash-abs-note') || {}).value || '';
    if (!start && !end) { alert('開始日または終了日を入力してください'); return; }
    if (start && end && start > end) { alert('開始が終了より後になっています'); return; }
    const btn = document.getElementById('dash-abs-add');
    if (btn) btn.disabled = true;
    try {
      await Sync.addAbsence(empNo, kind, start, end, note);
      if (typeof App !== 'undefined' && App.loadData) await App.loadData();
    } catch (err) {
      alert('不在の登録に失敗しました: ' + (err.message || err));
      if (btn) btn.disabled = false;
    }
  },

  esc(text) { return Util.esc(text); },

  // 表記統一：'2025-07-31' / '2025/07/31' どちらも 'YYYY/MM/DD' で表示
  fmtDate(s) {
    if (!s) return '-';
    return this.esc(String(s).replace(/-/g, '/'));
  },

  // 'YYYY/MM/DD' や 'YYYY-MM-DD' → date input 用 'YYYY-MM-DD'（空は ''）
  toIsoDate(s) { return Util.toIsoDate(s); },
};
