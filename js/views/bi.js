/**
 * bi.js - 経営分析（PowerBI移行ダッシュボード埋め込み）タブ
 *
 * management_reports テーブルの report_type='bi' を使い、自己完結HTMLの
 * 経営分析ダッシュボードを Blob URL → iframe(sandbox="allow-scripts") で表示する。
 * E3(経営レポート)と同じ機密モデル：閲覧=admin/executive/accounting（RLSでサーバー強制）、
 * 書込(アップロード/削除)=admin のみ。ダッシュボードはバージョン（ビルド月）で履歴保持。
 */
const BiView = {
  reports: [],
  currentId: null,
  _blobUrl: null,

  init() {
    const up = document.getElementById('bi-upload-btn');
    if (up) up.addEventListener('click', () => this.openUpload());
    const del = document.getElementById('bi-delete-btn');
    if (del) del.addEventListener('click', () => this.deleteCurrent());
    const sel = document.getElementById('bi-version');
    if (sel) sel.addEventListener('change', () => this.showReport(sel.value));
    const c1 = document.getElementById('bi-upload-close');
    if (c1) c1.addEventListener('click', () => this.closeUpload());
    const c2 = document.getElementById('bi-upload-cancel');
    if (c2) c2.addEventListener('click', () => this.closeUpload());
    const sv = document.getElementById('bi-upload-save');
    if (sv) sv.addEventListener('click', () => this.doUpload());
    const modal = document.getElementById('bi-upload-modal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) this.closeUpload(); });
  },

  canView() { return Sync.role === 'admin' || Sync.role === 'executive' || Sync.role === 'accounting'; },
  isAdmin() { return Sync.isAdmin(); },

  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },

  // 'YYYYMM' → '2026年6月'
  fmtYM(ym) {
    const s = String(ym || '').trim();
    const m = s.match(/^(\d{4})(\d{2})$/);
    return m ? `${m[1]}年${parseInt(m[2], 10)}月` : s;
  },

  async refresh() {
    if (!this.canView()) return;
    document.querySelectorAll('.bi-admin-only').forEach(el => el.classList.toggle('hidden', !this.isAdmin()));
    try {
      this.reports = (await Sync.listManagementReports()).filter(r => r.report_type === 'bi');
    } catch (e) {
      this.reports = [];
      console.error('経営分析一覧取得失敗:', e);
    }
    this.populateVersions();
  },

  // バージョン（ビルド月）を降順でセレクタに反映し、最新を表示
  populateVersions() {
    const sel = document.getElementById('bi-version');
    const list = this.reports.slice()
      .sort((a, b) => String(b.year_month).localeCompare(String(a.year_month)));
    if (!sel) return;
    sel.innerHTML = list.map(r => {
      const label = `${this.esc(this.fmtYM(r.year_month))}${r.title ? '（' + this.esc(r.title) + '）' : ''}`;
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
    const v = document.getElementById('bi-viewer');
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    const hint = this.isAdmin()
      ? '右上の「ダッシュボードを追加・差替」から経営分析ダッシュボードの HTML をアップロードしてください。'
      : '管理者がダッシュボードをアップロードすると、ここに表示されます。';
    if (v) v.innerHTML = `<div class="flex items-center justify-center h-64 text-slate-400 text-sm text-center px-4">
      経営分析ダッシュボードはまだありません。<br>${hint}</div>`;
    const del = document.getElementById('bi-delete-btn');
    if (del) del.classList.add('hidden');
  },

  async showReport(id) {
    if (!id) { this.renderEmpty(); return; }
    this.currentId = id;
    const sel = document.getElementById('bi-version');
    if (sel && sel.value !== String(id)) sel.value = String(id);
    const v = document.getElementById('bi-viewer');
    if (v) v.innerHTML = '<div class="flex items-center justify-center h-64 text-slate-400 text-sm">ダッシュボードを読み込み中…</div>';
    try {
      const html = await Sync.fetchManagementReportHtml(id);
      if (!html) { this.renderEmpty(); return; }
      this.renderIframe(html);
      const del = document.getElementById('bi-delete-btn');
      if (del) del.classList.toggle('hidden', !this.isAdmin());
    } catch (e) {
      if (v) v.innerHTML = `<div class="flex items-center justify-center h-64 text-red-600 text-sm">読み込み失敗: ${this.esc(e.message || e)}</div>`;
    }
  },

  renderIframe(html) {
    const v = document.getElementById('bi-viewer');
    if (!v) return;
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    const blob = new Blob([html], { type: 'text/html' });
    this._blobUrl = URL.createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.src = this._blobUrl;
    // allow-same-origin は付けない（親セッション保護）。ダッシュボードのテーマ伝播は postMessage 対応済み。
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('title', '経営分析ダッシュボード');
    iframe.className = 'w-full';
    // 全画面ダッシュボードなので高さを大きく確保
    iframe.style.cssText = 'height: calc(100vh - 210px); min-height: 600px; border: 0; display: block;';
    v.innerHTML = '';
    v.appendChild(iframe);
  },

  // ===== アップロード（admin専用）=====
  openUpload() {
    if (!this.isAdmin()) return;
    document.getElementById('bi-up-month').value = '';
    document.getElementById('bi-up-title').value = '';
    document.getElementById('bi-up-file').value = '';
    this.setUploadStatus('');
    document.getElementById('bi-upload-modal').classList.remove('hidden');
  },
  closeUpload() { document.getElementById('bi-upload-modal').classList.add('hidden'); },

  setUploadStatus(msg, isErr) {
    const st = document.getElementById('bi-up-status');
    if (!st) return;
    st.textContent = msg;
    st.className = 'text-xs min-h-[16px] ' + (isErr ? 'text-red-600' : 'text-slate-500');
  },

  async doUpload() {
    const monthRaw = document.getElementById('bi-up-month').value;  // 'YYYY-MM'
    const title = document.getElementById('bi-up-title').value.trim();
    const fileInput = document.getElementById('bi-up-file');
    const file = fileInput.files && fileInput.files[0];
    const ym = String(monthRaw || '').replace(/-/g, '');  // → 'YYYYMM'

    if (!/^\d{6}$/.test(ym)) return this.setUploadStatus('対象月（ビルド月）を選択してください', true);
    if (!file) return this.setUploadStatus('HTMLファイルを選択してください', true);
    if (!/\.html?$/i.test(file.name) && file.type !== 'text/html') {
      return this.setUploadStatus('HTMLファイル（.html）を選択してください', true);
    }
    this.setUploadStatus('読み込み中…');
    try {
      const html = await file.text();
      if (!html || html.length < 50) return this.setUploadStatus('ファイルが空か壊れています', true);
      this.setUploadStatus('アップロード中…（大きいファイルは時間がかかります）');
      await Sync.upsertManagementReport({ report_type: 'bi', year_month: ym, title, html_content: html });
      this.setUploadStatus('✓ 保存しました');
      await this.refresh();
      const target = this.reports.find(r => String(r.year_month) === ym);
      if (target) this.showReport(target.id);
      setTimeout(() => this.closeUpload(), 600);
    } catch (e) {
      this.setUploadStatus('× ' + (e.message || e), true);
    }
  },

  async deleteCurrent() {
    if (!this.isAdmin() || !this.currentId) return;
    if (!confirm('表示中のダッシュボードを削除します。よろしいですか？')) return;
    try {
      await Sync.deleteManagementReport(this.currentId);
      await this.refresh();
    } catch (e) {
      alert('削除失敗: ' + (e.message || e));
    }
  },
};
