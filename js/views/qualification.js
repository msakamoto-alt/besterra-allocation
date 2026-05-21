/**
 * qualification.js - 資格管理タブ
 *
 * - 上部サマリ：期限切れ件数・90日以内期限切れ件数・資格マスタ件数
 * - 資格別一覧（保有者・期限警告）
 * - 要更新リスト（個人別・期限近い順）
 */

const QualificationView = {
  init() {
    // 現状はリフレッシュのみ。フィルタは将来追加
  },

  refresh() {
    this.render();
  },

  render() {
    const quals = Sync.cache.qualifications || [];
    const eqs = Sync.cache.employee_qualifications || [];
    const employees = Sync.cache.employees || [];

    if (quals.length === 0) {
      document.getElementById('qual-summary').innerHTML = '';
      document.getElementById('qual-content').innerHTML = `
        <div class="p-8 text-center text-slate-500 bg-white rounded-lg shadow">
          <p class="font-medium mb-2">資格データが未登録です</p>
          <p class="text-sm">Google Sheets の qualifications / employee_qualifications シートにデータを投入してください。</p>
        </div>`;
      return;
    }

    const empMap = {};
    employees.forEach(e => empMap[e.id] = e);
    const now = new Date();
    const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // 期限状態の判定
    const expired = [];
    const expiringIn30 = [];
    const expiringIn90 = [];
    eqs.forEach(eq => {
      if (!eq.expiry) return;
      const exp = new Date(eq.expiry);
      if (exp < now) expired.push(eq);
      else if (exp <= in30Days) expiringIn30.push(eq);
      else if (exp <= in90Days) expiringIn90.push(eq);
    });

    // ===== サマリ =====
    document.getElementById('qual-summary').innerHTML = `
      <div class="grid grid-cols-4 gap-4">
        <div class="bg-red-50 border border-red-300 rounded-lg p-4">
          <div class="text-sm text-red-800 font-medium">期限切れ</div>
          <div class="text-3xl font-bold text-red-700 mt-2">${expired.length} <span class="text-base">件</span></div>
          <div class="text-xs text-slate-600 mt-2">即時更新が必要</div>
        </div>
        <div class="bg-orange-50 border border-orange-300 rounded-lg p-4">
          <div class="text-sm text-orange-800 font-medium">30日以内に期限切れ</div>
          <div class="text-3xl font-bold text-orange-700 mt-2">${expiringIn30.length} <span class="text-base">件</span></div>
          <div class="text-xs text-slate-600 mt-2">早急に更新手配</div>
        </div>
        <div class="bg-amber-50 border border-amber-300 rounded-lg p-4">
          <div class="text-sm text-amber-800 font-medium">90日以内に期限切れ</div>
          <div class="text-3xl font-bold text-amber-700 mt-2">${expiringIn90.length} <span class="text-base">件</span></div>
          <div class="text-xs text-slate-600 mt-2">計画的に更新</div>
        </div>
        <div class="bg-slate-50 border border-slate-300 rounded-lg p-4">
          <div class="text-sm text-slate-800 font-medium">登録資格マスタ</div>
          <div class="text-3xl font-bold text-slate-700 mt-2">${quals.length} <span class="text-base">種</span></div>
          <div class="text-xs text-slate-600 mt-2">資格マスタの登録数</div>
        </div>
      </div>
    `;

    // ===== 要更新リスト（個人別・期限近い順） =====
    const allAlerts = [...expired, ...expiringIn30, ...expiringIn90]
      .map(eq => ({ ...eq, exp: new Date(eq.expiry) }))
      .sort((a, b) => a.exp - b.exp);

    let alertHtml = '';
    if (allAlerts.length === 0) {
      alertHtml = '<p class="text-slate-400 text-sm">期限間近の資格はありません</p>';
    } else {
      alertHtml = '<table class="w-full text-sm"><thead class="bg-slate-50"><tr>' +
        '<th class="p-2 text-left">氏名</th>' +
        '<th class="p-2 text-left">所属</th>' +
        '<th class="p-2 text-left">資格</th>' +
        '<th class="p-2 text-center">期限</th>' +
        '<th class="p-2 text-center">残日数</th>' +
        '<th class="p-2 text-center">状態</th>' +
        '</tr></thead><tbody>';
      const qualMap = {};
      quals.forEach(q => qualMap[q.id] = q);
      allAlerts.forEach(a => {
        const emp = empMap[a.emp_id];
        const q = qualMap[a.qual_id];
        if (!emp || !q) return;
        const daysLeft = Math.ceil((a.exp - now) / (24 * 60 * 60 * 1000));
        let stateBadge, rowBg;
        if (daysLeft < 0) {
          stateBadge = '<span class="bg-red-600 text-white px-2 py-0.5 rounded text-xs font-bold">期限切れ</span>';
          rowBg = 'bg-red-50';
        } else if (daysLeft <= 30) {
          stateBadge = '<span class="bg-orange-500 text-white px-2 py-0.5 rounded text-xs font-bold">30日以内</span>';
          rowBg = 'bg-orange-50';
        } else {
          stateBadge = '<span class="bg-amber-400 text-white px-2 py-0.5 rounded text-xs font-bold">90日以内</span>';
          rowBg = 'bg-amber-50';
        }
        alertHtml += `<tr class="border-t ${rowBg}">` +
          `<td class="p-2 font-medium">${this.esc(emp.name)}</td>` +
          `<td class="p-2">${this.esc(emp.department || '')}</td>` +
          `<td class="p-2">${this.esc(q.name)}</td>` +
          `<td class="p-2 text-center font-mono text-xs">${a.expiry}</td>` +
          `<td class="p-2 text-center font-bold">${daysLeft < 0 ? Math.abs(daysLeft) + '日経過' : daysLeft + '日'}</td>` +
          `<td class="p-2 text-center">${stateBadge}</td>` +
          '</tr>';
      });
      alertHtml += '</tbody></table>';
    }

    // ===== 資格別一覧 =====
    let qualListHtml = '<table class="w-full text-sm"><thead class="bg-slate-100"><tr>' +
      '<th class="p-3 text-left">資格</th>' +
      '<th class="p-3 text-center">区分</th>' +
      '<th class="p-3 text-center">保有者数</th>' +
      '<th class="p-3 text-center">90日以内期限切れ</th>' +
      '<th class="p-3 text-left">保有者</th>' +
      '</tr></thead><tbody>';
    quals.forEach(q => {
      const holders = eqs.filter(eq => eq.qual_id === q.id);
      const expiringSoon = holders.filter(eq => {
        if (!eq.expiry) return false;
        const exp = new Date(eq.expiry);
        return exp >= now && exp <= in90Days;
      });
      const isExpired = holders.filter(eq => eq.expiry && new Date(eq.expiry) < now);
      const alertCount = expiringSoon.length + isExpired.length;

      const holderNames = holders.map(eq => {
        const emp = empMap[eq.emp_id];
        if (!emp) return '';
        const isExp = eq.expiry && new Date(eq.expiry) >= now && new Date(eq.expiry) <= in90Days;
        const isOut = eq.expiry && new Date(eq.expiry) < now;
        const cls = isOut ? 'text-red-600 font-bold' : isExp ? 'text-amber-700 font-medium' : 'text-slate-700';
        const suffix = isOut ? `(期限切れ ${eq.expiry})` : isExp ? `(〜${eq.expiry})` : '';
        return `<span class="${cls}">${this.esc(emp.name)}${suffix}</span>`;
      }).filter(Boolean).join(' / ');

      const alertHtml = alertCount > 0
        ? `<span class="bg-amber-100 text-amber-800 px-2 py-1 rounded font-bold">⚠ ${alertCount}名</span>`
        : `<span class="text-slate-400">-</span>`;

      qualListHtml += '<tr class="border-t hover:bg-slate-50">' +
        `<td class="p-3 font-medium">${this.esc(q.name)}</td>` +
        `<td class="p-3 text-center text-xs text-slate-600">${this.esc(q.type)}</td>` +
        `<td class="p-3 text-center font-bold text-lg">${holders.length}</td>` +
        `<td class="p-3 text-center">${alertHtml}</td>` +
        `<td class="p-3 text-xs leading-relaxed">${holderNames || '<span class="text-slate-400">なし</span>'}</td>` +
        '</tr>';
    });
    qualListHtml += '</tbody></table>';

    document.getElementById('qual-content').innerHTML = `
      <div class="bg-white rounded-lg shadow p-4 mb-4 mt-4">
        <h3 class="font-bold text-lg mb-3 flex items-center gap-2">
          <span class="text-red-600">⚠</span> 要更新リスト
          <span class="text-sm text-slate-500 font-normal">（期限切れ＋90日以内の個人別アラート・期限近い順）</span>
        </h3>
        ${alertHtml}
      </div>
      <div class="bg-white rounded-lg shadow p-4">
        <h3 class="font-bold text-lg mb-3">資格別 保有状況</h3>
        ${qualListHtml}
      </div>
    `;
  },

  esc(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
