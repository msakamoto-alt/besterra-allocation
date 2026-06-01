/**
 * member_add.js - メンバー追加モーダル（人員タイプ3種対応）
 *
 * 人員タイプ：
 *   - employee    : 当社社員（employees から選択）
 *   - dispatch    : 派遣社員（個別氏名は管理せず「派遣社員 #N」の連番）
 *   - placeholder : 配置未定・不足（「配置未定 #N」の連番・枠だけ確保）
 *
 * 保存先：既存 assignment_overrides シート（op=add）。
 * 監督リスト・ダッシュボードは employees ベースなので、emp_id 不一致の dispatch/placeholder は自然に除外される。
 */

const MemberAdd = {
  currentContext: null,    // { project_id, project_name, start, end, meta }
  currentType: 'employee', // employee | dispatch | placeholder

  init() {
    document.getElementById('member-add-close').addEventListener('click', () => this.close());
    document.getElementById('member-add-cancel').addEventListener('click', () => this.close());
    document.getElementById('member-add-save').addEventListener('click', () => this.save());
    document.getElementById('member-add-search').addEventListener('input', () => this.populateEmployeeList());

    // 人員タイプ切替
    document.querySelectorAll('.member-type-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setType(btn.dataset.type));
    });

    // モーダル背景クリックで閉じる
    const modal = document.getElementById('member-add-modal');
    modal.addEventListener('click', (e) => { if (e.target === modal) this.close(); });
  },

  open(ctx) {
    this.currentContext = ctx || {};
    document.getElementById('member-add-project-name').textContent = ctx.project_name || '-';
    document.getElementById('member-add-project-meta').textContent = ctx.meta || '';

    // 既定の期間：現場の工期と一致
    const toIso = (s) => {
      if (!s) return '';
      const d = new Date(String(s).replace(/\//g, '-'));
      if (isNaN(d)) return '';
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    document.getElementById('member-add-start').value = toIso(ctx.start);
    document.getElementById('member-add-end').value = toIso(ctx.end);
    document.getElementById('member-add-role').value = '副監督';
    document.getElementById('member-add-note').value = '';
    document.getElementById('member-add-search').value = '';
    document.getElementById('member-add-status').textContent = '';

    this.setType('employee');
    document.getElementById('member-add-modal').classList.remove('hidden');
  },

  close() {
    document.getElementById('member-add-modal').classList.add('hidden');
    this.currentContext = null;
  },

  // 人員タイプ切替（UIの表示/非表示・役割選択肢・既定役割の調整）
  setType(type) {
    this.currentType = type;
    document.querySelectorAll('.member-type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });

    const empSection = document.getElementById('member-add-emp-section');
    const previewBox = document.getElementById('member-add-preview');
    const roleSel = document.getElementById('member-add-role');

    // 役割セレクトを人員タイプに完全連動：
    //   当社社員/配置未定・不足 → 主任技術者・副監督 のみ（応援なし）
    //   派遣社員 → 応援 固定（disabled）
    this.applyRoleOptions(type);

    if (type === 'employee') {
      empSection.classList.remove('hidden');
      previewBox.classList.add('hidden');
      this.populateEmployeeList();
    } else {
      empSection.classList.add('hidden');
      previewBox.classList.remove('hidden');
      this.updatePreview();
    }
  },

  // 人員タイプに応じて役割セレクトの選択肢を差し替え
  // employee     : 主任技術者 / 副監督
  // dispatch     : 派遣 固定（disabled）
  // placeholder  : 主任技術者 / 副監督 / 派遣（枠だけ確保するので全種類選べる）
  applyRoleOptions(type) {
    const roleSel = document.getElementById('member-add-role');
    if (!roleSel) return;
    const current = roleSel.value;
    if (type === 'dispatch') {
      roleSel.innerHTML = '<option value="派遣" selected>派遣</option>';
      roleSel.value = '派遣';
      roleSel.disabled = true;
    } else if (type === 'placeholder') {
      roleSel.disabled = false;
      roleSel.innerHTML =
        '<option value="主任技術者">主任技術者</option>' +
        '<option value="副監督">副監督</option>' +
        '<option value="派遣">派遣</option>';
      roleSel.value = ['主任技術者', '副監督', '派遣'].includes(current) ? current : '副監督';
    } else {
      // employee
      roleSel.disabled = false;
      roleSel.innerHTML =
        '<option value="主任技術者">主任技術者</option>' +
        '<option value="副監督">副監督</option>';
      roleSel.value = (current === '主任技術者') ? '主任技術者' : '副監督';
    }
  },

  // 派遣社員の連番を採番（現場内）
  nextDispatchSerial() {
    const ctx = this.currentContext || {};
    const projectId = ctx.project_id;
    if (!projectId) return 1;
    const assignments = (Sync.cache.assignments || []).filter(a => a.project_id === projectId);
    let maxN = 0;
    const re = /^派遣社員\s*#(\d+)$/;
    assignments.forEach(a => {
      const m = re.exec(String(a.emp_name || '').trim());
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxN) maxN = n;
      }
    });
    return maxN + 1;
  },

  // 配置未定・不足の同役割連番を採番（emp_name は固定、override_key だけ衝突回避用）
  nextPlaceholderSerial(role) {
    const ctx = this.currentContext || {};
    const projectId = ctx.project_id;
    if (!projectId) return 1;
    const assignments = (Sync.cache.assignments || []).filter(a => {
      if (a.project_id !== projectId) return false;
      if (!this.isPlaceholderName(a.emp_name)) return false;
      const normRole = Sync.normalizeRole ? Sync.normalizeRole(a.role) : a.role;
      return normRole === role;
    });
    if (assignments.length === 0) return 1;
    let maxN = 0;
    const escRole = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reNumbered = new RegExp(`配置未定・不足（${escRole}）#(\\d+)__`);
    const reBase = new RegExp(`配置未定・不足（${escRole}）__`);
    assignments.forEach(a => {
      const key = String(a.override_key || '');
      const m = reNumbered.exec(key);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxN) maxN = n;
      } else if (reBase.test(key)) {
        // 連番なし版は #1 とみなす
        if (maxN < 1) maxN = 1;
      }
    });
    return maxN + 1;
  },

  // 派遣・未定の登録名プレビュー（画面表示はいずれも固定文言）
  updatePreview() {
    const nameEl = document.getElementById('member-add-preview-name');
    const hintEl = document.getElementById('member-add-preview-hint');
    if (this.currentType === 'dispatch') {
      nameEl.textContent = '派遣社員';
      hintEl.textContent = '同じ現場に複数の派遣社員を登録できます（画面表示はいずれも「派遣社員」）。';
    } else if (this.currentType === 'placeholder') {
      nameEl.textContent = '配置未定・不足';
      hintEl.textContent = '人員不足の「枠」を時系列で可視化します。同じ現場に同じ役割の枠を複数登録できます（画面表示はいずれも「配置未定・不足」）。後から当社社員・派遣社員に置き換えてください。';
    }
  },

  populateEmployeeList() {
    const sel = document.getElementById('member-add-emp');
    const search = (document.getElementById('member-add-search').value || '').toLowerCase().trim();
    // 配置プール：現場監督 + 準現場監督
    const all = (Sync.cache.employees || [])
      .filter(e => e.category === '現場監督' || e.category === '準現場監督')
      .slice()
      .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    const filtered = search
      ? all.filter(e =>
          String(e.id).includes(search) ||
          (e.name || '').toLowerCase().includes(search) ||
          (e.name || '').replace(/\s+/g, '').toLowerCase().includes(search) ||
          (e.department || '').toLowerCase().includes(search)
        )
      : all;
    sel.innerHTML = filtered.map(e =>
      `<option value="${e.id}|${this.esc(e.name)}">${this.esc(e.id)}  ${this.esc(e.name)}  (${this.esc(e.department || '-')} / ${this.esc(e.category)})</option>`
    ).join('');
  },

  async save() {
    const statusEl = document.getElementById('member-add-status');
    const start = document.getElementById('member-add-start').value;
    const end = document.getElementById('member-add-end').value;
    const role = document.getElementById('member-add-role').value;
    const note = document.getElementById('member-add-note').value;
    const ctx = this.currentContext || {};

    // 共通バリデーション
    if (!start || !end) {
      statusEl.textContent = '⚠ 配属開始日と終了日を入力してください';
      statusEl.className = 'text-xs text-red-600';
      return;
    }
    if (start > end) {
      statusEl.textContent = '⚠ 終了日は開始日より後にしてください';
      statusEl.className = 'text-xs text-red-600';
      return;
    }
    if (!ctx.project_id) {
      statusEl.textContent = '⚠ 現場情報が取得できません';
      statusEl.className = 'text-xs text-red-600';
      return;
    }

    // 人員タイプ別に emp_name / override_key の suffix を決定
    let empName = '';
    let empNo = '';       // 社員番号（当社社員のみ。氏名に依存しない恒久キー）
    let keySuffix = '';   // override_key 衝突回避用（配置未定・不足は役割で区別）
    if (this.currentType === 'employee') {
      const sel = document.getElementById('member-add-emp');
      const selected = sel.value;
      if (!selected) {
        statusEl.textContent = '⚠ 監督を選択してください';
        statusEl.className = 'text-xs text-red-600';
        return;
      }
      // option value = "社員番号|氏名"。社員番号も保存して氏名照合への依存をなくす。
      const [empNoSel, n] = selected.split('|');
      empName = n;
      empNo = String(empNoSel || '').trim();
    } else if (this.currentType === 'dispatch') {
      empName = `派遣社員 #${this.nextDispatchSerial()}`;
    } else if (this.currentType === 'placeholder') {
      // emp_name は「配置未定・不足」固定。override_key は役割＋連番で区別（同役割複数登録対応）
      empName = '配置未定・不足';
      const n = this.nextPlaceholderSerial(role);
      // 1人目は連番なし（後方互換）、2人目以降は #N を付与
      keySuffix = n === 1 ? `（${role}）` : `（${role}）#${n}`;
    }

    const toSlash = s => s ? String(s).replace(/-/g, '/') : '';

    statusEl.textContent = '追加中…';
    statusEl.className = 'text-xs text-slate-500';
    const saveBtn = document.getElementById('member-add-save');
    saveBtn.disabled = true;

    try {
      // 配置未定・不足は emp_name 固定なので、override_key だけ役割で区別
      const overrideKey = Sync.buildOverrideKey(empName + keySuffix, ctx.project_id);
      await Sync.postOverride({
        action: 'upsert',
        op: 'add',
        override_key: overrideKey,
        emp_name: empName,
        emp_no: empNo,
        project_id: ctx.project_id,
        join_date: toSlash(start),
        planned_end: toSlash(end),
        role,
        note,
        updated_by: 'web',
      });
      statusEl.textContent = '✓ 追加しました';
      statusEl.className = 'text-xs text-emerald-600';
      if (typeof App !== 'undefined' && typeof App.loadData === 'function') {
        await App.loadData();
      }
      setTimeout(() => this.close(), 600);
    } catch (e) {
      console.error('メンバー追加 失敗:', e);
      statusEl.textContent = '× 追加失敗: ' + (e.message || e);
      statusEl.className = 'text-xs text-red-600';
    } finally {
      saveBtn.disabled = false;
    }
  },

  // 派遣・未定の判定ヘルパー（他ビューから利用）
  isDispatchName(name) {
    return /^派遣社員\s*#\d+$/.test(String(name || '').trim());
  },
  isPlaceholderName(name) {
    return String(name || '').trim() === '配置未定・不足';
  },

  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
