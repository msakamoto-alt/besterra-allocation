/**
 * management.js - 経営レポート（段階E3: 経営ドッキング）
 *
 * R/F 分析資料・月次経営分析レポートの生成済HTMLを Supabase(management_reports) から取得し、
 * Blob URL 化して iframe で表示する。閲覧=admin/executive のみ（RLSでサーバー強制）、
 * 差替=admin のみ（アプリ内アップロード）。
 *
 * iframe は sandbox="allow-scripts"（allow-same-origin を付けない）。
 *   → 埋込レポートは opaque origin になり、親ページの localStorage（Supabaseセッション）に
 *     触れられない。Chart.js CDN は opaque origin でも読み込み・実行できるので表示は問題ない。
 */
const ManagementView = {
  TYPE_LABELS: { annual: '年度経営分析レポート', analysis: '月次経営分析レポート', rf: 'ローリングフォーキャスト分析資料', bi: '経営分析BI' },

  reports: [],          // メタ一覧（html_content は含まない）
  currentType: 'analysis',
  currentId: null,
  _blobUrl: null,

  init() {
    document.querySelectorAll('.mgmt-type-btn').forEach(btn =>
      btn.addEventListener('click', () => this.setType(btn.dataset.type)));
    const sel = document.getElementById('mgmt-month');
    if (sel) sel.addEventListener('change', () => this.showReport(sel.value));

    // アップロード（admin専用）
    const up = document.getElementById('mgmt-upload-btn');
    if (up) up.addEventListener('click', () => this.openUpload());
    const upClose = document.getElementById('mgmt-upload-close');
    if (upClose) upClose.addEventListener('click', () => this.closeUpload());
    const upCancel = document.getElementById('mgmt-upload-cancel');
    if (upCancel) upCancel.addEventListener('click', () => this.closeUpload());
    const upSave = document.getElementById('mgmt-upload-save');
    if (upSave) upSave.addEventListener('click', () => this.doUpload());
    const modal = document.getElementById('mgmt-upload-modal');
    Util.bindModalClose(modal, () => this.closeUpload());
    const del = document.getElementById('mgmt-delete-btn');
    if (del) del.addEventListener('click', () => this.deleteCurrent());
  },

  canView() { return Sync.role === 'admin' || Sync.role === 'executive' || Sync.role === 'accounting'; },
  isAdmin() { return Sync.isAdmin(); },

  esc(s) { return Util.esc(s); },

  // 'YYYYMM' → '2026年2月'
  fmtYM(ym) {
    const s = String(ym || '').trim();
    const m = s.match(/^(\d{4})(\d{2})$/);
    return m ? `${m[1]}年${parseInt(m[2], 10)}月` : s;
  },

  async refresh() {
    if (!this.canView()) return;
    // admin専用UI（アップロード/削除）の表示切替
    document.querySelectorAll('.mgmt-admin-only').forEach(el => el.classList.toggle('hidden', !this.isAdmin()));
    try {
      this.reports = await Sync.listManagementReports();
    } catch (e) {
      this.reports = [];
      console.error('経営レポート一覧取得失敗:', e);
    }
    this.renderTypeButtons();
    this.populateMonths();
  },

  setType(type) {
    if (!this.TYPE_LABELS[type]) return;
    this.currentType = type;
    this.renderTypeButtons();
    this.populateMonths();
  },

  renderTypeButtons() {
    document.querySelectorAll('.mgmt-type-btn').forEach(btn => {
      const active = btn.dataset.type === this.currentType;
      btn.classList.toggle('bg-red-600', active);
      btn.classList.toggle('text-white', active);
      btn.classList.toggle('border-red-600', active);
      btn.classList.toggle('bg-white', !active);
      btn.classList.toggle('text-slate-700', !active);
      btn.classList.toggle('border-slate-300', !active);
    });
  },

  // 現在の種類のレポートを年月降順で月セレクタに反映し、最新を表示
  populateMonths() {
    const sel = document.getElementById('mgmt-month');
    // 年度版は「対象年度」、月次/R/Fは「対象月」とラベルを切替
    const plabel = document.getElementById('mgmt-period-label');
    if (plabel) plabel.textContent = this.currentType === 'annual' ? '対象年度:'
      : (this.currentType === 'bi' ? 'バージョン:' : '対象月:');
    const list = this.reports
      .filter(r => r.report_type === this.currentType)
      .sort((a, b) => String(b.year_month).localeCompare(String(a.year_month)));
    if (!sel) return;
    sel.innerHTML = list.map(r => {
      // 年度版はタイトル（期）を主ラベルに。月次/R/Fは「YYYY年M月（タイトル）」。
      const label = (this.currentType === 'annual' && r.title)
        ? this.esc(r.title)
        : `${this.esc(this.fmtYM(r.year_month))}${r.title ? '（' + this.esc(r.title) + '）' : ''}`;
      return `<option value="${r.id}">${label}</option>`;
    }).join('');
    if (list.length) {
      sel.disabled = false;
      this.showReport(list[0].id);
    } else {
      sel.disabled = true;
      this.currentId = null;
      this.renderEmpty();
    }
  },

  renderEmpty() {
    const v = document.getElementById('mgmt-viewer');
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    const hint = this.isAdmin()
      ? '右上の「レポートを追加・差替」から生成済HTMLをアップロードしてください。'
      : '管理者がレポートをアップロードすると、ここに表示されます。';
    if (v) v.innerHTML = `<div class="flex items-center justify-center h-64 text-slate-400 text-sm text-center px-4">
      この種類（${this.esc(this.TYPE_LABELS[this.currentType])}）のレポートはまだありません。<br>${hint}</div>`;
    const del = document.getElementById('mgmt-delete-btn');
    if (del) del.classList.add('hidden');
  },

  async showReport(id) {
    if (!id) { this.renderEmpty(); return; }
    this.currentId = id;
    const sel = document.getElementById('mgmt-month');
    if (sel && sel.value !== String(id)) sel.value = String(id);
    const delTop = document.getElementById('mgmt-delete-btn');
    if (delTop) delTop.classList.toggle('hidden', !this.isAdmin());
    // 経営分析BIは埋め込まず、別タブの全画面で開くランチャーを表示
    if (this.currentType === 'bi') { this.renderBiLauncher(id); return; }
    const v = document.getElementById('mgmt-viewer');
    if (v) v.innerHTML = '<div class="flex items-center justify-center h-64 text-slate-400 text-sm">レポートを読み込み中…</div>';
    try {
      const html = await Sync.fetchManagementReportHtml(id);
      if (!html) { this.renderEmpty(); return; }
      this.renderIframe(html);
      const del = document.getElementById('mgmt-delete-btn');
      if (del) del.classList.toggle('hidden', !this.isAdmin());
    } catch (e) {
      if (v) v.innerHTML = `<div class="flex items-center justify-center h-64 text-red-600 text-sm">読み込み失敗: ${this.esc(e.message || e)}</div>`;
    }
  },

  renderIframe(html) {
    const v = document.getElementById('mgmt-viewer');
    if (!v) return;
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    const blob = new Blob([html], { type: 'text/html' });
    this._blobUrl = URL.createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.src = this._blobUrl;
    iframe.setAttribute('sandbox', 'allow-scripts');  // allow-same-origin は付けない（親セッション保護）
    iframe.setAttribute('title', '経営レポート');
    iframe.className = 'w-full';
    iframe.style.cssText = 'height: calc(100vh - 290px); min-height: 480px; border: 0; display: block;';
    v.innerHTML = '';
    v.appendChild(iframe);
  },

  // 経営分析BI：埋め込まず、別タブの全画面（?bi=<id>）で開くランチャー
  renderBiLauncher(id) {
    const v = document.getElementById('mgmt-viewer');
    if (!v) return;
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    const r = this.reports.find(x => String(x.id) === String(id));
    const ver = r ? `${this.esc(this.fmtYM(r.year_month))}${r.title ? '（' + this.esc(r.title) + '）' : ''}` : '';
    const updated = (r && r.uploaded_at) ? String(r.uploaded_at).slice(0, 10) : '';
    v.innerHTML = `<div class="text-center py-12 px-4">
      <div class="text-5xl mb-3">📊</div>
      <div class="text-lg font-bold text-slate-800 mb-1">${ver}</div>
      ${updated ? `<div class="text-xs text-slate-400 mb-4">最終更新 ${this.esc(updated)}</div>` : '<div class="mb-4"></div>'}
      <p class="text-sm text-slate-500 mb-5">ドリルダウン分析は<strong>別タブの全画面</strong>で開きます。<br>画面を広く使えるので、面→線→点の分析がしやすくなります。</p>
      <button id="mgmt-bi-open" class="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-lg text-sm font-semibold shadow">🖥 全画面で開く（別タブ）</button>
    </div>`;
    const btn = document.getElementById('mgmt-bi-open');
    if (btn) btn.addEventListener('click', () => this.openFullscreen());
  },

  openFullscreen() {
    if (!this.currentId) return;
    window.open(location.pathname + '?bi=' + encodeURIComponent(this.currentId), '_blank');
  },

  // ===== アップロード（admin専用）=====
  openUpload() {
    if (!this.isAdmin()) return;
    document.getElementById('mgmt-up-type').value = this.currentType;
    document.getElementById('mgmt-up-month').value = '';
    document.getElementById('mgmt-up-title').value = '';
    document.getElementById('mgmt-up-file').value = '';
    this.setUploadStatus('');
    document.getElementById('mgmt-upload-modal').classList.remove('hidden');
  },
  closeUpload() { document.getElementById('mgmt-upload-modal').classList.add('hidden'); },

  setUploadStatus(msg, isErr) {
    const st = document.getElementById('mgmt-up-status');
    if (!st) return;
    st.textContent = msg;
    st.className = 'text-xs min-h-[16px] ' + (isErr ? 'text-red-600' : 'text-slate-500');
  },

  async doUpload() {
    const type = document.getElementById('mgmt-up-type').value;
    const monthRaw = document.getElementById('mgmt-up-month').value;  // 'YYYY-MM'
    const title = document.getElementById('mgmt-up-title').value.trim();
    const fileInput = document.getElementById('mgmt-up-file');
    const file = fileInput.files && fileInput.files[0];
    const ym = String(monthRaw || '').replace(/-/g, '');  // → 'YYYYMM'

    if (!/^\d{6}$/.test(ym)) return this.setUploadStatus('対象月を選択してください', true);
    if (!file) return this.setUploadStatus('HTMLファイルを選択してください', true);
    if (!/\.html?$/i.test(file.name) && file.type !== 'text/html') {
      return this.setUploadStatus('HTMLファイル（.html）を選択してください', true);
    }
    this.setUploadStatus('読み込み中…');
    try {
      const html = await file.text();
      if (!html || html.length < 50) return this.setUploadStatus('ファイルが空か壊れています', true);
      this.setUploadStatus('アップロード中…');
      await Sync.upsertManagementReport({ report_type: type, year_month: ym, title, html_content: html });
      this.setUploadStatus('✓ 保存しました');
      this.currentType = type;
      await this.refresh();
      // アップロードした月を選択
      const target = this.reports.find(r => r.report_type === type && String(r.year_month) === ym);
      if (target) this.showReport(target.id);
      setTimeout(() => this.closeUpload(), 600);
    } catch (e) {
      this.setUploadStatus('× ' + (e.message || e), true);
    }
  },

  async deleteCurrent() {
    if (!this.isAdmin() || !this.currentId) return;
    const r = this.reports.find(x => String(x.id) === String(this.currentId));
    const label = r ? `${this.TYPE_LABELS[r.report_type]} ${this.fmtYM(r.year_month)}` : 'このレポート';
    if (!confirm(`「${label}」を削除します。よろしいですか？`)) return;
    try {
      await Sync.deleteManagementReport(this.currentId);
      await this.refresh();
    } catch (e) {
      alert('削除に失敗しました: ' + (e.message || e));
    }
  },
};
