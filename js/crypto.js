/**
 * crypto.js - クライアントサイド認証・暗号化
 *
 * Phase 1（暫定）: パスワードのSHA-256ハッシュ照合のみ
 * Phase 2a: soukai-qa-podium 方式の本格暗号化に置換予定（長谷部氏依頼）
 */

const Auth = {
  /**
   * 期待されるパスワードハッシュ（SHA-256）
   * 暫定パスワード（Phase 2a で長谷部氏方式に置換予定）
   * パスワード本体は別管理（パスワードマネージャー等）
   */
  EXPECTED_HASH: 'c2b353a9361c3746544fac62cdf5e161d2744c3766c68684c7d4ed026d30def0',

  async hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  },

  async verify(password) {
    const hash = await this.hashPassword(password);
    return hash === this.EXPECTED_HASH;
  },

  saveSession(password) {
    sessionStorage.setItem('auth_token', password);
  },

  getSession() {
    return sessionStorage.getItem('auth_token');
  },

  clearSession() {
    sessionStorage.removeItem('auth_token');
  },

  /**
   * Phase 2a で長谷部氏方式に差し替え予定
   * - データ復号
   * - 鍵生成（PBKDF2 等）
   */
  decrypt(encryptedData, password) {
    // TODO: Phase 2a で実装
    return encryptedData;
  },
};
