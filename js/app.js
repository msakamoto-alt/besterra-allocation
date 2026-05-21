/**
 * app.js - アプリ初期化・イベント処理
 */

const App = {
  state: {
    currentView: 'cards',
    currentCategory: 'all',
    filterDept: '',
    filterRole: '',
    filterName: '',
  },

  async init() {
    this.setupAuth();
    this.setupViewTabs();
    this.setupCategoryTabs();
    this.setupFilters();
    this.setupSync();
    this.setupLogout();

    if (Auth.getSession()) {
      this.showMain();
      await this.loadData();
    }
  },

  setupAuth() {
    const form = document.getElementById('auth-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('auth-error');

      if (await Auth.verify(password)) {
        Auth.saveSession(password);
        errorEl.classList.add('hidden');
        this.showMain();
        await this.loadData();
      } else {
        errorEl.classList.remove('hidden');
      }
    });
  },

  showMain() {
    document.getElementById('auth-screen').classList.remove('active');
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');
    document.getElementById('main-screen').classList.add('active');
  },

  setupLogout() {
    document.getElementById('logout-button').addEventListener('click', () => {
      Auth.clearSession();
      location.reload();
    });
  },

  setupViewTabs() {
    document.querySelectorAll('.view-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        if (tab.disabled) return;
        document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.state.currentView = tab.dataset.view;
        this.render();
      });
    });
  },

  setupCategoryTabs() {
    document.querySelectorAll('.category-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.category-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.state.currentCategory = tab.dataset.category;
        this.render();
      });
    });
  },

  setupFilters() {
    document.getElementById('filter-department').addEventListener('change', (e) => {
      this.state.filterDept = e.target.value;
      this.render();
    });
    document.getElementById('filter-role').addEventListener('change', (e) => {
      this.state.filterRole = e.target.value;
      this.render();
    });
    document.getElementById('filter-name').addEventListener('input', (e) => {
      this.state.filterName = e.target.value.toLowerCase();
      this.render();
    });
  },

  setupSync() {
    document.getElementById('sync-button').addEventListener('click', async () => {
      await this.loadData();
    });
  },

  async loadData() {
    const container = document.getElementById('view-container');
    container.innerHTML = '<p class="loading">同期中...</p>';
    try {
      if (Sync.SHEET_ID) {
        await Sync.syncAll();
      } else {
        Sync.loadMockData();
        console.info('SHEET_ID未設定のためモックデータで動作中');
      }
      this.updateLastSync();
      this.populateFilters();
      this.updateCategoryBadges();
      this.render();
    } catch (err) {
      container.innerHTML = `<p class="error">同期失敗: ${err.message}</p>`;
    }
  },

  updateLastSync() {
    const el = document.getElementById('last-sync');
    if (Sync.lastSync) {
      const t = Sync.lastSync;
      el.textContent = `${t.getHours()}:${String(t.getMinutes()).padStart(2,'0')}`;
    }
  },

  populateFilters() {
    const employees = Sync.cache.employees || [];
    const departments = Sync.cache.departments || [];

    const deptSelect = document.getElementById('filter-department');
    deptSelect.innerHTML = '<option value="">全事務所</option>' +
      departments.map(d => `<option value="${d.department_id}">${d.department_name}</option>`).join('');

    const roles = [...new Set(employees.map(e => e.role_title).filter(Boolean))];
    const roleSelect = document.getElementById('filter-role');
    roleSelect.innerHTML = '<option value="">全役職</option>' +
      roles.map(r => `<option value="${r}">${r}</option>`).join('');
  },

  updateCategoryBadges() {
    const employees = Sync.cache.employees || [];
    const counts = { all: employees.length };
    ['監督職', '準監督職', '広義監督職'].forEach(cat => {
      counts[cat] = employees.filter(e => e.category === cat).length;
    });
    document.querySelectorAll('.category-tab').forEach(tab => {
      const cat = tab.dataset.category;
      tab.querySelector('.badge').textContent = counts[cat] || 0;
    });
  },

  filterEmployees() {
    let employees = Sync.cache.employees || [];
    if (this.state.currentCategory !== 'all') {
      employees = employees.filter(e => e.category === this.state.currentCategory);
    }
    if (this.state.filterDept) {
      employees = employees.filter(e => e.department_id === this.state.filterDept);
    }
    if (this.state.filterRole) {
      employees = employees.filter(e => e.role_title === this.state.filterRole);
    }
    if (this.state.filterName) {
      employees = employees.filter(e =>
        (e.name || '').toLowerCase().includes(this.state.filterName)
      );
    }
    return employees;
  },

  render() {
    const container = document.getElementById('view-container');
    const view = this.state.currentView;

    if (view === 'cards') {
      const employees = this.filterEmployees();
      container.innerHTML = CardsView.render(employees, Sync.cache.departments);
    } else if (view.startsWith('gantt-')) {
      container.innerHTML = GanttView.render(view, Sync.cache);
    }
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
