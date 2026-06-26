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
    const ob = document.getElementById('bi-open-btn');
    if (ob) ob.addEventListener('click', () => this.openFullscreen());
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
    this.currentId = null;
    const ob = document.getElementById('bi-open-btn');
    if (ob) ob.disabled = true;
    const del = document.getElementById('bi-delete-btn');
    if (del) del.classList.add('hidden');
    const v = document.getElementById('bi-launch');
    const hint = this.isAdmin()
      ? '右上の「ダッシュボードを追加・差替」から経営分析ダッシュボードの HTML をアップロードしてください。'
      : '管理者がダッシュボードをアップロードすると、ここから開けます。';
    if (v) v.innerHTML = `<div class="text-center text-slate-400 text-sm py-8">経営分析ダッシュボードはまだありません。<br>${hint}</div>`;
  },

  // 選択中バージョンのランチャーを表示（埋め込みはせず、別タブの全画面で開く）
  showReport(id) {
    if (!id) { this.renderEmpty(); return; }
    this.currentId = id;
    const sel = document.getElementById('bi-version');
    if (sel && sel.value !== String(id)) sel.value = String(id);
    const ob = document.getElementById('bi-open-btn');
    if (ob) ob.disabled = false;
    const del = document.getElementById('bi-delete-btn');
    if (del) del.classList.toggle('hidden', !this.isAdmin());
    const r = this.reports.find(x => String(x.id) === String(id));
    const v = document.getElementById('bi-launch');
    if (!v) return;
    const ver = r ? `${this.esc(this.fmtYM(r.year_month))}${r.title ? '（' + this.esc(r.title) + '）' : ''}` : '';
    const updated = (r && r.uploaded_at) ? String(r.uploaded_at).slice(0, 10) : '';
    v.innerHTML = `
      <div class="text-center py-6">
        <div class="text-5xl mb-3">📊</div>
        <div class="text-lg font-bold text-slate-800 mb-1">${ver}</div>
        ${updated ? `<div class="text-xs text-slate-400 mb-4">最終更新 ${this.esc(updated)}</div>` : '<div class="mb-4"></div>'}
        <p class="text-sm text-slate-500 mb-5">ドリルダウン分析は<strong>別タブの全画面</strong>で開きます。<br>画面を広く使えるので、面→線→点の分析がしやすくなります。</p>
        <button id="bi-open-btn-lg" class="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-lg text-sm font-semibold shadow">🖥 全画面で開く（別タブ）</button>
      </div>`;
    const big = document.getElementById('bi-open-btn-lg');
    if (big) big.addEventListener('click', () => this.openFullscreen());
  },

  // 別タブで全画面表示（?bi=<id>）。ツールの index.html が ?bi を検知し全画面iframeで描画。
  openFullscreen() {
    if (!this.currentId) return;
    window.open(location.pathname + '?bi=' + encodeURIComponent(this.currentId), '_blank');
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
