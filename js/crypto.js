/**
 * crypto.js - クライアントサイド認証・暗号化
 *
 * Phase 1（暫定）: パスワードのSHA-256ハッシュ照合のみ
 * Phase 2a: soukai-qa-podium 方式の本格暗号化に置換予定（長谷部氏依頼）
 */

const Auth = {
  /**
   * 期待されるパスワードハッシュ（SHA-256）
   * 暫定パスワード: "besterra2026" のSHA-256
   * 本番デプロイ前に必ず変更すること
   */
  EXPECTED_HASH: 'ff5ed1c7e4705445b48a229826269802a3bc3ea2ecdad14298055fa30e8ddc83',

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
