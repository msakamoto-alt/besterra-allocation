/**
 * gantt.js - 現場人員配置（4軸ガント＋月→日ドリルダウン＋期間フィルタ＋今日マーカー）
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
    const reverseBtn = document.getElementById('gantt-project-sort-reverse');
    if (reverseBtn) {
      reverseBtn.textContent = this.effectiveProjectSortDir() === 'asc' ? '↑' : '↓';
      reverseBtn.title = `現在: ${this.effectiveProjectSortDir() === 'asc' ? '昇順' : '降順'}（クリックで反転）`;
    }
    // 現場検索は現場軸のみ表示。✕ボタンは入力があるときだけ
    const searchWrap = document.getElementById('gantt-project-search-wrap');
    if (searchWrap) searchWrap.style.display = (this.currentAxis === 'project') ? '' : 'none';
    const searchClear = document.getElementById('gantt-project-search-clear');
    if (searchClear) searchClear.classList.toggle('hidden', !String(this.projectSearchQuery || '').trim());
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
    modal.addEventListener('click', (e) => { if (e.target === modal) closeFn(); });

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
  toIsoDate(s) {
    if (!s) return '';
    const d = new Date(String(s).replace(/\//g, '-'));
    if (isNaN(d)) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

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
    const toSlash = s => s ? String(s).replace(/-/g, '/') : '';
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

  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

  // ===== 1. 現場軸 =====

  renderProjectAxis() {
    const projects = Sync.cache.projects || [];
    const assignments = Sync.cache.assignments || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    // 表示範囲フィルタ・完成/見込みトグル
    const visibleProjectsRaw = projects.filter(p => {
      if (p.completed && !this.showCompleted) return false;
      if (p.prospect && !this.showProspects) return false;
      const s = this.parseDate(p.start);
      const e = this.parseDate(p.end);
      return this.clipRange(s, e, cells);
    });

    // 検索絞り込み（工事名・工事番号・客先）→ 並び替え（現在のソートキーと方向に従う）
    const searchedProjects = this.applyProjectSearch(visibleProjectsRaw);
    if (searchedProjects.length === 0 && String(this.projectSearchQuery || '').trim()) {
      return `<p class="p-4 text-slate-500">「${this.esc(this.projectSearchQuery)}」に一致する現場がありません（表示期間・完成/見込みトグルもご確認ください）</p>`;
    }
    const visibleProjects = this.sortProjects(searchedProjects, assignments);

    let html = `<table class="border-collapse gantt-table" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    visibleProjects.forEach(p => {
      html += this.projectRowHtml(p, assignments, cells, colCount, todayMarkerHtml);
    });
    html += '</tbody></table>';

    html += this.legendRole();
    html += this.legendWorkMode();
    return html;
  },

  // 現場1件分の行HTML（現場軸・事務所軸で共通利用）。ラベル列＋配置監督のバー（準備期間バー含む）。
  // 縦積み順＝①実員を上・配置未定/不足は役割に関係なく常に下 → ②役割優先（主任技術者→副監督→派遣）
  //   → ③同役割は配属期間の長い順（上）→短い順（下）。タイブレーク＝着工日→氏名。
  projectRowHtml(p, assignments, cells, colCount, todayMarkerHtml) {
    const rolePriority = (a) => {
      const r = Sync.normalizeRole ? Sync.normalizeRole(a.role) : a.role;
      return r === '主任技術者' ? 0 : r === '副監督' ? 1 : r === '派遣' ? 2 : 3;
    };
    const durationMs = (a) => {
      const s = this.parseDate(a.join), e = this.parseDate(a.planned_end || p.end);
      return (isNaN(s) || isNaN(e)) ? -1 : (e - s);
    };
    const projAsgs = assignments.filter(a => a.project_id === p.project_id).sort((x, y) => {
      // 配置未定・不足は役割に関係なく常に最下段へ
      const ux = this.isPlaceholderName(x.emp_name) ? 1 : 0;
      const uy = this.isPlaceholderName(y.emp_name) ? 1 : 0;
      if (ux !== uy) return ux - uy;
      const pr = rolePriority(x) - rolePriority(y);
      if (pr !== 0) return pr;
      const dd = durationMs(y) - durationMs(x);   // 期間の長い順（降順）
      if (dd !== 0) return dd;
      const sd = String(x.join || '').localeCompare(String(y.join || ''));
      return sd !== 0 ? sd : String(x.emp_name || '').localeCompare(String(y.emp_name || ''), 'ja');
    });
    const rowH = Math.max(64, 16 + Math.max(1, projAsgs.length) * (this.BAR_HEIGHT + this.BAR_GAP));

    // 配置未定・不足・派遣社員はバー内にのみ表示し、ラベル列はサマリー化（重複表示回避）
    const placeholderCount = projAsgs.filter(a => this.isPlaceholderName(a.emp_name)).length;
    const dispatchCount = projAsgs.filter(a => this.isDispatchName(a.emp_name)).length;
    const labelMembers = projAsgs
      .filter(a => !this.isPlaceholderName(a.emp_name) && !this.isDispatchName(a.emp_name))
      .map(a => `<span class="inline-block mr-2 font-medium">${this.esc(a.emp_name)}</span>`)
      .join('');
    const dispatchNote = dispatchCount > 0
      ? `<span class="inline-block mr-2" style="color:#ca8a04">派遣社員 ×${dispatchCount}</span>`
      : '';
    const placeholderNote = placeholderCount > 0
      ? `<span class="inline-block mr-2 text-slate-500">配置未定・不足 ×${placeholderCount}</span>`
      : '';

    const canEdit = Sync.canEdit();
    const addBtn = canEdit
      ? `<button class="text-xs text-emerald-700 hover:underline mt-1 gantt-add-member" data-project-id="${this.esc(p.project_id)}">+ メンバー追加</button>`
      : '';
    // 案件の修正ボタン（状態・管轄事務所の手動上書き）。いずれか上書き中なら「★」マーク付き
    const projEdited = p._status_overridden || p._dept_overridden;
    const statusBtn = canEdit
      ? `<button class="text-xs text-slate-600 hover:text-slate-900 hover:underline ml-2 mt-1 gantt-status-edit" data-project-id="${this.esc(p.project_id)}">${projEdited ? '★ 案件の修正' : '案件の修正'}</button>`
      : '';
    // 状態バッジ（完成 or 進行中）：オーバーライド適用中は色付け
    const isCompleted = !!p.completed;
    const statusBadge = p._status_overridden
      ? `<span class="inline-block ${isCompleted ? 'bg-slate-200 text-slate-700' : 'bg-blue-100 text-blue-700'} px-1.5 py-0 rounded text-[10px] font-medium ml-1" title="手動で状態を上書き中">${isCompleted ? '完成' : '進行中'}</span>`
      : (isCompleted ? '<span class="inline-block bg-slate-100 text-slate-500 px-1.5 py-0 rounded text-[10px] ml-1">完成</span>' : '');
    let html = '<tr class="border-t">' +
      `<td class="p-2 sticky left-0 bg-white border-r z-10 align-top" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
        `<div class="font-medium text-sm">${this.esc(p.name)}${this.contractBadge(p.contract_type)}${statusBadge}</div>` +
        `<div class="text-xs text-slate-500">${this.esc(p.project_id)} / ¥${(p.amount / 1e6).toFixed(1)}M / ${this.esc(p.dept)}</div>` +
        `<div class="text-xs mt-1">${(labelMembers || dispatchNote || placeholderNote) ? (labelMembers + dispatchNote + placeholderNote) : '<span class="text-slate-400">配置未定・不足</span>'}</div>` +
        addBtn + statusBtn +
      '</td>' +
      `<td colspan="${colCount}" style="position:relative; height:${rowH}px; padding:0">` +
        this.gridDivs(cells) +
        todayMarkerHtml;

    if (projAsgs.length === 0) {
      const start = this.parseDate(p.start);
      const end = this.parseDate(p.end);
      html += this.renderBar(start, end, cells, this.PLACEHOLDER_COLOR, '配置未定・不足', 8, `${p.name}（${p.start}〜${p.end}）配置未定・不足`, true);
    } else {
      const empById = this.empByIdMap();
      projAsgs.forEach((a, idx) => {
        const start = this.parseDate(a.join);
        const end = this.parseDate(a.planned_end || p.end);
        const style = this.resolveBarStyle(a, p);
        const top = 8 + idx * (this.BAR_HEIGHT + this.BAR_GAP);
        const titleTag = a.prospect ? '【見込み】' : '';
        // 稼働形態（監督派遣/専従）の社員はバー左に色帯を付与（案件がある＝バーがある時のみ）
        const emp = empById[a.emp_id];
        const wmAccent = (emp && Sync.isSpecialWorkMode && Sync.isSpecialWorkMode(emp.work_mode)) ? this.workModeAccent(emp.work_mode) : null;
        const wmTag = wmAccent ? `【${Sync.WORK_MODES[emp.work_mode].label}】` : '';
        html += this.prepBarHtml(a, cells, style.color, top);
        html += this.renderBar(start, end, cells, style.color, style.label, top, `${style.label}（${style.role}）${wmTag} ${a.join}〜${a.planned_end || p.end}${titleTag}`, style.dashed, a.assignment_id, wmAccent);
      });
    }
    html += '</td></tr>';
    return html;
  },

  // ===== 1b. 事務所軸（事務所ごとの管轄工事） =====

  renderOfficeAxis() {
    const projects = Sync.cache.projects || [];
    const assignments = Sync.cache.assignments || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    // 表示範囲・完成/見込みトグルでフィルタ（現場軸と同条件）
    const visible = projects.filter(p => {
      if (p.completed && !this.showCompleted) return false;
      if (p.prospect && !this.showProspects) return false;
      return this.clipRange(this.parseDate(p.start), this.parseDate(p.end), cells);
    });

    // 事務所（p.dept＝CL営業管轄）でグルーピング
    const byOffice = {};
    visible.forEach(p => {
      const office = String(p.dept || '').trim() || '（事務所未設定）';
      (byOffice[office] = byOffice[office] || []).push(p);
    });
    // 事務所の表示順（現場軸ソート「事務所別」と同じ：東日本→本社→千葉→京浜→西日本→倉敷→九州）
    const OFFICE_ORDER = ['東日本', '本社', '千葉', '京浜', '西日本', '倉敷', '九州'];
    const officeIdx = (d) => { const s = String(d || ''); for (let i = 0; i < OFFICE_ORDER.length; i++) { if (s.includes(OFFICE_ORDER[i])) return i; } return OFFICE_ORDER.length; };
    const offices = Object.keys(byOffice).sort((a, b) => {
      const ai = officeIdx(a), bi = officeIdx(b);
      if (ai !== bi) return ai - bi;
      return String(a).localeCompare(String(b), 'ja');
    });

    // 実員（プレースホルダ以外＝当社社員/派遣）が1人もいない工事＝配置未定・不足。グループ内で下に沈める。
    const isUnstaffed = (p) => !assignments.some(a => a.project_id === p.project_id && !this.isPlaceholderName(a.emp_name));

    let html = `<table class="border-collapse gantt-table" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    offices.forEach(office => {
      // 事務所内：実員ありを先に、配置未定・不足を後ろに。各群の中は着工日昇順（タイブレーク＝工事番号）
      const projs = byOffice[office].slice().sort((a, b) => {
        const au = isUnstaffed(a) ? 1 : 0, bu = isUnstaffed(b) ? 1 : 0;
        if (au !== bu) return au - bu;
        const d = String(a.start || '').localeCompare(String(b.start || ''));
        return d !== 0 ? d : String(a.project_id || '').localeCompare(String(b.project_id || ''));
      });
      const amount = projs.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      html += '<tr class="bg-slate-800 text-white">' +
        `<td class="p-2 sticky left-0 bg-slate-800 border-r z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-bold text-sm">${this.esc(office)}</div>` +
          `<div class="text-xs text-slate-300">管轄工事 ${projs.length}件 / ¥${(amount / 1e6).toFixed(1)}M</div>` +
        '</td>' +
        `<td colspan="${colCount}" style="height:36px; padding:0; background:#1e293b"></td>` +
      '</tr>';
      projs.forEach(p => { html += this.projectRowHtml(p, assignments, cells, colCount, todayMarkerHtml); });
    });
    html += '</tbody></table>';
    html += this.legendRole();
    html += this.legendWorkMode();
    return html;
  },

  // ===== 稼働形態（監督派遣/事務所専従/構内専従）の個人行表現 =====
  // 行全体を淡い背景色＋左アクセントのバンドで表示し「どの稼働区分か」を示す。
  // ★案件バーは常に表示する（派遣・専従でも当社現場に立つため）。バーが無い行のみ中央ラベルを出す。
  // 配色は Sync.WORK_MODES で一元管理（あとで調整しやすい）。

  // ラベル列に付ける小バッジ（区分バッジの隣）
  workModeBadge(mode) {
    const wm = Sync.WORK_MODES && Sync.WORK_MODES[mode];
    if (!wm) return '';
    return `<span class="${wm.badge} px-1.5 py-0.5 rounded text-[10px] font-medium">${this.esc(wm.short)}</span>`;
  },

  // 行の背景色（ラベル列・タイムライン列に共通で当てる inline style 断片）。通常は空文字。
  workModeBg(mode) {
    const wm = Sync.WORK_MODES && Sync.WORK_MODES[mode];
    return wm ? `background:${wm.bg}` : '';
  },
  // タイムライン列の追加 style（背景＋左アクセント）。通常は空文字。
  workModeTimelineStyle(mode) {
    const wm = Sync.WORK_MODES && Sync.WORK_MODES[mode];
    return wm ? `background:${wm.bg}; border-left:4px solid ${wm.accent};` : '';
  },
  // バンド行の縦線色（背景に埋もれないよう濃いめ）。通常は null＝標準の薄灰。
  workModeLine(mode) {
    const wm = Sync.WORK_MODES && Sync.WORK_MODES[mode];
    return wm ? (wm.line || '#cbd5e1') : null;
  },
  // バー左帯のアクセント色（現場軸・事務所軸でバーに付ける稼働形態の色）。通常は null。
  workModeAccent(mode) {
    const wm = Sync.WORK_MODES && Sync.WORK_MODES[mode];
    return wm ? wm.accent : null;
  },

  // 稼働形態（派遣/専従）の色帯を指定期間だけ描画。start/end の欠けは表示窓端で補完。
  // 配置可否・空きには影響しない（色帯の見た目のみ）。
  workModeBandHtml(emp, cells) {
    const wm = Sync.WORK_MODES && Sync.WORK_MODES[emp.work_mode];
    if (!wm || !cells.length) return '';
    const ws = cells[0].date;
    const last = cells[cells.length - 1];
    const we = last.type === 'month'
      ? new Date(last.date.getFullYear(), last.date.getMonth() + 1, 1)
      : new Date(last.date.getFullYear(), last.date.getMonth(), last.date.getDate() + 1);
    let s = emp.work_mode_start ? this.parseDate(emp.work_mode_start) : null;
    let e = emp.work_mode_end ? this.parseDate(emp.work_mode_end) : null;
    if (!s || isNaN(s)) s = ws;
    if (!e || isNaN(e)) e = we;
    const clip = this.clipRange(s, e, cells);
    if (!clip) return '';
    const left = this.dateToPx(clip.start, cells);
    const right = this.dateToPx(clip.end, cells);
    const width = Math.max(8, right - left);
    const range = `${emp.work_mode_start || ''}${(emp.work_mode_start || emp.work_mode_end) ? '〜' : ''}${emp.work_mode_end || ''}`;
    return `<div class="gantt-wm-band" style="left:${left}px;width:${width}px;background:${wm.bg};border-left:4px solid ${wm.accent};" title="${this.esc(wm.label)} ${this.esc(range)}"><span style="color:${wm.text}">${this.esc(wm.short)}</span></div>`;
  },

  // 不在（長期休暇/休職/育休等）の [start,end] Date 配列を返す。end 空欄は表示窓端で補完。
  // 監督軸／事務所モニターで「空き」帯の抑制（占有扱い）にも使う。
  absenceIntervals(emp, cells) {
    const list = (emp && emp.absences) || [];
    if (!list.length || !cells.length) return [];
    const we = (() => {
      const last = cells[cells.length - 1];
      return last.type === 'month'
        ? new Date(last.date.getFullYear(), last.date.getMonth() + 1, 1)
        : new Date(last.date.getFullYear(), last.date.getMonth(), last.date.getDate() + 1);
    })();
    const ws = cells[0].date;
    const out = [];
    list.forEach(a => {
      let s = a.start ? this.parseDate(a.start) : null;
      let e = a.end ? this.parseDate(a.end) : null;
      if (!s || isNaN(s)) s = ws;
      if (!e || isNaN(e)) e = we;
      if (e > s) out.push({ s, e, kind: a.kind, note: a.note });
    });
    return out;
  },

  // 不在のグレー網掛け帯（監督軸・事務所モニター）。帯は一律「休暇 約Nか月」表示。
  absenceBandsHtml(emp, cells) {
    const ivs = this.absenceIntervals(emp, cells);
    if (!ivs.length) return '';
    let html = '';
    ivs.forEach(({ s, e, kind, note }) => {
      const clip = this.clipRange(s, e, cells);
      if (!clip) return;
      const left = this.dateToPx(clip.start, cells);
      const right = this.dateToPx(clip.end, cells);
      const width = Math.max(8, right - left - 2);
      const days = Math.round((e - s) / 86400000);
      const months = Math.floor(days / 30);
      const dur = months >= 12 ? `約${Math.floor(months / 12)}年` : (months >= 1 ? `約${months}か月` : `${days}日`);
      // ガント帯はシンプルに「休暇」で統一。種別・期間・メモの詳細はホバー(title)に残す。
      const sLabel = `${s.getFullYear()}/${s.getMonth() + 1}/${s.getDate()}`;
      const eLabel = `${e.getFullYear()}/${e.getMonth() + 1}/${e.getDate()}`;
      const title = `${kind || '不在'} ${sLabel}〜${eLabel}${note ? '（' + note + '）' : ''}`;
      html += `<div class="gantt-absence" style="left:${left + 1}px;width:${width}px;" title="${this.esc(title)}"><span>休暇 ${dur}</span></div>`;
    });
    return html;
  },

  // emp.id → emp のマップ（employees 配列の参照が変わった時だけ再構築＝同期後のみ）
  empByIdMap() {
    const emps = Sync.cache.employees || [];
    if (this._empByIdCache && this._empByIdSrc === emps) return this._empByIdCache;
    const m = {};
    emps.forEach(e => { m[e.id] = e; });
    this._empByIdSrc = emps;
    this._empByIdCache = m;
    return m;
  },

  // 稼働形態の凡例
  legendWorkMode() {
    if (!Sync.WORK_MODES) return '';
    let html = '<div class="px-3 pb-3 bg-slate-50 text-xs flex flex-wrap gap-3 items-center">' +
      '<span class="font-semibold text-slate-700">稼働形態:</span>';
    Object.values(Sync.WORK_MODES).forEach(wm => {
      html += `<span class="inline-flex items-center gap-1"><span style="display:inline-block;width:14px;height:14px;background:${wm.bg};border-left:3px solid ${wm.accent};border-radius:2px"></span>${this.esc(wm.label)}</span>`;
    });
    html += '<span class="text-slate-400 ml-1">（行の背景色／現場・事務所軸ではバーの左帯。監督ダッシュボードで設定）</span>';
    html += '</div>';
    return html;
  },

  // ===== 2. 人軸 =====

  renderPersonAxis() {
    const employees = (Sync.cache.employees || []).filter(e => e.category === '現場監督' || e.category === '準現場監督');
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    const assignedIds = new Set(assignments.map(a => a.emp_id));
    const sorted = [...employees].sort((a, b) => {
      const ah = assignedIds.has(a.id) ? 0 : 1;
      const bh = assignedIds.has(b.id) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return (a.department || '').localeCompare(b.department || '');
    });

    let html = `<table class="border-collapse gantt-table" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    sorted.forEach(e => {
      const special = Sync.isSpecialWorkMode && Sync.isSpecialWorkMode(e.work_mode);
      const myAsgs = assignments.filter(a => a.emp_id === e.id && (this.showCompleted || !a.completed) && (this.showProspects || !a.prospect));
      const rowH = Math.max(48, 16 + Math.max(1, myAsgs.length) * (this.BAR_HEIGHT + this.BAR_GAP));
      const labelBg = special ? `;${this.workModeBg(e.work_mode)}` : '';
      const tlStyle = special ? ` ${this.workModeTimelineStyle(e.work_mode)}` : '';

      html += '<tr class="border-t">' +
        `<td class="p-2 sticky left-0 ${special ? '' : 'bg-white'} border-r z-10 align-top" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px${labelBg}">` +
          `<div class="font-medium text-sm">${this.esc(e.name)}</div>` +
          `<div class="text-xs text-slate-500">${this.esc(e.department || '')}</div>` +
          `<div class="mt-1 flex flex-wrap items-center gap-1">${PoolView.categoryBadge(e.category)}${special ? this.workModeBadge(e.work_mode) : ''}</div>` +
        '</td>' +
        `<td colspan="${colCount}" style="position:relative; height:${rowH}px; padding:0;${tlStyle}">` +
          this.gridDivs(cells, special ? this.workModeLine(e.work_mode) : null) +
          todayMarkerHtml;

      myAsgs.forEach((a, idx) => {
        const proj = projects.find(p => p.project_id === a.project_id);
        if (!proj) return;
        const start = this.parseDate(a.join);
        const end = this.parseDate(a.planned_end || proj.end);
        const style = this.resolveBarStyle(a, proj);
        const top = 8 + idx * (this.BAR_HEIGHT + this.BAR_GAP);
        const projLabel = (proj.contract_type || '').includes('元請') ? `[元請] ${a.project_name}` : a.project_name;
        html += this.prepBarHtml(a, cells, style.color, top);
        html += this.renderBar(start, end, cells, style.color, projLabel, top, `${a.project_name}（${style.role}） ${a.join}〜${a.planned_end || proj.end}${a.prospect ? '【見込み】' : ''}`, style.dashed, a.assignment_id);
      });
      html += '</td></tr>';
    });
    html += '</tbody></table>';

    html += this.legendRole();
    html += this.legendWorkMode();
    return html;
  },

  // ===== 3. 事務所軸 =====

  renderDepartmentAxis() {
    const employees = (Sync.cache.employees || []).filter(e => e.category === '現場監督' || e.category === '準現場監督');
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    const empByDept = {};
    employees.forEach(e => {
      if (!empByDept[e.department]) empByDept[e.department] = [];
      empByDept[e.department].push(e);
    });
    // 事務所軸の表示順（部分一致・前にあるものほど優先）
    // リストにない部署は末尾に、その中では文字列昇順
    const DEPT_ORDER = [
      '安全衛生室',
      'プラント事業本部',
      '脱炭素事業推進部',
      '営業課',
      '工務課',
      '工事部',
      '本社事務所',
      '千葉事務所',
      '京浜事務所',
      '西日本事務所',
      '九州事務所',
      '人事部付',
    ];
    const deptOrderIdx = (d) => {
      const s = String(d || '');
      for (let i = 0; i < DEPT_ORDER.length; i++) {
        if (s.includes(DEPT_ORDER[i])) return i;
      }
      return DEPT_ORDER.length;
    };
    const depts = Object.keys(empByDept).sort((a, b) => {
      const ai = deptOrderIdx(a);
      const bi = deptOrderIdx(b);
      if (ai !== bi) return ai - bi;
      return String(a).localeCompare(String(b), 'ja');
    });
    let html = `<table class="border-collapse gantt-table" style="width:max-content">${this.headerHtml(cells)}<tbody>`;
    depts.forEach(dept => {
      const emps = empByDept[dept];
      const assignedInDept = emps.filter(e => !(Sync.isSpecialWorkMode && Sync.isSpecialWorkMode(e.work_mode)) && assignments.some(a => a.emp_id === e.id && (this.showCompleted || !a.completed) && (this.showProspects || !a.prospect))).length;

      const monitorBtn =
        `<button data-board-office="${this.esc(dept)}" title="この事務所だけを別タブでモニター表示" ` +
        `class="flex-none text-[11px] bg-slate-600 hover:bg-slate-500 text-white px-2 py-1 rounded">📺 モニター</button>`;
      html += '<tr class="bg-slate-800 text-white">' +
        `<td class="p-2 sticky left-0 bg-slate-800 border-r z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="flex items-center justify-between gap-2">` +
            `<div><div class="font-bold text-sm">${this.esc(dept)}</div>` +
            `<div class="text-xs text-slate-300">在籍 ${emps.length}名 / 配置中 ${assignedInDept}名</div></div>` +
            monitorBtn +
          `</div>` +
        '</td>' +
        `<td colspan="${colCount}" style="height:36px; padding:0; background:#1e293b"></td>` +
      '</tr>';

      emps.forEach(e => { html += this.supervisorRowHtml(e, assignments, projects, cells, colCount, todayMarkerHtml); });
    });
    html += '</tbody></table>';

    html += this.legendRole();
    html += this.legendWorkMode();
    return html;
  },

  // 監督1名分の行HTML（監督軸・事務所モニターで共通利用）。ラベル列＋配置現場のバー。
  supervisorRowHtml(e, assignments, projects, cells, colCount, todayMarkerHtml) {
    const special = Sync.isSpecialWorkMode && Sync.isSpecialWorkMode(e.work_mode);
    const wmPeriod = special && !!(e.work_mode_start || e.work_mode_end);  // 色帯の表示期間あり
    const tintWhole = special && !wmPeriod;                               // 期間なし＝従来の全行色帯
    const myAsgs = assignments.filter(a => a.emp_id === e.id && (this.showCompleted || !a.completed) && (this.showProspects || !a.prospect));
    const rowH = Math.max(48, 16 + Math.max(1, myAsgs.length) * (this.BAR_HEIGHT + this.BAR_GAP));
    const labelBg = tintWhole ? `;${this.workModeBg(e.work_mode)}` : '';
    const tlStyle = tintWhole ? ` ${this.workModeTimelineStyle(e.work_mode)}` : '';

    let html = '<tr class="border-t">' +
      `<td class="p-2 sticky left-0 ${tintWhole ? '' : 'bg-white'} border-r z-10 pl-6 align-top" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px${labelBg}">` +
        `<div class="text-sm font-medium">${this.esc(e.name)}</div>` +
        `<div class="text-xs text-slate-500 mt-1 flex flex-wrap items-center gap-1">${PoolView.categoryBadge(e.category)}${special ? this.workModeBadge(e.work_mode) : ''}</div>` +
      '</td>' +
      `<td colspan="${colCount}" style="position:relative; height:${rowH}px; padding:0;${tlStyle}">` +
        this.gridDivs(cells, tintWhole ? this.workModeLine(e.work_mode) : null) +
        todayMarkerHtml +
        (wmPeriod ? this.workModeBandHtml(e, cells) : '') +
        // 不在帯（休暇/休職/育休等）は監督軸に出る全員（現場監督＋準現場監督）に表示
        this.absenceBandsHtml(e, cells) +
        // Point4: 空き帯は「通常稼働の現場監督」のみ（派遣・専従・準現場監督は除外）。不在期間は占有扱いで「空き」を出さない
        ((!special && e.category === '現場監督')
          ? this.availabilityBandsHtml(myAsgs, cells, projects, this.absenceIntervals(e, cells)) : '');
    myAsgs.forEach((a, idx) => {
      const proj = projects.find(p => p.project_id === a.project_id);
      if (!proj) return;
      const start = this.parseDate(a.join);
      const end = this.parseDate(a.planned_end || proj.end);
      const style = this.resolveBarStyle(a, proj);
      const top = 8 + idx * (this.BAR_HEIGHT + this.BAR_GAP);
      const projLabel = (proj.contract_type || '').includes('元請') ? `[元請] ${a.project_name}` : a.project_name;
      html += this.prepBarHtml(a, cells, style.color, top);
      html += this.renderBar(start, end, cells, style.color, projLabel, top, `${a.project_name}（${style.role}） ${a.join}〜${a.planned_end || proj.end}${a.prospect ? '【見込み】' : ''}`, style.dashed, a.assignment_id);
    });
    html += '</td></tr>';
    return html;
  },

  // Point4: 今日以降で配置（表示中のバー）が無い連続期間が GAP_MIN_DAYS 以上の「空き」帯を返す。
  // 占有 = 表示中の myAsgs の join〜planned_end(無ければ工期末) の和集合。
  availabilityBandsHtml(myAsgs, cells, projects, extraOcc) {
    if (!cells.length) return '';
    const windowStart = cells[0].date;
    const last = cells[cells.length - 1];
    const windowEnd = last.type === 'month'
      ? new Date(last.date.getFullYear(), last.date.getMonth() + 1, 1)
      : new Date(last.date.getFullYear(), last.date.getMonth(), last.date.getDate() + 1);
    let from = new Date(); from.setHours(0, 0, 0, 0);   // 今日以降の空きのみ対象
    if (from < windowStart) from = new Date(windowStart);
    if (from >= windowEnd) return '';

    // 占有区間（バーと同じ定義）→ 開始日昇順でマージ
    const occ = [];
    myAsgs.forEach(a => {
      const proj = projects.find(p => p.project_id === a.project_id);
      const join = this.parseDate(a.join);
      const prep = a.prep_start ? this.parseDate(a.prep_start) : null;
      // 準備期間(prep_start〜join)も占有扱い＝空きにしない。占有開始は prep と join の早い方。
      let s = join;
      if (prep && !isNaN(prep) && (!s || isNaN(s) || prep < s)) s = prep;
      const e = this.parseDate(a.planned_end || (proj && proj.end));
      if (s && e && !isNaN(s) && !isNaN(e) && e > s) occ.push([s, e]);
    });
    // 不在期間（休暇/休職/育休等）も占有扱い＝その期間は「空き」を出さない
    (extraOcc || []).forEach(iv => { if (iv && iv.s && iv.e && iv.e > iv.s) occ.push([iv.s, iv.e]); });
    occ.sort((x, y) => x[0] - y[0]);
    const merged = [];
    occ.forEach(iv => {
      const lastIv = merged[merged.length - 1];
      if (lastIv && iv[0] <= lastIv[1]) { if (iv[1] > lastIv[1]) lastIv[1] = new Date(iv[1]); }
      else merged.push([new Date(iv[0]), new Date(iv[1])]);
    });

    // from〜windowEnd から占有を引いた空き区間
    const gaps = [];
    let cursor = new Date(from);
    for (const [s, e] of merged) {
      if (e <= cursor) continue;
      if (s > cursor) gaps.push([new Date(cursor), new Date(Math.min(s, windowEnd))]);
      if (e > cursor) cursor = new Date(e);
      if (cursor >= windowEnd) break;
    }
    if (cursor < windowEnd) gaps.push([new Date(cursor), new Date(windowEnd)]);

    const MIN = this.GAP_MIN_DAYS * 86400000;
    let html = '';
    gaps.forEach(([s, e]) => {
      if ((e - s) < MIN) return;
      const left = this.dateToPx(s, cells);
      const right = this.dateToPx(e, cells);
      const width = Math.max(8, right - left - 2);
      const days = Math.round((e - s) / 86400000);
      const months = Math.floor(days / 30);
      const label = months >= 12 ? `空き 約${Math.floor(months / 12)}年` : `空き 約${months}か月`;
      const sLabel = `${s.getFullYear()}/${s.getMonth() + 1}/${s.getDate()}`;
      html += `<div class="gantt-gap" style="left:${left + 1}px;width:${width}px;" title="空き ${sLabel} から ${days}日"><span>${label}</span></div>`;
    });
    return html;
  },

  // ===== 事務所モニター（単一事務所・複数列・キオスク）=====

  // その事務所の監督を numCols 列に分けて横並びに描画（画面いっぱいに使う）。
  renderOfficeMonitor(office, numCols) {
    const employees = (Sync.cache.employees || []).filter(e =>
      (e.category === '現場監督' || e.category === '準現場監督') && e.department === office);
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    if (employees.length === 0) return `<p class="p-4 text-slate-500">「${this.esc(office)}」に該当する監督が見つかりません。</p>`;
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    const groups = this.balanceColumns(employees, Math.max(1, numCols), (e) => this.supervisorRowHeight(e, assignments));
    const tables = groups.map(group => {
      let body = '';
      group.forEach(e => { body += this.supervisorRowHtml(e, assignments, projects, cells, colCount, todayMarkerHtml); });
      return `<table class="border-collapse gantt-table" style="width:max-content">${this.headerHtml(cells)}<tbody>${body}</tbody></table>`;
    }).join('');

    return `<div class="flex items-start gap-6">${tables}</div>` + this.legendRole() + this.legendWorkMode();
  },

  // 監督1行の高さ（割当数で決まる・列バランス計算と行描画で共通の式）
  supervisorRowHeight(e, assignments) {
    const n = assignments.filter(a => a.emp_id === e.id && (this.showCompleted || !a.completed) && (this.showProspects || !a.prospect)).length;
    return Math.max(48, 16 + Math.max(1, n) * (this.BAR_HEIGHT + this.BAR_GAP));
  },

  // 並び順を保ったまま、各列の合計高さがそろうように numCols 列へ分割
  balanceColumns(items, numCols, weightOf) {
    if (numCols <= 1 || items.length <= 1) return [items.slice()];
    const weights = items.map(weightOf);
    const total = weights.reduce((a, b) => a + b, 0);
    const target = total / numCols;
    const cols = []; let cur = []; let curW = 0;
    for (let i = 0; i < items.length; i++) {
      cur.push(items[i]); curW += weights[i];
      const itemsLeft = items.length - 1 - i;
      const colsLeft = numCols - cols.length - 1;   // この列を閉じた後に残る列数
      if (cols.length < numCols - 1 && curW >= target && itemsLeft >= colsLeft && colsLeft > 0) {
        cols.push(cur); cur = []; curW = 0;
      }
    }
    cols.push(cur);
    return cols;
  },

  // 画面（stageW×stageH）に最も大きく収まる列数を 1〜maxCols から選ぶ（解析的に scale を比較）
  pickColumnCount(office, stageW, stageH, maxCols = 4) {
    const employees = (Sync.cache.employees || []).filter(e =>
      (e.category === '現場監督' || e.category === '準現場監督') && e.department === office);
    if (employees.length <= 1) return 1;
    const assignments = Sync.cache.assignments || [];
    const cells = this.buildCells();
    const colW = this.LABEL_WIDTH + this.cellsTotalWidth(cells);
    const headerH = 60;
    const gap = 24;
    const totalRowH = employees.reduce((s, e) => s + this.supervisorRowHeight(e, assignments), 0);
    const cap = Math.min(maxCols, employees.length);
    let best = 1, bestScale = 0;
    for (let c = 1; c <= cap; c++) {
      const W = c * colW + (c - 1) * gap;
      const H = headerH + totalRowH / c;
      const scale = Math.min(stageW / W, stageH / H);
      if (scale > bestScale + 1e-6) { bestScale = scale; best = c; }
    }
    return best;
  },

  // ===== 4. 資格軸 =====

  renderQualificationGantt() {
    const employees = (Sync.cache.employees || []).filter(e => e.category !== '対象外');
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const quals = Sync.cache.qualifications || [];
    const eqs = Sync.cache.employee_qualifications || [];

    if (quals.length === 0 || eqs.length === 0) {
      return '<p class="p-4 text-slate-500">資格データがありません</p>';
    }
    if (this.qualCategoryFilter.size === 0) {
      return '<p class="p-4 text-slate-500">表示する区分を1つ以上選択してください。</p>';
    }

    const empMap = {};
    employees.forEach(e => empMap[e.id] = e);
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    // 資格グループは 1級 → 2級 → その他 の順に表示（同順位は名前順）
    const qualRank = (n) => { const s = String(n || ''); return s.includes('1級') ? 0 : s.includes('2級') ? 1 : 2; };
    const sortedQuals = quals.slice().sort((a, b) => {
      const d = qualRank(a.name) - qualRank(b.name);
      return d !== 0 ? d : String(a.name || '').localeCompare(String(b.name || ''), 'ja');
    });

    let html = `<table class="border-collapse gantt-table" style="width:max-content">${this.headerHtml(cells)}<tbody>`;

    sortedQuals.forEach(q => {
      // 区分トグルで選択中の区分の保有者のみ（単一/複数選択に対応）
      const holders = eqs
        .filter(eq => eq.qual_id === q.id)
        .map(eq => ({ emp: empMap[eq.emp_id], eq }))
        .filter(x => x.emp && this.qualCategoryFilter.has(x.emp.category));
      if (holders.length === 0) return;

      html += '<tr class="bg-blue-900 text-white">' +
        `<td class="p-2 sticky left-0 bg-blue-900 border-r z-10" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px">` +
          `<div class="font-bold text-sm">${this.esc(q.name)}</div>` +
          `<div class="text-xs text-blue-200">${this.esc(q.type)} / 保有者 ${holders.length}名</div>` +
        '</td>' +
        `<td colspan="${colCount}" style="height:36px; padding:0; background:#1e3a8a"></td>` +
      '</tr>';

      holders.forEach(({ emp, eq }) => {
        const myAsgs = assignments.filter(a => a.emp_id === emp.id && (this.showCompleted || !a.completed) && (this.showProspects || !a.prospect));
        const rowH = Math.max(48, 16 + Math.max(1, myAsgs.length) * (this.BAR_HEIGHT + this.BAR_GAP));
        const special = Sync.isSpecialWorkMode && Sync.isSpecialWorkMode(emp.work_mode);
        const wmPeriod = special && !!(emp.work_mode_start || emp.work_mode_end);
        const tintWhole = special && !wmPeriod;
        const labelBg = tintWhole ? `;${this.workModeBg(emp.work_mode)}` : '';
        const tlStyle = tintWhole ? ` ${this.workModeTimelineStyle(emp.work_mode)}` : '';

        let expWarn = '';
        if (eq.expiry) {
          const now = new Date();
          const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
          const exp = new Date(eq.expiry);
          if (exp < now) expWarn = `<span class="bg-red-100 text-red-700 px-1 py-0.5 rounded text-[10px] ml-1">⚠ 期限切れ ${eq.expiry}</span>`;
          else if (exp <= in90) expWarn = `<span class="bg-amber-100 text-amber-700 px-1 py-0.5 rounded text-[10px] ml-1">! 〜${eq.expiry}</span>`;
        }

        html += '<tr class="border-t">' +
          `<td class="p-2 sticky left-0 ${tintWhole ? '' : 'bg-white'} border-r z-10 pl-6 align-top" style="width:${this.LABEL_WIDTH}px;min-width:${this.LABEL_WIDTH}px${labelBg}">` +
            `<div class="text-sm font-medium">${this.esc(emp.name)}${expWarn}</div>` +
            `<div class="text-xs text-slate-500 mt-1 flex flex-wrap items-center gap-1">${this.esc(emp.department || '')} ${PoolView.categoryBadge(emp.category)}${special ? this.workModeBadge(emp.work_mode) : ''}</div>` +
          '</td>' +
          `<td colspan="${colCount}" style="position:relative; height:${rowH}px; padding:0;${tlStyle}">` +
            this.gridDivs(cells, tintWhole ? this.workModeLine(emp.work_mode) : null) +
            todayMarkerHtml +
            (wmPeriod ? this.workModeBandHtml(emp, cells) : '') +
            // Point4: 資格軸でも空き帯（通常稼働の現場監督のみ・派遣/専従/準現場監督は除外）
            ((!special && emp.category === '現場監督') ? this.availabilityBandsHtml(myAsgs, cells, projects) : '');

        myAsgs.forEach((a, idx) => {
          const proj = projects.find(p => p.project_id === a.project_id);
          if (!proj) return;
          const start = this.parseDate(a.join);
          const end = this.parseDate(a.planned_end || proj.end);
          const style = this.resolveBarStyle(a, proj);
          const top = 8 + idx * (this.BAR_HEIGHT + this.BAR_GAP);
          const projLabel = (proj.contract_type || '').includes('元請') ? `[元請] ${a.project_name}` : a.project_name;
          html += this.prepBarHtml(a, cells, style.color, top);
          html += this.renderBar(start, end, cells, style.color, projLabel, top, `${a.project_name}（${style.role}） ${a.join}〜${a.planned_end || proj.end}${a.prospect ? '【見込み】' : ''}`, style.dashed, a.assignment_id);
        });
        if (myAsgs.length === 0) {
          html += '<div style="position:absolute;left:8px;top:14px;color:#94a3b8;font-size:11px">配置なし</div>';
        }
        html += '</td></tr>';
      });
    });
    html += '</tbody></table>';

    html += this.legendRole();
    html += this.legendWorkMode();
    html += '<p class="text-xs text-slate-500 p-3 border-t">※ 縦軸は資格別グループ（1級→2級→その他の順）。区分ボタンで現場監督／準現場監督／監督サポートの表示を切替できます。同一人が複数資格を保有する場合は各グループに重複表示。資格の取得日・有効期限の詳細は「監督ダッシュボード」を参照。</p>';
    return html;
  },

  legendRole() {
    let html = '<div class="p-3 border-t bg-slate-50 text-xs flex flex-wrap gap-3 items-center">' +
      '<span class="font-semibold text-slate-700">色＝役割:</span>';
    Object.entries(this.ROLE_COLOR).forEach(([k, v]) => {
      const note = (k === '監理技術者') ? '<span class="text-[10px] text-red-700 ml-0.5">(元請の主任)</span>' : '';
      html += `<span class="inline-flex items-center gap-1"><span style="display:inline-block;width:14px;height:14px;background:${v};border-radius:3px"></span>${this.esc(k)}${note}</span>`;
    });
    // 役割色×点線のサンプル（副監督色で代表表示）
    const sampleColor = this.ROLE_COLOR['副監督'];
    html += `<span class="inline-flex items-center gap-1 ml-3"><span style="display:inline-block;width:14px;height:14px;border:2px dashed ${sampleColor};border-radius:3px;background:${this.toLightBg(sampleColor)};box-sizing:border-box"></span>点線＝配置未定・不足（役割色のまま）</span>`;
    html += '<span class="inline-flex items-center gap-1 ml-3"><span style="display:inline-block;width:2px;height:14px;background:#ef4444"></span>今日</span>';
    html += '<span class="inline-flex items-center gap-1 ml-3"><span class="bg-red-100 text-red-700 border border-red-300 px-1.5 py-0 rounded text-[10px] font-bold">元請</span>5,000万円以上で監理技術者必要</span>';
    html += '</div>';
    return html;
  },
};
