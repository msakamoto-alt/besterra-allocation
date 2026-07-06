/**
 * util.js - 共通ユーティリティ（2026-07 刷新で新設）
 *
 * 各Viewに重複していたヘルパの一元実装。既存Viewのメソッド名は互換のため残し、
 * 中身だけここへ委譲している（例: DashboardView.esc(t) は Util.esc(t) を返すだけ）。
 * 読み込み順: sync.js より前（index.html 参照）。ただし Sync はこのファイルに
 * 依存しない（検証スクリプトが sync.js を単体ロードするため）。
 */
const Util = {

  // HTMLエスケープ（& < > " の4文字・null/undefinedは空文字）
  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // 'YYYY/MM/DD' や 'YYYY-MM-DD' → date input 用 'YYYY-MM-DD'（不正・空は ''）
  toIsoDate(s) {
    if (!s) return '';
    const d = new Date(String(s).replace(/\//g, '-'));
    if (isNaN(d)) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  // 'YYYY-MM-DD' → 'YYYY/MM/DD'（データ保存形式。空は ''）
  toSlash(s) {
    return s ? String(s).replace(/-/g, '/') : '';
  },

  // 金額 → '¥12.3M'（百万円・小数1桁）表記
  fmtMillions(amount) {
    return `¥${(amount / 1e6).toFixed(1)}M`;
  },

  // SmartHR名簿(organization)からメール一致で行を引く（大文字小文字無視・無ければ null）
  // 社員番号が欲しい側は row.emp_no、氏名が欲しい側は row.name を見る。
  orgByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return null;
    return (Sync.cache.organization || []).find(o => String(o.email || '').trim().toLowerCase() === e) || null;
  },

  // モーダルの背景クリックで閉じる（modal自身がクリックされた時のみ発火）
  bindModalClose(modal, closeFn) {
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeFn(); });
  },
};
