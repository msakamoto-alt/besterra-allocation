/**
 * accounts.js - アカウント管理（admin専用）
 *
 * Edge Function「admin-users」経由で Supabase Auth ユーザーを作成/変更/削除。
 * service_role はサーバー(Edge Function)側のみ。ここからは admin の JWT で呼ぶだけ。
 */
const AccountsView = {
  ROLE_OPTS: [
    ['viewer', '閲覧者'], ['manager', '役職者'], ['executive', '経営者'],
    ['accounting', '経理'], ['editor', '編集者'], ['admin', '管理者'],
  ],

  init() {
    const close = document.getElementById('account-modal-close');
    if (close) close.addEventListener('click', () => this.close());
    const modal = document.getElementById('account-modal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) this.close(); });
    const gen = document.getElementById('acc-gen-pw');
    if (gen) gen.addEventListener('click', () => {
      document.getElementById('acc-password').value = this.genPassword();
    });
    const add = document.getElementById('acc-add-btn');
    if (add) add.addEventListener('click', () => this.addUser());
    // メール入力時、SmartHR名簿(organization)のメール一致で社員番号を自動補完
    const emailInp = document.getElementById('acc-email');
    if (emailInp) emailInp.addEventListener('change', () => this.autofillEmpFromEmail());
  },

  // SmartHR名簿(organization)からメール一致で社員番号を引く
  empNoByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return '';
    const org = (Sync.cache.organization || []).find(o => String(o.email || '').trim().toLowerCase() === e);
    return org ? String(org.emp_no || '') : '';
  },

  // メール欄が変わったら、社員番号が未入力のときだけ自動補完（手入力は尊重）
  autofillEmpFromEmail() {
    const empInp = document.getElementById('acc-empno');
    if (!empInp || empInp.value.trim()) return;
    const no = this.empNoByEmail(document.getElementById('acc-email').value);
    if (no) empInp.value = no;
  },

  async open() {
    document.getElementById('account-modal').classList.remove('hidden');
    await this.refresh();
  },
  close() { document.getElementById('account-modal').classList.add('hidden'); },

  genPassword() {
    // 紛らわしい文字(0/O/1/l/I)を除外した14文字
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 14; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  },

  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },

  async refresh() {
    const body = document.getElementById('account-table-body');
    const st = document.getElementById('account-list-status');
    body.innerHTML = '<tr><td colspan="5" class="px-3 py-4 text-center text-slate-400">読み込み中…</td></tr>';
    if (st) st.textContent = '';
    try {
      const users = await Sync.adminListUsers();
      // 社員番号順（昇順・保存値＞メール導出）。社員番号なしは末尾。タイブレークはメール。
      const numOf = (u) => {
        const eff = String(u.emp_no || '').trim() || this.empNoByEmail(u.email);
        const n = parseInt(eff, 10);
        return isNaN(n) ? 1e15 : n;   // 大きな有限値で末尾へ（Infinity同士の減算=NaN を回避）
      };
      users.sort((a, b) => numOf(a) - numOf(b) || String(a.email || '').localeCompare(String(b.email || ''), 'ja'));
      if (!users.length) {
        body.innerHTML = '<tr><td colspan="5" class="px-3 py-4 text-center text-slate-400">アカウントがありません</td></tr>';
        return;
      }
      body.innerHTML = users.map(u => this.row(u)).join('');
      if (st) st.textContent = `${users.length} アカウント`;
      body.querySelectorAll('select[data-uid]').forEach(sel =>
        sel.addEventListener('change', () => this.changeRole(sel.dataset.uid, sel.value)));
      body.querySelectorAll('input[data-name]').forEach(inp =>
        inp.addEventListener('change', () => this.changeName(inp.dataset.name, inp.value.trim())));
      body.querySelectorAll('input[data-empno]').forEach(inp =>
        inp.addEventListener('change', () => this.changeEmp(inp.dataset.empno, inp.value.trim(), inp)));
      body.querySelectorAll('button[data-del]').forEach(b =>
        b.addEventListener('click', () => this.deleteUser(b.dataset.del, b.dataset.email)));
      body.querySelectorAll('button[data-pw]').forEach(b =>
        b.addEventListener('click', () => this.resetPw(b.dataset.pw, b.dataset.email)));
    } catch (e) {
      body.innerHTML = `<tr><td colspan="5" class="px-3 py-4 text-center text-red-600">読み込み失敗: ${this.esc(e.message || e)}</td></tr>`;
    }
  },

  row(u) {
    const opts = this.ROLE_OPTS.map(([v, l]) =>
      `<option value="${v}" ${u.role === v ? 'selected' : ''}>${l}</option>`).join('');
    const email = this.esc(u.email || '');
    const stored = String(u.emp_no || '').trim();
    const derived = stored || this.empNoByEmail(u.email);   // 保存値が無ければメールから導出
    const auto = !stored && !!derived;                      // メール自動（未保存）
    const hint = derived ? (this.empName(derived) + (auto ? '（メール自動）' : '')) : '';
    return `<tr class="border-t">
      <td class="px-3 py-2"><input type="text" data-name="${u.user_id}" value="${this.esc(u.display_name || '')}" class="border rounded px-2 py-1 text-sm w-36" placeholder="氏名"></td>
      <td class="px-3 py-2 text-slate-600">${email}</td>
      <td class="px-3 py-2"><select data-uid="${u.user_id}" class="border rounded px-2 py-1 text-sm">${opts}</select></td>
      <td class="px-3 py-2"><input type="text" data-empno="${u.user_id}" value="${this.esc(derived)}" class="border rounded px-2 py-1 text-sm w-20 ${auto ? 'text-slate-400' : ''}" placeholder="番号"> <span class="text-[11px] text-slate-400 empno-name">${this.esc(hint)}</span></td>
      <td class="px-3 py-2 text-center whitespace-nowrap">
        <button data-pw="${u.user_id}" data-email="${email}" class="text-blue-600 hover:underline text-xs mr-2">パス再設定</button>
        <button data-del="${u.user_id}" data-email="${email}" class="text-red-600 hover:underline text-xs">削除</button>
      </td></tr>`;
  },

  // 社員番号→社員名（紐付け確認用ヒント）。未一致は警告を表示。
  empName(empNo) {
    if (!empNo) return '';
    const e = (Sync.cache.employees || []).find(x =>
      String(x.id) === String(empNo) || String(x.emp_no) === String(empNo));
    return e ? e.name : '⚠ 該当社員なし';
  },

  async addUser() {
    const email = document.getElementById('acc-email').value.trim();
    const name = document.getElementById('acc-name').value.trim();
    const role = document.getElementById('acc-role').value;
    const pw = document.getElementById('acc-password').value;
    let empNo = document.getElementById('acc-empno').value.trim();
    if (!empNo) empNo = this.empNoByEmail(email);   // 未入力ならメールから自動紐付け
    const st = document.getElementById('acc-add-status');
    const setErr = (m) => { st.textContent = m; st.className = 'text-xs mt-1 min-h-[16px] text-red-600'; };
    if (!email || !pw) return setErr('メールと初期パスワードは必須です');
    if (pw.length < 8) return setErr('パスワードは8文字以上にしてください');
    st.textContent = '追加中…'; st.className = 'text-xs mt-1 min-h-[16px] text-slate-500';
    try {
      await Sync.adminCreateUser({ email, display_name: name, role, password: pw, emp_no: empNo });
      st.textContent = '✓ 追加しました'; st.className = 'text-xs mt-1 min-h-[16px] text-emerald-600';
      document.getElementById('acc-email').value = '';
      document.getElementById('acc-name').value = '';
      document.getElementById('acc-password').value = '';
      document.getElementById('acc-empno').value = '';
      await this.refresh();
    } catch (e) {
      setErr('× ' + (e.message || e));
    }
  },

  async changeRole(uid, role) {
    try { await Sync.adminSetRole(uid, role); }
    catch (e) { alert('ロール変更に失敗しました: ' + (e.message || e)); await this.refresh(); }
  },

  async changeName(uid, name) {
    try { await Sync.adminSetName(uid, name); }
    catch (e) { alert('氏名の変更に失敗しました: ' + (e.message || e)); await this.refresh(); }
  },

  async changeEmp(uid, empNo, inp) {
    try {
      await Sync.adminSetEmp(uid, empNo);
      if (inp && inp.nextElementSibling) inp.nextElementSibling.textContent = this.empName(empNo);
    } catch (e) { alert('社員番号の変更に失敗しました: ' + (e.message || e)); await this.refresh(); }
  },

  async resetPw(uid, email) {
    const pw = prompt(`「${email}」の新しいパスワード（8文字以上）を入力してください:`);
    if (!pw) return;
    if (pw.length < 8) { alert('パスワードは8文字以上にしてください'); return; }
    try { await Sync.adminSetPassword(uid, pw); alert('パスワードを変更しました'); }
    catch (e) { alert('パスワード変更に失敗しました: ' + (e.message || e)); }
  },

  async deleteUser(uid, email) {
    if (!confirm(`「${email}」のアカウントを削除します。よろしいですか？`)) return;
    try { await Sync.adminDeleteUser(uid); await this.refresh(); }
    catch (e) { alert('削除に失敗しました: ' + (e.message || e)); }
  },
};
