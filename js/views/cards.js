/**
 * cards.js - カードビュー
 *
 * employees の配列を受け取って、グリッド形式でカード描画する。
 */

const CardsView = {
  render(employees, departments) {
    if (!employees || employees.length === 0) {
      return '<p class="loading">該当する社員がいません。</p>';
    }

    const deptMap = {};
    (departments || []).forEach(d => {
      deptMap[d.department_id] = d.department_name;
    });

    const cards = employees.map(emp => {
      const deptName = deptMap[emp.department_id] || emp.department_id || '-';
      const tenure = this.calcTenure(emp.hired_at);
      return `
        <div class="employee-card category-${emp.category || ''}">
          <h3>${this.escape(emp.name)}</h3>
          <div class="dept">${this.escape(deptName)}</div>
          <div class="meta">
            ${this.escape(emp.role_title || '-')} ・ ${this.escape(emp.category || '-')}
          </div>
          <div class="meta">
            ${tenure ? `在籍 ${tenure}年` : ''}
          </div>
        </div>
      `;
    }).join('');

    return `<div class="card-grid">${cards}</div>`;
  },

  calcTenure(hiredAt) {
    if (!hiredAt) return null;
    const hired = new Date(hiredAt);
    if (isNaN(hired)) return null;
    const now = new Date();
    return Math.floor((now - hired) / (365.25 * 24 * 60 * 60 * 1000));
  },

  escape(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
};
