/**
 * axes.js - 軸レンダラ（現場/事務所/監督/事務所×監督/資格）・稼働形態/不在帯・事務所モニター
 *
 * js/views/gantt.js の GanttView にメソッドを追加するモジュール（2026-07 刷新で分割）。
 * メソッド本体は旧 gantt.js から無変更で移動。gantt.js より後・board.js より前に読み込むこと。
 */
Object.assign(GanttView, {
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
        `<div class="text-xs text-slate-500">${this.esc(p.project_id)} / ${Util.fmtMillions(p.amount)} / ${this.esc(p.dept)}</div>` +
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
    const visibleRaw = projects.filter(p => {
      if (p.completed && !this.showCompleted) return false;
      if (p.prospect && !this.showProspects) return false;
      return this.clipRange(this.parseDate(p.start), this.parseDate(p.end), cells);
    });

    // 検索絞り込み（現場軸と共通：工事名・工事番号・客先）。ヒットしない事務所グループは消える
    const visible = this.applyProjectSearch(visibleRaw);
    if (visible.length === 0 && String(this.projectSearchQuery || '').trim()) {
      return `<p class="p-4 text-slate-500">「${this.esc(this.projectSearchQuery)}」に一致する現場がありません（表示期間・完成/見込みトグルもご確認ください）</p>`;
    }

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
          `<div class="text-xs text-slate-300">管轄工事 ${projs.length}件 / ${Util.fmtMillions(amount)}</div>` +
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
    const employeesRaw = (Sync.cache.employees || []).filter(e => e.category === '現場監督' || e.category === '準現場監督');
    const assignments = Sync.cache.assignments || [];
    const projects = Sync.cache.projects || [];
    const cells = this.buildCells();
    if (cells.length === 0) return '<p class="p-4 text-slate-500">表示範囲のデータがありません</p>';
    const colCount = cells.length;
    const todayMarkerHtml = this.todayMarker(cells);

    // 検索絞り込み（氏名・社員番号）。ヒットしない事務所グループは自動的に非表示になる
    const employees = this.applySupervisorSearch(employeesRaw);
    if (employees.length === 0 && String(this.supervisorSearchQuery || '').trim()) {
      return `<p class="p-4 text-slate-500">「${this.esc(this.supervisorSearchQuery)}」に一致する監督がいません（表示期間もご確認ください）</p>`;
    }
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
    const employeesRaw = (Sync.cache.employees || []).filter(e => e.category !== '対象外');
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

    // 検索絞り込み（氏名・社員番号）。ヒットしない人は資格グループからも自動的に消える
    const employees = this.applySupervisorSearch(employeesRaw);
    if (employees.length === 0 && String(this.supervisorSearchQuery || '').trim()) {
      return `<p class="p-4 text-slate-500">「${this.esc(this.supervisorSearchQuery)}」に一致する監督がいません（区分・表示期間もご確認ください）</p>`;
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
});
