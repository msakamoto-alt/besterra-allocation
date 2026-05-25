/**
 * app.js - アプリ初期化・タブ制御・認証連動
 */

const App = {
  currentTab: 'pool',

  async init() {
    this.setupAuth();
    this.setupEditorAuth();
    this.setupTabs();
    this.setupSync();
    this.setupLogout();

    PoolView.init();
    GanttView.init();
    DashboardView.init();
    ProspectsView.init();
    MemberAdd.init();
    OrgChartView.init();

    if (Auth.getSession()) {
      await this.enterApp();
    }
  },

  // 閲覧ログイン（HTMLパスワード）通過後の共通処理：
  // 編集セッション復元 → 編集UI更新 → データ読込
  async enterApp() {
    this.showMain();
    await Sync.refreshEditorSession();
    this.updateEditorUI();
    await this.loadData();
  },

  setupAuth() {
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('auth-error');
      if (await Auth.verify(password)) {
        Auth.saveSession(password);
        errorEl.classList.add('hidden');
        await this.enterApp();
      } else {
        errorEl.classList.remove('hidden');
      }
    });
  },

  // 編集ログイン（Supabase Auth）。閲覧=anon、編集=authenticated。
  setupEditorAuth() {
    const modal = document.getElementById('editor-login-modal');
    if (!modal) return;
    const closeModal = () => modal.classList.add('hidden');
    const openModal = () => {
      document.getElementById('editor-login-error').classList.add('hidden');
      document.getElementById('editor-login-form').reset();
      modal.classList.remove('hidden');
      document.getElementById('editor-email').focus();
    };

    document.getElementById('editor-toggle').addEventListener('click', async () => {
      if (Sync.isEditor) {
        await Sync.logoutEditor();
        if (this.currentTab === 'orgchart') this.activateTab('pool');  // 組織図は閲覧者には出さない
        this.updateEditorUI();
        await this.loadData();   // 編集ボタンを隠した状態で再描画
      } else {
        openModal();
      }
    });
    // 組織図ボタン（編集者のみ表示）→ 組織図タブを開く
    const orgBtn = document.getElementById('org-toggle');
    if (orgBtn) orgBtn.addEventListener('click', () => this.activateTab('orgchart'));
    document.getElementById('editor-login-close').addEventListener('click', closeModal);
    document.getElementById('editor-login-cancel').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    document.getElementById('editor-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('editor-email').value.trim();
      const password = document.getElementById('editor-password').value;
      const errEl = document.getElementById('editor-login-error');
      const btn = document.getElementById('editor-login-submit');
      errEl.classList.add('hidden');
      btn.disabled = true; btn.textContent = 'ログイン中…';
      try {
        await Sync.loginEditor(email, password);
        closeModal();
        this.updateEditorUI();
        await this.loadData();   // 編集ボタンが出る状態で再描画
      } catch (err) {
        errEl.textContent = '× ' + (err.message || 'ログイン失敗');
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false; btn.textContent = 'ログイン';
      }
    });
  },

  updateEditorUI() {
    const isEd = !!Sync.isEditor;
    const badge = document.getElementById('editor-badge');
    const toggle = document.getElementById('editor-toggle');
    if (badge) badge.classList.toggle('hidden', !isEd);
    if (toggle) toggle.textContent = isEd ? '🔒 編集を終了' : '🔓 編集ログイン';
    // 「同期」は編集者がSheetsから参照データを取込む操作なので閲覧者には隠す
    const syncBtn = document.getElementById('sync-button');
    if (syncBtn) syncBtn.classList.toggle('hidden', !isEd);
    // 「組織図」も編集者のみ
    const orgBtn = document.getElementById('org-toggle');
    if (orgBtn) orgBtn.classList.toggle('hidden', !isEd);
  },

  showMain() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');
  },

  setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.activateTab(btn.dataset.tab));
    });
    this.activateTab('pool');
  },

  activateTab(name) {
    this.currentTab = name;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('tab-active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle('hidden', p.id !== 'tab-' + name);
    });
    if (name === 'gantt') GanttView.refresh();
    if (name === 'prospects') ProspectsView.refresh();
    if (name === 'orgchart') OrgChartView.refresh();
  },

  setupLogout() {
    document.getElementById('logout-button').addEventListener('click', () => {
      Auth.clearSession();
      location.reload();
    });
  },

  setupSync() {
    document.getElementById('sync-button').addEventListener('click', async () => {
      const btn = document.getElementById('sync-button');
      const orig = btn.textContent;
      btn.disabled = true;
      try {
        // 編集者が同期したときだけ Sheets→Supabase（参照系3テーブル）を取込み。
        // 閲覧者・編集後の自動再描画(loadData)では実行しない（重い再投入を避ける）。
        if (Sync.USE_SUPABASE && Sync.canEdit() && typeof Sync.syncReferenceFromSheets === 'function') {
          btn.textContent = 'Sheets取込中…';
          try {
            const n = await Sync.syncReferenceFromSheets();
            console.info('参照データ同期:', n);
          } catch (e) {
            console.error('参照データ同期失敗:', e);
            alert('Sheetsからの参照データ取込みに失敗しました（表示の更新は続行します）:\n' + (e.message || e));
          }
        }
        btn.textContent = '更新中…';
        await this.loadData();
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });
  },

  async loadData() {
    try { await Sync.syncAll(); } catch (e) { console.error('Sync失敗:', e); }
    try { this.updateLastSync(); } catch (e) { console.error('updateLastSync失敗:', e); }
    try { PoolView.refresh(); } catch (e) { console.error('PoolView失敗:', e); }
    try { GanttView.refresh(); } catch (e) { console.error('GanttView失敗:', e); }
    try { DashboardView.refresh(); } catch (e) { console.error('DashboardView失敗:', e); }
    try { ProspectsView.refresh(); } catch (e) { console.error('ProspectsView失敗:', e); }
    try { OrgChartView.refresh(); } catch (e) { console.error('OrgChartView失敗:', e); }
  },

  updateLastSync() {
    const el = document.getElementById('last-sync');
    if (Sync.lastSync) {
      const t = Sync.lastSync;
      el.textContent = `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
    }
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
