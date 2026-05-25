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
        this.updateEditorUI();
        await this.loadData();   // 編集ボタンを隠した状態で再描画
      } else {
        openModal();
      }
    });
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
  },

  setupLogout() {
    document.getElementById('logout-button').addEventListener('click', () => {
      Auth.clearSession();
      location.reload();
    });
  },

  setupSync() {
    document.getElementById('sync-button').addEventListener('click', async () => {
      await this.loadData();
    });
  },

  async loadData() {
    try { await Sync.syncAll(); } catch (e) { console.error('Sync失敗:', e); }
    try { this.updateLastSync(); } catch (e) { console.error('updateLastSync失敗:', e); }
    try { PoolView.refresh(); } catch (e) { console.error('PoolView失敗:', e); }
    try { GanttView.refresh(); } catch (e) { console.error('GanttView失敗:', e); }
    try { DashboardView.refresh(); } catch (e) { console.error('DashboardView失敗:', e); }
    try { ProspectsView.refresh(); } catch (e) { console.error('ProspectsView失敗:', e); }
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
