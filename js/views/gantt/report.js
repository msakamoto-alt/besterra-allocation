/**
 * gantt/report.js - 週次レポート出力（工事部員配置状況）
 *
 * 毎週月曜9:30の全体会議で共有する「工事部員配置状況（YYYY.M.D）」を
 * 現場人員配置タブからワンクリックで出力する。
 *   - 構成 = タイトル＋稼働サマリー表＋全事務所の監督配置ボード（renderOfficeMonitor 再利用・2列）
 *   - 出力 = 自己完結HTML（印刷CSS付き）／PDF（html2canvas＋jsPDF・1枚長尺）
 *   - 「アーカイブに保存」チェックON時（admin/editorのみ）は、事務所別サマリーを
 *     allocation_snapshots へ、本文（HTML＋PDF）を allocation_reports へ記録し、
 *     モーダル内の「過去のレポート」一覧から後日いつでも参照・再ダウンロードできる
 *
 * 集計定義（会議報告値なので固定・変更時はSQLコメントと突合すること）:
 *   - 監督者数 = 「〜事務所」所属の現場監督＋準現場監督
 *   - 稼働     = その月に1日でも配置バー（join〜planned_end、無ければ工期末）が重なる監督
 *                完成工事は除外・見込み案件は含む（ガントの既定表示と同じ）
 *   - 時点     = 当月・+3/+6/+9ヶ月のローリング（REPORT_OFFSETS）。当月は「稼働」、
 *                +3/+6/+9ヶ月は未確定の見込みのため見出しに「予定」を付ける（summaryTableHtml）
 *
 * ボード描画はガントのUI状態（表示期間・トグル）に依存させず、
 * withReportDisplayState で「当月〜8ヶ月先・月次・完成除外・見込み含む」に固定して描画する。
 */

Object.assign(GanttView, {

  // ボードの表示月数（当月〜+8ヶ月＝9列）
  REPORT_MONTH_SPAN: 9,
  // サマリーの時点（当月からの月オフセット）
  REPORT_OFFSETS: [0, 3, 6, 9],
  // 事務所の表示順（部分一致・前優先。リスト外は末尾で五十音順）
  REPORT_OFFICE_ORDER: ['本社', '千葉', '京浜', '西日本', '九州'],

  // レポート専用CSS（アプリ内プレビュー・PDF描画・自己完結HTMLで共用）
  REPORT_CSS: [
    '.report-root { background:#fff; color:#0f172a; padding:24px; width:max-content; min-width:100%; }',
    '.report-root h1 { font-size:22px; font-weight:800; margin:0 0 14px; }',
    '.report-summary { margin-bottom:20px; }',
    '.report-summary-table { border-collapse:collapse; font-size:14px; }',
    '.report-summary-table th, .report-summary-table td { border:1px solid #94a3b8; padding:4px 14px; text-align:center; }',
    '.report-summary-table thead th { background:#f1f5f9; font-weight:700; }',
    '.report-summary-table td.rname { font-weight:600; text-align:left; }',
    '.report-summary-table tr.total td { font-weight:700; background:#f8fafc; }',
    '.report-summary-table.compact { font-size:12px; }',
    '.report-summary-table.compact th, .report-summary-table.compact td { padding:2px 10px; }',
    '.report-office { margin-bottom:22px; break-inside:avoid; }',
    '.report-office-head { background:#0f172a; color:#fff; font-weight:700; padding:6px 12px; font-size:15px; }',
    '.report-office-head span { font-weight:400; font-size:11px; color:#cbd5e1; margin-left:8px; }',
    '.report-office-body { border:1px solid #e2e8f0; padding:8px; overflow:hidden; }',
    // html2canvas が flex gap を無視する既知問題への保険（列間はマージンで確保）
    '.report-office-body .gantt-table { margin-right:24px; }',
    // html2canvasはposition:stickyを正しく描画できず表示がずれるため、レポート内は無効化
    '.report-root .gantt-table thead, .report-root .sticky { position:static !important; top:auto !important; left:auto !important; z-index:auto !important; }',
    '.report-legend { margin-bottom:16px; }',
    '.report-foot { font-size:11px; color:#64748b; margin-top:8px; }',
    '@media print {',
    '  @page { size: A3 landscape; margin: 8mm; }',
    '  .report-root { zoom: 0.72; }',
    '  .report-office { break-inside: avoid; }',
    '}',
  ].join('\n'),

  // PDF生成ライブラリ（初回のPDF出力時にのみ遅延ロード）
  REPORT_PDF_LIBS: [
    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  ],

  // ===== 初期化（gantt.js の init() 末尾から呼ばれる）=====

  initReportUi() {
    const btn = document.getElementById('gantt-report-btn');
    if (!btn) return;
    btn.addEventListener('click', () => this.openReportModal());

    const modal = document.getElementById('report-modal');
    if (!modal) return;
    const close = () => modal.classList.add('hidden');
    document.getElementById('report-modal-close').addEventListener('click', close);
    Util.bindModalClose(modal, close);
    document.getElementById('report-dl-html').addEventListener('click', () => this.exportReport('html'));
    document.getElementById('report-dl-pdf').addEventListener('click', () => this.exportReport('pdf'));

    const archiveList = document.getElementById('report-archive-list');
    if (archiveList) {
      archiveList.addEventListener('click', (e) => {
        const viewBtn = e.target.closest('[data-archive-view]');
        if (viewBtn) { this.viewArchiveHtml(viewBtn.dataset.archiveView); return; }
        const pdfBtn = e.target.closest('[data-archive-pdf]');
        if (pdfBtn) { this.downloadArchivePdf(pdfBtn.dataset.archivePdf); return; }
      });
    }

    // モーダル内プレビューとPDF描画が使うレポートCSSを一度だけ注入
    if (!document.getElementById('report-style')) {
      const st = document.createElement('style');
      st.id = 'report-style';
      st.textContent = this.REPORT_CSS;
      document.head.appendChild(st);
    }
  },

  openReportModal() {
    const modal = document.getElementById('report-modal');
    if (!modal) return;
    const sum = this.buildReportSummary();
    document.getElementById('report-modal-date').textContent = this.reportDateLabel();
    document.getElementById('report-modal-preview').innerHTML = this.summaryTableHtml(sum, true);
    // DB記録は編集権限（admin/editor）のみ。権限がなければチェック不可で理由を表示
    const cb = document.getElementById('report-save-db');
    const can = !!(Sync.canEdit && Sync.canEdit());
    cb.disabled = !can;
    cb.checked = can;
    document.getElementById('report-save-db-note').textContent = can ? '' : '（編集権限がないため記録できません）';
    this.setReportStatus('');
    modal.classList.remove('hidden');
    this.loadReportArchiveList();
  },

  setReportStatus(text, isError) {
    const el = document.getElementById('report-modal-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'text-xs mr-auto ' + (isError ? 'text-red-600' : 'text-slate-500');
  },

  // ===== 日付・対象 =====

  // 基準日の上書き（自動実行スクリプト専用）。'YYYY-MM-DD' を設定すると reportToday() がそれを返す。
  // 手動クリック（ブラウザ操作）では未設定のまま＝常に「押した瞬間の今日」。
  // 用途：金曜17時に自動実行しても、タイトル・ファイル名・当月判定は「直近の月曜」を基準にするため。
  reportDateOverride: null,

  reportToday() {
    if (this.reportDateOverride) {
      const d = new Date(this.reportDateOverride + 'T00:00:00');
      d.setHours(0, 0, 0, 0);
      return d;
    }
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  },

  // 実際にレポートを生成した時刻（基準日オーバーライドの影響を受けない・常に実時計）。
  // フッターの「生成日時」表示用。自動実行が金曜夜等でも、いつ作られたかが分かるようにする。
  reportGeneratedAtLabel() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  // タイトル用「2026.7.13」
  reportDateLabel() {
    const d = this.reportToday();
    return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  },

  // ファイル名用「工事部員配置状況(26.7.13)」（会議共有の既存命名に合わせる）
  reportFileStem() {
    const d = this.reportToday();
    return `工事部員配置状況(${String(d.getFullYear()).slice(2)}.${d.getMonth() + 1}.${d.getDate()})`;
  },

  // DB保存用のISO日付（YYYY-MM-DD）。allocation_snapshots/allocation_reports 共通の taken_on。
  reportIsoDate() {
    const d = this.reportToday();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  // 'YYYY-MM-DD' → 「工事部員配置状況(26.7.13)」形式（アーカイブ一覧からの再ダウンロード用）
  stemFromIsoDate(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return `工事部員配置状況(${String(y).slice(2)}.${m}.${d})`;
  },

  // 対象事務所 = 現場監督・準現場監督が所属する「〜事務所」。既定順（REPORT_OFFICE_ORDER）で返す
  reportOffices() {
    const emps = (Sync.cache.employees || []).filter(e =>
      (e.category === '現場監督' || e.category === '準現場監督') &&
      String(e.department || '').includes('事務所'));
    const byOffice = {};
    emps.forEach(e => { (byOffice[e.department] = byOffice[e.department] || []).push(e); });
    const idx = (d) => {
      const s = String(d || '');
      for (let i = 0; i < this.REPORT_OFFICE_ORDER.length; i++) {
        if (s.includes(this.REPORT_OFFICE_ORDER[i])) return i;
      }
      return this.REPORT_OFFICE_ORDER.length;
    };
    return Object.keys(byOffice)
      .sort((a, b) => {
        const ai = idx(a), bi = idx(b);
        if (ai !== bi) return ai - bi;
        return String(a).localeCompare(String(b), 'ja');
      })
      .map(name => ({ name, employees: byOffice[name] }));
  },

  // サマリーの時点（当月・+3・+6ヶ月）。label は当年なら「7月」、年またぎは「2027/1月」
  reportMonths() {
    const t = this.reportToday();
    return this.REPORT_OFFSETS.map(off => {
      const d = new Date(t.getFullYear(), t.getMonth() + off, 1);
      const label = d.getFullYear() === t.getFullYear()
        ? `${d.getMonth() + 1}月`
        : `${d.getFullYear()}/${d.getMonth() + 1}月`;
      return { offset: off, date: d, label, key: `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}` };
    });
  },

  // ===== 集計 =====

  // その月に1日でも配置バーが重なる監督の人数（完成工事除外・見込み含む）
  reportActiveCount(employees, offsetMonths) {
    const t = this.reportToday();
    const mStart = new Date(t.getFullYear(), t.getMonth() + offsetMonths, 1);
    const mNext = new Date(t.getFullYear(), t.getMonth() + offsetMonths + 1, 1);
    const assignments = (Sync.cache.assignments || []).filter(a => !a.completed);
    const projById = new Map((Sync.cache.projects || []).map(p => [p.project_id, p]));
    return employees.filter(e => assignments.some(a => {
      if (a.emp_id !== e.id) return false;
      const proj = projById.get(a.project_id);
      const endRaw = a.planned_end || (proj && proj.end);
      if (!a.join || !endRaw) return false;
      return this.parseDate(a.join) < mNext && this.parseDate(endRaw) >= mStart;
    })).length;
  },

  buildReportSummary() {
    const months = this.reportMonths();
    const offices = this.reportOffices().map(o => ({
      name: o.name,
      supervisors: o.employees.length,
      active: months.map(m => this.reportActiveCount(o.employees, m.offset)),
    }));
    const total = {
      name: '計',
      supervisors: offices.reduce((s, o) => s + o.supervisors, 0),
      active: months.map((m, i) => offices.reduce((s, o) => s + o.active[i], 0)),
    };
    return { months, offices, total };
  },

  // ===== HTML組み立て =====

  // サマリー表。compact=true はモーダルプレビュー用の小型表示
  summaryTableHtml(sum, compact) {
    const m = sum.months;
    const shortName = (n) => String(n).replace(/事務所$/, '');
    const rate = (o) => o.supervisors ? Math.round(o.active[0] / o.supervisors * 100) + '%' : '-';
    const row = (o, cls) =>
      `<tr${cls ? ` class="${cls}"` : ''}><td class="rname">${this.esc(shortName(o.name))}</td>` +
      `<td>${o.supervisors}</td><td>${o.active[0]}</td><td>${rate(o)}</td>` +
      `<td>${o.active[1]}</td><td>${o.active[2]}</td><td>${o.active[3]}</td></tr>`;
    // 当月は確定値なので「稼働」、+3/+6/+9ヶ月は未確定の見込みなので「稼働予定」と明示する
    return `<table class="report-summary-table${compact ? ' compact' : ''}"><thead><tr>` +
      `<th></th><th>監督者数</th><th>${m[0].label}稼働</th><th>稼働率</th>` +
      `<th>${m[1].label}稼働予定</th><th>${m[2].label}稼働予定</th><th>${m[3].label}稼働予定</th>` +
      '</tr></thead><tbody>' +
      sum.offices.map(o => row(o)).join('') +
      row(sum.total, 'total') +
      '</tbody></table>';
  },

  // ボード描画中だけ表示状態を「当月〜8ヶ月先・月次・完成除外・見込み含む」に固定する
  withReportDisplayState(fn) {
    const saved = {
      displayStart: this.displayStart,
      displayEnd: this.displayEnd,
      expandedMonths: this.expandedMonths,
      showCompleted: this.showCompleted,
      showProspects: this.showProspects,
    };
    const t = this.reportToday();
    this.displayStart = new Date(t.getFullYear(), t.getMonth(), 1);
    this.displayEnd = new Date(t.getFullYear(), t.getMonth() + this.REPORT_MONTH_SPAN - 1, 1);
    this.expandedMonths = new Set();
    this.showCompleted = false;
    this.showProspects = true;
    try {
      return fn();
    } finally {
      Object.assign(this, saved);
    }
  },

  // レポート本文（タイトル＋サマリー＋全事務所ボード＋凡例＋脚注）
  buildReportBodyHtml(sum) {
    let boards = '';
    this.withReportDisplayState(() => {
      sum.offices.forEach(o => {
        boards +=
          '<section class="report-office">' +
            `<div class="report-office-head">${this.esc(o.name)}<span>監督配置ボード</span></div>` +
            `<div class="report-office-body">${this.renderOfficeMonitor(o.name, 2, { legend: false })}</div>` +
          '</section>';
      });
      boards += `<div class="report-legend">${this.legendRole()}${this.legendWorkMode()}</div>`;
    });
    return '<div class="report-root">' +
      `<h1>工事部員配置状況（${this.reportDateLabel()}）</h1>` +
      `<div class="report-summary">${this.summaryTableHtml(sum, false)}</div>` +
      boards +
      `<div class="report-foot">出力元: 統合管理ツール「現場人員配置」／稼働 = その月に1日でも配置がある監督（完成工事除外・見込み案件含む）／ボード表示 = 当月〜8ヶ月先（月次）／生成日時: ${this.reportGeneratedAtLabel()}</div>` +
      '</div>';
  },

  // 自己完結HTML文書（Tailwind CDN＋アプリCSS＋レポートCSSを同梱）
  buildStandaloneHtml(bodyHtml, appCss) {
    return '<!DOCTYPE html>\n<html lang="ja">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      `<title>工事部員配置状況（${this.reportDateLabel()}）</title>\n` +
      '<script src="https://cdn.tailwindcss.com"><\/script>\n' +
      `<style>\n${appCss}\n</style>\n<style>\n${this.REPORT_CSS}\n</style>\n` +
      '</head>\n<body class="bg-white">\n' + bodyHtml + '\n</body>\n</html>\n';
  },

  // アプリのCSS(styles.css)を取得してから buildStandaloneHtml を組み立てる（取得失敗時はTailwindのみで継続）。
  // ダウンロード（'html'）でもアーカイブ保存でも同じ完成形が要るため共通化。
  async buildStandaloneHtmlWithCss(bodyHtml) {
    let appCss = '';
    try {
      appCss = await (await fetch('css/styles.css')).text();
    } catch (e) {
      console.warn('styles.css の取得に失敗（Tailwindのみで出力継続）:', e);
    }
    return this.buildStandaloneHtml(bodyHtml, appCss);
  },

  // ===== 出力 =====

  downloadBlob(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  },

  async exportReport(kind) {
    try {
      this.setReportStatus('レポートを生成しています…');
      const sum = this.buildReportSummary();
      const body = this.buildReportBodyHtml(sum);
      let htmlDoc = null;
      let pdfDataUri = null;

      if (kind === 'html') {
        htmlDoc = await this.buildStandaloneHtmlWithCss(body);
        this.downloadBlob(this.reportFileStem() + '.html', new Blob([htmlDoc], { type: 'text/html;charset=utf-8' }));
      } else {
        pdfDataUri = await this.exportReportPdf(body);
      }

      // アーカイブ保存（チェックON かつ 編集権限あり）：サマリー数値＋本文（HTML＋PDF）を記録。
      // 一覧からの再現性を優先し、今回のクリックで作らなかった方の成果物も追加生成する
      // （PDFはブラウザに再ダウンロードさせない＝silent指定）。
      const cb = document.getElementById('report-save-db');
      if (cb && cb.checked && !cb.disabled && Sync.canEdit()) {
        this.setReportStatus('サマリー・アーカイブを保存しています…');
        if (!htmlDoc) htmlDoc = await this.buildStandaloneHtmlWithCss(body);
        if (!pdfDataUri) pdfDataUri = await this.exportReportPdf(body, { silent: true });
        await this.recordReportSnapshot(sum);
        await this.recordReportArchive(htmlDoc, pdfDataUri);
        this.loadReportArchiveList();
        this.setReportStatus('ダウンロードとアーカイブ保存が完了しました');
      } else {
        this.setReportStatus('ダウンロードが完了しました');
      }
    } catch (e) {
      console.error('週次レポート出力失敗:', e);
      this.setReportStatus('出力に失敗しました: ' + (e.message || e), true);
    }
  },

  loadScriptOnce(src) {
    this._loadedScripts = this._loadedScripts || {};
    if (!this._loadedScripts[src]) {
      this._loadedScripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete this._loadedScripts[src]; reject(new Error('スクリプト読込失敗: ' + src)); };
        document.head.appendChild(s);
      });
    }
    return this._loadedScripts[src];
  },

  // html2canvasは<table>の行の高さを正しく揃えて描画できない既知の弱点があり、
  // ラベル列と配置バー列が縦にずれて見える原因になる（DOM自体は正しく配置されている＝
  // ライブ描画では起きない・html2canvasの再計算だけがずれる）。
  // ブラウザが実際に計算した各行の高さをpxで明示し、html2canvasの再計算に頼らず確実に揃える。
  pinTableRowHeights(root) {
    root.querySelectorAll('table.gantt-table tr').forEach(tr => {
      const h = tr.getBoundingClientRect().height;
      if (h > 0) {
        tr.style.height = h + 'px';
        Array.from(tr.children).forEach(td => { td.style.height = h + 'px'; });
      }
    });
  },

  // グリッド線・「空き」帯・不在帯・稼働形態の色帯・今日マーカーはCSSの top+bottom で
  // 縦いっぱいに伸ばす実装だが、html2canvasは bottom 指定の高さ計算を正しく再現できないことがある
  // （実測でtop+heightにすると解消）。実測値をpxのtop/heightに変換し、bottomへの依存を無くす。
  pinAbsoluteBands(root) {
    const sel = '.gantt-gap, .gantt-absence, .gantt-wm-band, [style*="bottom:0"]';
    root.querySelectorAll(sel).forEach(el => {
      const parent = el.offsetParent;
      if (!parent) return;
      const rect = el.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      el.style.top = (rect.top - parentRect.top) + 'px';
      el.style.height = rect.height + 'px';
      el.style.bottom = 'auto';
    });
  },

  // PDF出力 = 画面外に本文を実描画 → html2canvas → 1枚長尺ページのPDF（会議報告の既存PDFと同じ体裁）。
  // opts.silent=true ならブラウザへのファイル保存(pdf.save)を行わず、data URI文字列だけを返す
  // （アーカイブ保存のためだけにPDFを作る場合に、二重ダウンロードさせないため）。
  async exportReportPdf(bodyHtml, opts) {
    await Promise.all(this.REPORT_PDF_LIBS.map(u => this.loadScriptOnce(u)));
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute; left:-100000px; top:0; background:#fff;';
    host.innerHTML = bodyHtml;
    document.body.appendChild(host);
    try {
      const root = host.querySelector('.report-root');
      this.pinTableRowHeights(root);
      this.pinAbsoluteBands(root);
      const canvas = await html2canvas(root, { scale: 1.5, backgroundColor: '#ffffff', logging: false });
      const pdf = new jspdf.jsPDF({
        orientation: canvas.width >= canvas.height ? 'landscape' : 'portrait',
        unit: 'px',
        format: [canvas.width, canvas.height],
        hotfixes: ['px_scaling'],
      });
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, canvas.width, canvas.height);
      if (!(opts && opts.silent)) pdf.save(this.reportFileStem() + '.pdf');
      return pdf.output('datauristring');
    } finally {
      host.remove();
    }
  },

  // ===== 時系列記録 =====

  async recordReportSnapshot(sum) {
    const t = this.reportToday();
    const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const rows = sum.offices.concat([sum.total]).map(o => ({
      taken_on: iso,
      office: o.name,
      supervisors: o.supervisors,
      month_m0: sum.months[0].key,
      active_m0: o.active[0],
      active_m3: o.active[1],
      active_m6: o.active[2],
      active_m9: o.active[3],
      created_by: 'web',
    }));
    await Sync.saveAllocationSnapshots(rows);
  },

  // 本文アーカイブ（HTML＋PDF）を記録。同じ週(taken_on)は上書き。
  async recordReportArchive(htmlDoc, pdfDataUri) {
    await Sync.saveAllocationReportArchive({
      taken_on: this.reportIsoDate(),
      title: `工事部員配置状況（${this.reportDateLabel()}）`,
      html_content: htmlDoc,
      pdf_base64: pdfDataUri || null,
      created_by: 'web',
    });
  },

  // ===== 過去のレポート一覧（モーダル内） =====

  async loadReportArchiveList() {
    const listEl = document.getElementById('report-archive-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="p-3 text-slate-400 text-xs">読み込み中…</div>';
    try {
      const rows = await Sync.listAllocationReports();
      if (!rows.length) {
        listEl.innerHTML = '<div class="p-3 text-slate-400 text-xs">まだ保存されたレポートはありません。</div>';
        return;
      }
      listEl.innerHTML = rows.map(r => (
        '<div class="flex items-center justify-between px-3 py-2">' +
          `<span>${this.esc(r.title || r.taken_on)}</span>` +
          '<span class="flex gap-3 flex-none">' +
            `<button class="text-blue-700 hover:underline text-xs" data-archive-view="${r.id}">表示</button>` +
            `<button class="text-slate-600 hover:underline text-xs" data-archive-pdf="${r.id}">PDF</button>` +
          '</span>' +
        '</div>'
      )).join('');
    } catch (e) {
      listEl.innerHTML = `<div class="p-3 text-red-600 text-xs">読み込み失敗: ${this.esc(e.message || e)}</div>`;
    }
  },

  // 過去の週のHTMLを新しいタブで開く（プレビュー相当）
  async viewArchiveHtml(id) {
    try {
      const data = await Sync.fetchAllocationReportContent(id);
      if (!data) return;
      const blob = new Blob([data.html_content], { type: 'text/html' });
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (e) {
      this.setReportStatus('表示に失敗しました: ' + (e.message || e), true);
    }
  },

  // 過去の週のPDFを再ダウンロード（アーカイブ時にPDFが無い週はスキップしメッセージ表示）
  async downloadArchivePdf(id) {
    try {
      const data = await Sync.fetchAllocationReportContent(id);
      if (!data) return;
      if (!data.pdf_base64) {
        this.setReportStatus('この週はPDFが保存されていません（HTMLのみ）。', true);
        return;
      }
      const res = await fetch(data.pdf_base64);
      const blob = await res.blob();
      this.downloadBlob(this.stemFromIsoDate(data.taken_on) + '.pdf', blob);
    } catch (e) {
      this.setReportStatus('PDFの取得に失敗しました: ' + (e.message || e), true);
    }
  },

});
