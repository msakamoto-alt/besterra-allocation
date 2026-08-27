/**
 * gantt.js - 現場人員配置コア（状態・ツールバー・日付⇔px変換・描画プリミティブ）
 *
 * グローバル GanttView の本体。責務別モジュールが Object.assign(GanttView, {...}) で
 * メソッドを追加する構成（2026-07 刷新で分割）:
 *   js/views/gantt/modals.js  配置編集モーダル・案件状態モーダル
 *   js/views/gantt/axes.js    軸レンダラ5種・稼働形態/不在帯・事務所モニター
 * 読込順: gantt.js → gantt/modals.js → gantt/axes.js（board.js より前）。
 *
 * 全軸共通：
 * - バー色は役割（主任監督=濃青/副監督=シアン/支援=スレート/視察=ブラウン）
 * - バー内テキストに配置率(%)は表示しない
 * - 表示期間は displayStart 〜 displayEnd で制御
 * - 今日の縦赤線マーカー
 */

const GanttView = {
  currentAxis: 'project',
  expandedMonths: new Set(),

  // 表示期間（初期化時に設定）
  displayStart: null,
  displayEnd: null,

  // 完成工事の表示トグル（デフォルト：非表示）
  showCompleted: false,
  // 見込み案件の表示トグル（デフォルト：表示）
  showProspects: true,

  // 現場軸の並び替え（デフォルト：開始日・既定方向）
  // 既定方向はキーごとに自然な向き（PROJECT_SORTS.dir 参照）。reversed=true で反転
  currentProjectSort: 'start',
  currentProjectSortReversed: false,

  // 現場軸の検索（工事名・工事番号・客先の部分一致で絞り込み。空＝全表示）
  projectSearchQuery: '',

  // 監督軸・資格軸の検索（氏名・社員番号の部分一致で絞り込み。空＝全表示）
  supervisorSearchQuery: '',

  // 資格軸の区分フィルタ（複数選択可・既定は全表示＝従来どおり）
  qualCategoryFilter: new Set(['現場監督', '準現場監督', '監督サポート']),

  MONTH_WIDTH: 70,
  DAY_WIDTH: 26,
  LABEL_WIDTH: 300,
  BAR_HEIGHT: 22,
  BAR_GAP: 4,

  // Point4: 空き人員の可視化。今日以降、配置が無い連続期間がこの日数以上なら「空き」帯を表示。
  // 対象は通常稼働の監督のみ（派遣・専従は除外＝配置プール外）。
  GAP_MIN_DAYS: 30,

  // 役割→色（全軸共通）
  ROLE_COLOR: {
    '主任技術者': '#1e40af',
    '監理技術者': '#dc2626',  // 元請の主任技術者は赤（建設業法上の監理技術者）
    '副監督': '#0891b2',
    '派遣': '#ca8a04',  // 受け入れ派遣社員の役割（旧「応援」「支援」「視察」を統合）。視認性のため明るめの黄土色
  },

  // 配置未定・不足のバー色（点線描画）
  PLACEHOLDER_COLOR: '#cbd5e1',

  // 区分の色（資格軸の区分トグル・監督リストの階層カードと統一）
  CAT_COLOR: { '現場監督': '#0d9488', '準現場監督': '#d97706', '監督サポート': '#ea580c' },

  // 建設業法上、元請×下請外注合計5,000万円以上で監理技術者が必要。
  // 当システムは下請外注合計を持たないため、工事金額 ≥ 5,000万円 を proxy として使う
  // （工事金額4,500万円未満で下請外注合計5,000万円超になるケースは想定しないという業務判断）
  KANRI_AMOUNT_THRESHOLD: 50000000,

  // 元請の主任技術者を「監理技術者」として表示するための変換
  // 旧表記「支援」「視察」「応援」は「派遣」に正規化（normalizeRole）
  resolveRoleDisplay(assignment, project) {
    const isPrime = String(project && project.contract_type || '').includes('元請');
    const amount = Number(project && project.amount) || 0;
    const baseRole = Sync.normalizeRole ? Sync.normalizeRole(assignment.role) : (assignment.role || '');
    if (isPrime && amount >= this.KANRI_AMOUNT_THRESHOLD && baseRole === '主任技術者') {
      return { role: '監理技術者', color: this.ROLE_COLOR['監理技術者'] };
    }
    return { role: baseRole, color: this.ROLE_COLOR[baseRole] || '#ca8a04' };
  },

  // 派遣社員 / 配置未定 の判定
  // 派遣社員は内部的に "派遣社員 #N" 連番（override_key衝突回避）、表示時は "派遣社員" 固定
  isDispatchName(name) {
    return /^派遣社員(\s*#\d+)?$/.test(String(name || '').trim());
  },
  isPlaceholderName(name) {
    return String(name || '').trim() === '配置未定・不足';
  },

  // 表示用のemp_name（派遣社員は #N を除去して「派遣社員」固定）
  displayEmpName(name) {
    return this.isDispatchName(name) ? '派遣社員' : String(name || '');
  },

  // assignment の表示スタイル（色・点線・ラベル）を決定
  // 色 = 役割色（実線/点線とも同じ定義）
  // 点線 = 配置未定・不足のみ（不足人員の警告として一貫したセマンティクス）
  // → 「どの役割が不足しているか」が色で一目で分かる
  // 戻り値: { color, dashed, label, role }
  resolveBarStyle(a, p) {
    const isPlaceholder = this.isPlaceholderName(a.emp_name);
    const disp = this.resolveRoleDisplay(a, p);
    const label = this.displayEmpName(a.emp_name);
    if (isPlaceholder) {
      // 役割色の点線（主任技術者=濃青/副監督=シアン/派遣=黄褐色）
      return { color: disp.color, dashed: true, label, role: '配置未定・不足' };
    }
    return { color: disp.color, dashed: false, label, role: disp.role };
  },

  // 現場軸の並び替え定義
  // dir: 既定方向（'asc'=小→大、'desc'=大→小）。reversed フラグで反転する
  // key(p, assignmentsOfProject): 比較用の値を返す。欠損は null を返すと末尾に回る
  PROJECT_SORTS: {
    start:        { dir: 'asc',  key: (p) => p.start ? new Date(p.start).getTime() : null },
    end:          { dir: 'asc',  key: (p) => p.end   ? new Date(p.end).getTime()   : null },
    duration:     { dir: 'desc', key: (p) => (p.start && p.end) ? (new Date(p.end) - new Date(p.start)) : null },
    amount:       { dir: 'desc', key: (p) => (typeof p.amount === 'number' && !isNaN(p.amount)) ? p.amount : null },
    placeholders: { dir: 'desc', key: (p, asgs) => asgs.filter(a => GanttView.isPlaceholderName(a.emp_name)).length },
    members:      { dir: 'desc', key: (p, asgs) => asgs.filter(a => !GanttView.isPlaceholderName(a.emp_name)).length },
    contract:     { dir: 'asc',  key: (p) => {
      const ct = String(p.contract_type || '');
      if (ct.includes('元請')) return 0;
      if (ct.includes('下請')) return 1;
      return 2;
    }},
    dept:         { dir: 'asc',  key: (p) => {
      const d = String(p.dept || '');
      if (!d) return null;
      const order = ['東日本', '本社', '千葉', '京浜', '西日本', '倉敷', '九州'];
      for (let i = 0; i < order.length; i++) {
        if (d.includes(order[i])) return i;
      }
      return order.length;  // それ以外は末尾
    }},
    project_id:   { dir: 'asc',  key: (p) => p.project_id || null },
  },

  // 現場ソートの実方向（既定方向 × reversed）
  effectiveProjectSortDir() {
    const def = (this.PROJECT_SORTS[this.currentProjectSort] || {}).dir || 'asc';
    if (!this.currentProjectSortReversed) return def;
    return def === 'asc' ? 'desc' : 'asc';
  },

  // visibleProjects を currentProjectSort に従って安定ソート（タイブレーク=project_id 昇順）
  sortProjects(projects, assignments) {
    const def = this.PROJECT_SORTS[this.currentProjectSort];
    if (!def) return projects;
    const dir = this.effectiveProjectSortDir();
    const sign = dir === 'asc' ? 1 : -1;
    const asgByProject = new Map();
    (assignments || []).forEach(a => {
      const arr = asgByProject.get(a.project_id) || [];
      arr.push(a);
      asgByProject.set(a.project_id, arr);
    });
    // 配置未定・不足（実員ゼロ＝プレースホルダのみ/未配置）は並び替えに関係なく下に沈める
    const isUnstaffed = (p) => {
      const arr = asgByProject.get(p.project_id) || [];
      return !arr.some(a => !this.isPlaceholderName(a.emp_name));
    };
    const decorated = projects.map((p, idx) => ({
      p,
      idx,
      u: isUnstaffed(p) ? 1 : 0,
      v: def.key(p, asgByProject.get(p.project_id) || []),
    }));
    decorated.sort((a, b) => {
      // 配置未定・不足は常に末尾（選択中の並び替えに関係なく）
      if (a.u !== b.u) return a.u - b.u;
      // null は常に末尾
      if (a.v == null && b.v == null) return 0;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      if (a.v < b.v) return -1 * sign;
      if (a.v > b.v) return  1 * sign;
      // タイブレーク：project_id 昇順
      const ai = String(a.p.project_id || ''), bi = String(b.p.project_id || '');
      if (ai < bi) return -1;
      if (ai > bi) return  1;
      return a.idx - b.idx;
    });
    return decorated.map(d => d.p);
  },

  // 現場軸ソートUIの表示制御＋反転ボタンの矢印更新
  updateProjectSortToolbar() {
    const wrap = document.getElementById('gantt-project-sort-wrap');
    if (wrap) wrap.style.display = (this.currentAxis === 'project') ? '' : 'none';
    // 現場別PDF出力ボタンは現場軸のときだけ表示（本体は report.js exportProjectAxisPdf）
    const projectPdfBtn = document.getElementById('gantt-project-pdf-btn');
    if (projectPdfBtn) projectPdfBtn.style.display = (this.currentAxis === 'project') ? '' : 'none';
    const reverseBtn = document.getElementById('gantt-project-sort-reverse');
    if (reverseBtn) {
      reverseBtn.textContent = this.effectiveProjectSortDir() === 'asc' ? '↑' : '↓';
      reverseBtn.title = `現在: ${this.effectiveProjectSortDir() === 'asc' ? '昇順' : '降順'}（クリックで反転）`;
    }
    // 現場検索は現場軸・事務所軸で表示。✕ボタンは入力があるときだけ
    const searchWrap = document.getElementById('gantt-project-search-wrap');
    if (searchWrap) searchWrap.style.display = (this.currentAxis === 'project' || this.currentAxis === 'office') ? '' : 'none';
    const searchClear = document.getElementById('gantt-project-search-clear');
    if (searchClear) searchClear.classList.toggle('hidden', !String(this.projectSearchQuery || '').trim());
    // 監督検索は監督軸・資格軸で表示。✕ボタンは入力があるときだけ
    const supSearchWrap = document.getElementById('gantt-supervisor-search-wrap');
    if (supSearchWrap) supSearchWrap.style.display = (this.currentAxis === 'department' || this.currentAxis === 'qualification') ? '' : 'none';
    const supSearchClear = document.getElementById('gantt-supervisor-search-clear');
    if (supSearchClear) supSearchClear.classList.toggle('hidden', !String(this.supervisorSearchQuery || '').trim());
  },

  // 検索用の文字正規化：全角/半角ゆらぎ（ＡＢＣ→ABC等）を吸収し、大小文字・空白を無視
  normSearchText(s) {
    return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  },

  // 現場軸の検索絞り込み（工事名・工事番号・客先の部分一致）。件数表示も更新する
  applyProjectSearch(projects) {
    const q = this.normSearchText(this.projectSearchQuery);
    const hit = !q ? projects : projects.filter(p =>
      this.normSearchText(p.name).includes(q) ||
      this.normSearchText(p.project_id).includes(q) ||
      this.normSearchText(p.customer).includes(q));
    const cntEl = document.getElementById('gantt-project-search-count');
    if (cntEl) cntEl.textContent = q ? `${hit.length}/${projects.length}件` : '';
    return hit;
  },

  // 監督軸・資格軸の検索絞り込み（氏名・社員番号の部分一致）。件数表示も更新する
  applySupervisorSearch(employees) {
    const q = this.normSearchText(this.supervisorSearchQuery);
    const hit = !q ? employees : employees.filter(e =>
      this.normSearchText(e.name).includes(q) ||
      this.normSearchText(e.emp_no).includes(q));
    const cntEl = document.getElementById('gantt-supervisor-search-count');
    if (cntEl) cntEl.textContent = q ? `${hit.length}/${employees.length}件` : '';
    return hit;
  },

  // 資格軸の区分トグル：資格軸のときのみ表示し、選択状態を色で反映
  updateQualFilterToolbar() {
    const wrap = document.getElementById('gantt-qual-filter-wrap');
    if (wrap) wrap.style.display = (this.currentAxis === 'qualification') ? '' : 'none';
    document.querySelectorAll('.gantt-qual-cat-btn').forEach(btn => {
      const cat = btn.dataset.cat;
      const on = this.qualCategoryFilter.has(cat);
      const color = this.CAT_COLOR[cat] || '#64748b';
      btn.style.background = on ? color : '#ffffff';
      btn.style.color = on ? '#ffffff' : '#475569';
      btn.style.borderColor = on ? color : '#cbd5e1';
      btn.style.fontWeight = on ? '600' : '400';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  },

  // 元請/下請 バッジHTML
  contractBadge(contract_type) {
    const ct = String(contract_type || '').trim();
    if (ct.includes('元請')) return '<span class="inline-block bg-red-100 text-red-700 border border-red-300 px-1.5 py-0 rounded text-[10px] font-bold ml-1">元請</span>';
    if (ct.includes('下請')) return '<span class="inline-block bg-slate-100 text-slate-600 border border-slate-300 px-1.5 py-0 rounded text-[10px] ml-1">下請</span>';
    return '';
  },

  AXIS_DESC: {
    project: '縦軸＝現場、横軸＝配置期間（join〜leave）。配置監督ごとに個別バー表示。色は役割。',
    office: '縦軸＝事務所（CL営業管轄）ごとの管轄工事、横軸＝工期。各工事に配置監督のバーを表示。色は役割。',
    person: '縦軸＝現場監督（準現場監督含む）、横軸＝配置現場の期間。色は配置現場での役割。複数現場の配置はバー縦積み。',
    department: '縦軸＝事務所配下の監督（現場監督・準現場監督）、横軸＝配置現場の期間。色は役割。事務所別キャパが個人別に分かる。',
    qualification: '縦軸＝資格別の保有者、横軸＝配置現場の期間。色は役割。同一人複数資格は各グループに繰り返し表示。',
  },

  init() {
    // デフォルト期間：今年1月〜2年後の12月
    const now = new Date();
    this.displayStart = new Date(2026, 0, 1);  // 2026/1
    this.displayEnd = new Date(now.getFullYear() + 2, 11, 31);

    document.querySelectorAll('.gantt-axis-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentAxis = btn.dataset.axis;
        this.refresh();
      });
    });

    document.getElementById('gantt-container').addEventListener('click', (e) => {
      // 事務所モニターボタン → 別タブでその事務所だけのボードを開く
      const boardBtn = e.target.closest('[data-board-office]');
      if (boardBtn) {
        const office = boardBtn.getAttribute('data-board-office');
        window.open('?board=' + encodeURIComponent(office), '_blank');
        return;
      }
      // バークリック → 詳細モーダル
      const bar = e.target.closest('.gantt-bar[data-asg-id]');
      if (bar) {
        this.showAssignmentModal(bar.dataset.asgId);
        return;
      }
      // 「状態を変更」ボタン
      const statusBtn = e.target.closest('.gantt-status-edit');
      if (statusBtn) {
        const pid = statusBtn.dataset.projectId;
        this.openProjectStatusModal(pid);
        return;
      }
      // 「+ メンバー追加」ボタン
      const addBtn = e.target.closest('.gantt-add-member');
      if (addBtn) {
        const pid = addBtn.dataset.projectId;
        const proj = (Sync.cache.projects || []).find(p => p.project_id === pid);
        if (proj && typeof MemberAdd !== 'undefined') {
          const meta = [
            proj.contract_type || '-',
            proj.dept || '-',
            proj.prospect ? '見込み' : '受注済'
          ].join(' / ');
          MemberAdd.open({
            project_id: proj.project_id,
            project_name: proj.name,
            start: proj.start,
            end: proj.end,
            meta,
          });
        }
        return;
      }
      // 月ヘッダクリック → 月⇄日ドリルダウン
      const th = e.target.closest('[data-month-key]');
      if (!th) return;
      const key = th.dataset.monthKey;
      if (this.expandedMonths.has(key)) this.expandedMonths.delete(key);
      else this.expandedMonths.add(key);
      this.refresh();
    });

    // モーダル閉じる
    const modal = document.getElementById('gantt-modal');
    const closeFn = () => { modal.classList.add('hidden'); this.exitEditMode(); };
    document.getElementById('gantt-modal-close').addEventListener('click', closeFn);
    document.getElementById('gantt-modal-close-btn').addEventListener('click', closeFn);
    Util.bindModalClose(modal, closeFn);

    // 編集モード切替
    document.getElementById('gantt-modal-edit-btn').addEventListener('click', () => this.enterEditMode());
    document.getElementById('gantt-modal-cancel-btn').addEventListener('click', () => this.exitEditMode());
    document.getElementById('gantt-modal-save-btn').addEventListener('click', () => this.saveEdit());
    document.getElementById('gantt-modal-reset-btn').addEventListener('click', () => this.resetOverride());
    document.getElementById('gantt-modal-remove-btn').addEventListener('click', () => this.removeAssignment());

    // 期間フィルタ
    const startInput = document.getElementById('gantt-start');
    const endInput = document.getElementById('gantt-end');
    startInput.value = this.formatMonth(this.displayStart);
    endInput.value = this.formatMonth(this.displayEnd);
    startInput.addEventListener('change', () => {
      if (startInput.value) {
        const [y, m] = startInput.value.split('-').map(Number);
        this.displayStart = new Date(y, m - 1, 1);
        this.refresh();
      }
    });
    endInput.addEventListener('change', () => {
      if (endInput.value) {
        const [y, m] = endInput.value.split('-').map(Number);
        this.displayEnd = new Date(y, m, 0);
        this.refresh();
      }
    });

    // 今日ボタン
    document.getElementById('gantt-today').addEventListener('click', () => {
      this.scrollToToday();
    });

    // 期間リセット
    document.getElementById('gantt-reset').addEventListener('click', () => {
      this.displayStart = new Date(2026, 0, 1);
      this.displayEnd = new Date(new Date().getFullYear() + 2, 11, 31);
      this.expandedMonths.clear();
      startInput.value = this.formatMonth(this.displayStart);
      endInput.value = this.formatMonth(this.displayEnd);
      this.refresh();
    });

    // 完成工事トグル
    const showCompletedCb = document.getElementById('gantt-show-completed');
    if (showCompletedCb) {
      showCompletedCb.checked = this.showCompleted;
      showCompletedCb.addEventListener('change', () => {
        this.showCompleted = showCompletedCb.checked;
        this.refresh();
      });
    }

    // 見込み案件トグル
    const showProspectsCb = document.getElementById('gantt-show-prospects');
    if (showProspectsCb) {
      showProspectsCb.checked = this.showProspects;
      showProspectsCb.addEventListener('change', () => {
        this.showProspects = showProspectsCb.checked;
        this.refresh();
      });
    }

    // 現場軸 並び替えセレクタ
    const sortSelect = document.getElementById('gantt-project-sort');
    if (sortSelect) {
      sortSelect.value = this.currentProjectSort;
      sortSelect.addEventListener('change', () => {
        this.currentProjectSort = sortSelect.value;
        this.currentProjectSortReversed = false;  // キー変更時は既定方向に戻す
        this.updateProjectSortToolbar();
        this.refresh();
      });
    }
    const sortReverseBtn = document.getElementById('gantt-project-sort-reverse');
    if (sortReverseBtn) {
      sortReverseBtn.addEventListener('click', () => {
        this.currentProjectSortReversed = !this.currentProjectSortReversed;
        this.updateProjectSortToolbar();
        this.refresh();
      });
    }

    // 現場軸 検索ボックス（工事名・工事番号・客先の部分一致。入力のたび軽いデバウンスで再描画）
    const searchInput = document.getElementById('gantt-project-search');
    if (searchInput) {
      searchInput.value = this.projectSearchQuery;
      let searchTimer = null;
      searchInput.addEventListener('input', () => {
        this.projectSearchQuery = searchInput.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => this.refresh(), 200);
      });
    }
    const searchClear = document.getElementById('gantt-project-search-clear');
    if (searchClear) {
      searchClear.addEventListener('click', () => {
        this.projectSearchQuery = '';
        if (searchInput) { searchInput.value = ''; searchInput.focus(); }
        this.refresh();
      });
    }

    // 監督軸・資格軸 検索ボックス（氏名・社員番号の部分一致。入力のたび軽いデバウンスで再描画）
    const supSearchInput = document.getElementById('gantt-supervisor-search');
    if (supSearchInput) {
      supSearchInput.value = this.supervisorSearchQuery;
      let supSearchTimer = null;
      supSearchInput.addEventListener('input', () => {
        this.supervisorSearchQuery = supSearchInput.value;
        clearTimeout(supSearchTimer);
        supSearchTimer = setTimeout(() => this.refresh(), 200);
      });
    }
    const supSearchClear = document.getElementById('gantt-supervisor-search-clear');
    if (supSearchClear) {
      supSearchClear.addEventListener('click', () => {
        this.supervisorSearchQuery = '';
        if (supSearchInput) { supSearchInput.value = ''; supSearchInput.focus(); }
        this.refresh();
      });
    }

    // 資格軸 区分フィルタ（複数選択トグル：単一表示も複数表示も可）
    document.querySelectorAll('.gantt-qual-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat;
        if (this.qualCategoryFilter.has(cat)) this.qualCategoryFilter.delete(cat);
        else this.qualCategoryFilter.add(cat);
        this.updateQualFilterToolbar();
        this.refresh();
      });
    });

    // プロジェクト状態モーダル
    const statusModal = document.getElementById('project-status-modal');
    if (statusModal) {
      const closeStatusModal = () => statusModal.classList.add('hidden');
      document.getElementById('project-status-modal-close').addEventListener('click', closeStatusModal);
      document.getElementById('project-status-cancel').addEventListener('click', closeStatusModal);
      statusModal.addEventListener('click', (ev) => { if (ev.target === statusModal) closeStatusModal(); });
      document.getElementById('project-status-save').addEventListener('click', () => this.saveProjectStatus());
    }

    // 今日ラベル
    const today = new Date();
    document.getElementById('gantt-today-label').textContent =
      `今日: ${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;

    // 週次レポート出力（gantt/report.js が読み込まれていれば配線）
    if (this.initReportUi) this.initReportUi();
  },

  formatMonth(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },

  refresh() {
    document.querySelectorAll('.gantt-axis-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.axis === this.currentAxis);
    });
    const descEl = document.getElementById('gantt-description');
    if (descEl) descEl.textContent = this.AXIS_DESC[this.currentAxis] || '';
    this.updateProjectSortToolbar();
    this.updateQualFilterToolbar();

    const container = document.getElementById('gantt-container');
    if (!container) return;
    try {
      switch (this.currentAxis) {
        case 'project': container.innerHTML = this.renderProjectAxis(); break;
        case 'office': container.innerHTML = this.renderOfficeAxis(); break;
        case 'person': container.innerHTML = this.renderPersonAxis(); break;
        case 'department': container.innerHTML = this.renderDepartmentAxis(); break;
        case 'qualification': container.innerHTML = this.renderQualificationGantt(); break;
      }
    } catch (e) {
      console.error('Gantt render失敗 (' + this.currentAxis + '):', e);
      container.innerHTML = '<div class="p-4 text-red-600">ガント描画でエラーが発生しました。F12 → Console タブのエラー詳細を共有してください。<br><span class="text-xs text-slate-500">' + (e.message || e) + '</span></div>';
    }
  },

  scrollToToday() {
    const cells = this.buildCells();
    if (cells.length === 0) return;
    const today = new Date();
    const px = this.dateToPx(today, cells);
    const container = document.getElementById('gantt-container');
    // スクロール位置：今日が画面中央付近に来るように
    const scrollX = Math.max(0, this.LABEL_WIDTH + px - container.clientWidth / 2);
    container.scrollTo({ left: scrollX, behavior: 'smooth' });
  },

  // ===== セル生成（期間フィルタ反映） =====

  parseDate(s) {
    if (s instanceof Date) return s;
    return new Date(String(s).replace(/\//g, '-'));
  },

  monthKey(date) { return date.getFullYear() + '-' + (date.getMonth() + 1); },

  buildCells() {
    const minD = new Date(this.displayStart.getFullYear(), this.displayStart.getMonth(), 1);
    const maxD = new Date(this.displayEnd.getFullYear(), this.displayEnd.getMonth() + 1, 1);
    if (maxD <= minD) return [];

    const cells = [];
    let cur = new Date(minD);
    while (cur < maxD) {
      const key = this.monthKey(cur);
      if (this.expandedMonths.has(key)) {
        const daysInMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
        for (let d = 1; d <= daysInMonth; d++) {
          cells.push({
            type: 'day', date: new Date(cur.getFullYear(), cur.getMonth(), d),
            width: this.DAY_WIDTH, label: d, monthKey: key,
            monthLabel: cur.getFullYear() + '/' + (cur.getMonth() + 1),
          });
        }
      } else {
        cells.push({
          type: 'month', date: new Date(cur),
          width: this.MONTH_WIDTH,
          label: cur.getFullYear() + '/' + (cur.getMonth() + 1), monthKey: key,
        });
      }
      cur.setMonth(cur.getMonth() + 1);
    }
    return cells;
  },

  cellsTotalWidth(cells) {
    return cells.reduce((s, c) => s + c.width, 0);
  },

  dateToPx(date, cells) {
    let px = 0;
    for (const cell of cells) {
      let cellEnd;
      if (cell.type === 'month') {
        cellEnd = new Date(cell.date.getFullYear(), cell.date.getMonth() + 1, 1);
      } else {
        cellEnd = new Date(cell.date.getFullYear(), cell.date.getMonth(), cell.date.getDate() + 1);
      }
      if (date < cellEnd) {
        const cellStart = cell.date;
        const cellDur = cellEnd - cellStart;
        const offset = Math.max(0, date - cellStart);
        const ratio = Math.min(1, offset / cellDur);
        return px + ratio * cell.width;
      }
      px += cell.width;
    }
    return px;
  },

  // 期間にバー範囲をクリップ（表示範囲外なら null）
  clipRange(start, end, cells) {
    if (cells.length === 0) return null;
    const rangeStart = cells[0].date;
    const last = cells[cells.length - 1];
    const rangeEnd = last.type === 'month'
      ? new Date(last.date.getFullYear(), last.date.getMonth() + 1, 1)
      : new Date(last.date.getFullYear(), last.date.getMonth(), last.date.getDate() + 1);
    if (end < rangeStart || start > rangeEnd) return null;
    return {
      start: start < rangeStart ? rangeStart : start,
      end: end > rangeEnd ? rangeEnd : end,
      truncStart: start < rangeStart,
      truncEnd: end > rangeEnd,
    };
  },

  headerHtml(cells) {
    let row1 = `<tr><th rowspan="2" class="p-2 bg-slate-200 sticky left-0 border-r text-left z-20 align-middle" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px;height:60px">縦軸 / 配置</th>`;
    let row2 = '<tr>';

    let i = 0;
    while (i < cells.length) {
      const c = cells[i];
      if (c.type === 'month') {
        row1 += `<th data-month-key="${c.monthKey}" class="bg-slate-100 border-r px-1 py-1 text-xs cursor-pointer hover:bg-slate-200 align-middle whitespace-nowrap" style="min-width:${c.width}px;width:${c.width}px;height:36px" title="クリックで日次展開">${c.label} <span class="text-slate-400">⌄</span></th>`;
        row2 += `<th class="bg-slate-50 border-r" style="min-width:${c.width}px;width:${c.width}px;height:24px;border-bottom:2px solid #cbd5e1"></th>`;
        i++;
      } else {
        let j = i;
        while (j < cells.length && cells[j].type === 'day' && cells[j].monthKey === c.monthKey) j++;
        const span = j - i;
        const totalW = cells.slice(i, j).reduce((s, x) => s + x.width, 0);
        row1 += `<th colspan="${span}" data-month-key="${c.monthKey}" class="bg-amber-200 border-r border-l px-1 py-1 text-xs font-bold cursor-pointer hover:bg-amber-300 text-amber-900 whitespace-nowrap" style="min-width:${totalW}px;width:${totalW}px;height:36px" title="クリックで月表示に戻す">${c.monthLabel} <span class="text-amber-700">⌃</span></th>`;
        for (let k = i; k < j; k++) {
          row2 += `<th class="bg-amber-50 border-r text-[11px] text-amber-900 font-semibold whitespace-nowrap" style="min-width:${cells[k].width}px;width:${cells[k].width}px;height:24px;padding:2px 0">${cells[k].label}</th>`;
        }
        i = j;
      }
    }
    row1 += '</tr>';
    row2 += '</tr>';
    return '<thead>' + row1 + row2 + '</thead>';
  },

  // lineColor 省略時は標準の薄灰。稼働形態バンド行では背景色に埋もれないよう濃いめの線色を渡す。
  gridDivs(cells, lineColor) {
    const line = lineColor || '#e5e7eb';
    let html = '';
    let px = 0;
    cells.forEach(c => {
      const bg = c.type === 'day' ? 'background:#fffbeb;' : '';
      html += `<div style="position:absolute;left:${px}px;width:${c.width}px;top:0;bottom:0;border-right:1px solid ${line};${bg}"></div>`;
      px += c.width;
    });
    return html;
  },

  // 今日マーカー（縦赤線）
  todayMarker(cells) {
    const today = new Date();
    const clip = this.clipRange(today, today, cells);
    if (!clip) return '';
    const px = this.dateToPx(today, cells);
    return `<div class="gantt-today-line" style="position:absolute;left:${px}px;top:0;bottom:0;width:2px;background:#ef4444;z-index:2;pointer-events:none"><div style="position:absolute;top:-4px;left:-4px;width:10px;height:10px;background:#ef4444;border-radius:50%"></div></div>`;
  },

  // バー描画（左切れ・右切れの矢印付き・dashed は点線枠で区別・assignment id 紐付け）
  // dashed: true で点線描画（見込み案件・配置未定 共通）
  renderBar(start, end, cells, color, label, top, title, dashed = false, asgId = null, accent = null) {
    const clip = this.clipRange(start, end, cells);
    if (!clip) return '';
    const left = this.dateToPx(clip.start, cells);
    const right = this.dateToPx(clip.end, cells);
    const width = Math.max(16, right - left - 2);
    // 切れ表示（実線バーのみ・点線バーには適用しない）
    const truncLeft = (!dashed && clip.truncStart) ? 'border-left:2px dashed #fff;' : '';
    const truncRight = (!dashed && clip.truncEnd) ? 'border-right:2px dashed #fff;' : '';
    // 点線バー：色枠の点線・中身は薄い同系色（背景に対する識別性確保）。テキストは読みやすい濃色固定。
    const bg = dashed ? this.toLightBg(color) : color;
    const dashedStyle = dashed
      ? `border:2px dashed ${color};color:#475569;font-weight:600;`
      : '';
    // 稼働形態アクセント：バー左に色帯（inset shadow＝レイアウト・幅に影響しない）。現場/事務所軸用。
    const accentStyle = accent ? `box-shadow: inset 5px 0 0 ${accent};` : '';
    const dashedIcon = dashed ? '⊘ ' : '';
    const dataAttr = asgId !== null && asgId !== undefined ? ` data-asg-id="${this.esc(asgId)}"` : '';
    const cursorStyle = asgId !== null && asgId !== undefined ? 'cursor:pointer;' : '';
    return `<div class="gantt-bar" style="left:${left + 1}px;width:${width}px;top:${top}px;background:${bg};height:${this.BAR_HEIGHT}px;${truncLeft}${truncRight}${dashedStyle}${accentStyle}${cursorStyle}" title="${this.esc(title || '')}"${dataAttr}>${dashedIcon}${this.esc(label || '')}</div>`;
  },

  // 色を薄く（見込み案件のバー背景用）
  toLightBg(hex) {
    const m = String(hex).match(/^#([0-9a-f]{6})$/i);
    if (!m) return '#f1f5f9';
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    // 元色をrgba(α=0.12)で表現
    return `rgba(${r}, ${g}, ${b}, 0.12)`;
  },

  // 準備期間バーの背景：役割色のベタ塗りを下地に、白の斜線を重ねる。
  // （下地を確保することで白抜き文字が読める／斜線で配属バーと一目で区別できる）
  prepStripe(hex) {
    const base = /^#([0-9a-f]{6})$/i.test(String(hex)) ? hex : '#94a3b8';
    return `background-color:${base};background-image:repeating-linear-gradient(45deg, rgba(255,255,255,0) 0 5px, rgba(255,255,255,0.32) 5px 10px);`;
  },

  // 準備期間バー（prep_start 〜 join）。配属バーの左に同系色の斜線で描画。
  // dateToPx(join) が配属バーの左端と一致するため、prep バー右端は配属バー左端にぴったり隣接する。
  prepBarHtml(a, cells, color, top) {
    if (!a || !a.prep_start || !a.join) return '';
    const ps = this.parseDate(a.prep_start);
    const je = this.parseDate(a.join);
    if (isNaN(ps) || isNaN(je) || ps >= je) return '';
    const clip = this.clipRange(ps, je, cells);
    if (!clip) return '';
    const left = this.dateToPx(clip.start, cells);
    const right = this.dateToPx(clip.end, cells);
    const width = Math.max(6, right - left - 2);
    const label = width >= 44 ? '準備' : '';
    const title = `準備期間 ${a.prep_start}〜${a.join}`;
    return `<div class="gantt-bar gantt-prep-bar" style="left:${left + 1}px;width:${width}px;top:${top}px;height:${this.BAR_HEIGHT}px;${this.prepStripe(color)}color:#fff;font-weight:700;font-size:10px;text-shadow:0 1px 1px rgba(0,0,0,0.45);cursor:pointer;" title="${this.esc(title)}" data-asg-id="${this.esc(a.assignment_id)}">${label}</div>`;
  },

  esc(text) { return Util.esc(text); },
};
