/**
 * auth.js - 認証・ロール・アカウント管理（Supabase Auth / Edge Function admin-users）
 *
 * js/sync.js の Sync オブジェクトに責務を追加するモジュール（2026-07 刷新で分割）。
 * メソッド本体は旧 sync.js から無変更で移動。sync.js より後に読み込むこと。
 */
Object.assign(Sync, {
  // 段階E1: ログイン（Supabase Auth・全ユーザー個人アカウント）+ ロール取得。
  async login(email, password) {
    const sb = this.getSupabase();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message || 'ログインに失敗しました');
    await this.fetchRole();
    return !!(data && data.session);
  },

  async logout() {
    try { await this.getSupabase().auth.signOut(); } catch (e) { /* noop */ }
    this.role = null;
    this.isEditor = false;
  },

  // Point3: 本人が自分のパスワードを変更（初回の仮パスワード変更）。同時に変更強制フラグを解除。
  async changeOwnPassword(newPassword) {
    const sb = this.getSupabase();
    const { error } = await sb.auth.updateUser({ password: newPassword, data: { must_change_pw: false } });
    if (error) throw new Error(error.message || 'パスワードの変更に失敗しました');
    this.mustChangePw = false;
    return true;
  },

  // 既存セッション（localStorage 永続）を復元し、ロールを取得。ログイン中なら true。
  async refreshSession() {
    if (!this.USE_SUPABASE || !this.SUPABASE_URL) return false;
    try {
      const { data } = await this.getSupabase().auth.getSession();
      if (data && data.session) { await this.fetchRole(); return true; }
    } catch (e) { /* noop */ }
    this.role = null; this.isEditor = false;
    return false;
  },

  // user_roles から自分のロールを取得（ur_read_self ポリシーで本人行を直接読む）。
  async fetchRole() {
    try {
      const sb = this.getSupabase();
      const { data: u } = await sb.auth.getUser();
      const uid = u && u.user && u.user.id;
      this.userId = uid || null;            // 段階E4: 自分の学習ログ絞り込み用
      // Point3: 仮パスワードで作成された/再設定されたアカウントは初回ログインで変更を強制
      this.mustChangePw = !!(u && u.user && u.user.user_metadata && u.user.user_metadata.must_change_pw);
      if (!uid) {
        this.role = null;
      } else {
        // emp_no を含めて取得。列が無い環境（SQL未実行）でもログインを壊さないようコア列にフォールバック。
        let row = null;
        const r = await sb.from('user_roles').select('role, display_name, email, emp_no').eq('user_id', uid).maybeSingle();
        if (r.error) {
          const r2 = await sb.from('user_roles').select('role, display_name, email').eq('user_id', uid).maybeSingle();
          if (r2.error) throw r2.error;
          row = r2.data;
        } else {
          row = r.data;
        }
        this.role = (row && row.role) || null;
        this.displayName = (row && row.display_name) || null;   // 段階E4b: 進捗ホームの氏名表示
        this.email = (row && row.email) || (u && u.user && u.user.email) || null;
        this.empNo = (row && row.emp_no) || null;               // Point2: 工事監督アカウント→社員番号の紐付け
      }
    } catch (e) {
      console.error('ロール取得失敗:', e);
      this.role = null;
      this.userId = null;
      this.displayName = null;
      this.empNo = null;
      this.mustChangePw = false;
    }
    this.isEditor = (this.role === 'admin' || this.role === 'editor');  // 後方互換
    return this.role;
  },

  isLoggedIn() { return !!this.role; },
  isAdmin() { return this.role === 'admin'; },

  // ロールの日本語表示名
  ROLE_LABELS: { admin: '管理者', editor: '編集者', executive: '経営者', manager: '役職者', viewer: '閲覧者', accounting: '経理' },
  roleLabel() { return this.ROLE_LABELS[this.role] || this.role || '—'; },

  // ===== 段階E1.5: アカウント管理（Edge Function「admin-users」経由）=====
  // service_role はサーバー側のみ。ここからは admin の JWT を付けて呼ぶ（functions.invoke が自動付与）。
  async _invokeAdmin(body) {
    const { data, error } = await this.getSupabase().functions.invoke(this.ADMIN_FN, { body });
    if (error) {
      // HTTP非2xxでも error。レスポンス本文の error メッセージを優先的に拾う
      let msg = error.message || 'リクエストに失敗しました';
      try { const ctx = await error.context?.json?.(); if (ctx?.error) msg = ctx.error; } catch (_) { /* noop */ }
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(data.error);
    return data;
  },
  async adminListUsers() { const d = await this._invokeAdmin({ action: 'list' }); return (d && d.users) || []; },
  async adminCreateUser({ email, password, display_name, role, emp_no }) {
    return this._invokeAdmin({ action: 'create', email, password, display_name, role, emp_no });
  },
  async adminSetRole(user_id, role) { return this._invokeAdmin({ action: 'set_role', user_id, role }); },
  async adminSetName(user_id, display_name) { return this._invokeAdmin({ action: 'set_name', user_id, display_name }); },
  async adminSetEmp(user_id, emp_no) { return this._invokeAdmin({ action: 'set_emp', user_id, emp_no }); },
  async adminSetPassword(user_id, password) { return this._invokeAdmin({ action: 'set_password', user_id, password }); },
  async adminDeleteUser(user_id) { return this._invokeAdmin({ action: 'delete', user_id }); },
});
