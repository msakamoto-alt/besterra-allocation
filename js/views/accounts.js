/**
 * accounts.js - アカウント管理（admin専用）
 *
 * Edge Function「admin-users」経由で Supabase Auth ユーザーを作成/変更/削除。
 * service_role はサーバー(Edge Function)側のみ。ここからは admin の JWT で呼ぶだけ。
 */
const AccountsView = {
  ROLE_OPTS: [
    ['viewer', '閲覧者'], ['manager', '役職者'], ['executive', '経営者'],
    ['editor', '編集者'], ['admin', '管理者'],
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
    body.innerHTML = '<tr><td colspan="4" class="px-3 py-4 text-center text-slate-400">読み込み中…</td></tr>';
    if (st) st.textContent = '';
    try {
      const users = await Sync.adminListUsers();
      if (!users.length) {
        body.innerHTML = '<tr><td colspan="4" class="px-3 py-4 text-center text-slate-400">アカウントがありません</td></tr>';
        return;
      }
      body.innerHTML = users.map(u => this.row(u)).join('');
      if (st) st.textContent = `${users.length} アカウント`;
      body.querySelectorAll('select[data-uid]').forEach(sel =>
        sel.addEventListener('change', () => this.changeRole(sel.dataset.uid, sel.value)));
      body.querySelectorAll('button[data-del]').forEach(b =>
        b.addEventListener('click', () => this.deleteUser(b.dataset.del, b.dataset.email)));
      body.querySelectorAll('button[data-pw]').forEach(b =>
        b.addEventListener('click', () => this.resetPw(b.dataset.pw, b.dataset.email)));
    } catch (e) {
      body.innerHTML = `<tr><td colspan="4" class="px-3 py-4 text-center text-red-600">読み込み失敗: ${this.esc(e.message || e)}</td></tr>`;
    }
  },

  row(u) {
    const opts = this.ROLE_OPTS.map(([v, l]) =>
      `<option value="${v}" ${u.role === v ? 'selected' : ''}>${l}</option>`).join('');
    const email = this.esc(u.email || '');
    return `<tr class="border-t">
      <td class="px-3 py-2">${this.esc(u.display_name || '')}</td>
      <td class="px-3 py-2 text-slate-600">${email}</td>
      <td class="px-3 py-2"><select data-uid="${u.user_id}" class="border rounded px-2 py-1 text-sm">${opts}</select></td>
      <td class="px-3 py-2 text-center whitespace-nowrap">
        <button data-pw="${u.user_id}" data-email="${email}" class="text-blue-600 hover:underline text-xs mr-2">パス再設定</button>
        <button data-del="${u.user_id}" data-email="${email}" class="text-red-600 hover:underline text-xs">削除</button>
      </td></tr>`;
  },

  async addUser() {
    const email = document.getElementById('acc-email').value.trim();
    const name = document.getElementById('acc-name').value.trim();
    const role = document.getElementById('acc-role').value;
    const pw = document.getElementById('acc-password').value;
    const st = document.getElementById('acc-add-status');
    const setErr = (m) => { st.textContent = m; st.className = 'text-xs mt-1 min-h-[16px] text-red-600'; };
    if (!email || !pw) return setErr('メールと初期パスワードは必須です');
    if (pw.length < 8) return setErr('パスワードは8文字以上にしてください');
    st.textContent = '追加中…'; st.className = 'text-xs mt-1 min-h-[16px] text-slate-500';
    try {
      await Sync.adminCreateUser({ email, display_name: name, role, password: pw });
      st.textContent = '✓ 追加しました'; st.className = 'text-xs mt-1 min-h-[16px] text-emerald-600';
      document.getElementById('acc-email').value = '';
      document.getElementById('acc-name').value = '';
      document.getElementById('acc-password').value = '';
      await this.refresh();
    } catch (e) {
      setErr('× ' + (e.message || e));
    }
  },

  async changeRole(uid, role) {
    try { await Sync.adminSetRole(uid, role); }
    catch (e) { alert('ロール変更に失敗しました: ' + (e.message || e)); await this.refresh(); }
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
