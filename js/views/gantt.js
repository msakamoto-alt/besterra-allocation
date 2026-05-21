/**
 * gantt.js - ガントビュー（Phase 2b で本格実装予定）
 *
 * 縦軸切替：
 * - person:       人軸（社員ごとに assignments を時間バー表示）
 * - project:      現場軸（工事ごとに配置社員を時間バー表示）
 * - department:   事務所軸（事務所ごとの稼働率を集約表示）
 * - qualification: 資格軸（資格ごとの保有者数推移と期限管理）
 *
 * ライブラリ候補（長谷部氏との相談で確定）：
 * - Frappe Gantt / vis-timeline / D3.js / dhtmlxGantt
 */

const GanttView = {
  render(axis, data) {
    return `
      <div class="gantt-placeholder" style="text-align: center; padding: 4rem; color: #718096;">
        <h2>ガントビュー（${this.axisLabel(axis)}）</h2>
        <p>Phase 2b で実装予定</p>
        <p style="font-size: 0.85em; margin-top: 1em;">
          長谷部氏との相談でライブラリ選定後に着手します
        </p>
      </div>
    `;
  },

  axisLabel(axis) {
    return {
      'gantt-person': '人軸',
      'gantt-project': '現場軸',
      'gantt-department': '事務所軸',
      'gantt-qualification': '資格軸',
    }[axis] || '未定義';
  },
};
