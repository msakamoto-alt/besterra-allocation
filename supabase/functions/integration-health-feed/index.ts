// 連携の見張りの RSS 出口 Edge Function（integration-health-feed）— 2026-10-29
//
// 役割：integration_alert（integration_health_record() が 1 時間おきに積む警報）を RSS 2.0 で返す。読むだけ・書かない。
//       Power Automate の RSS のトリガー（フィード項目が発行されたとき）が読みに来て、
//       Flow bot が「フロー側に固定で書いた宛先」へ Teams のメッセージを送る。
//       手順書＝supabase/PHASE_INTEGRATION_HEALTH_SETUP.md
//
// 承認通知の sf-teams-feed とは分けてある：
//   - 宛先・カードを RSS に入れない（宛先とリンクはフロー側に固定＝偽の行が入っても社外や別の人へは飛ばない）
//   - 中身は見張りが作った決まった文（見出し・本文）だけ
//
// 呼び方：GET /functions/v1/integration-health-feed?key=<HEALTH_FEED_KEY>
//   RSS のトリガーはヘッダを付けられないので Verify JWT は **オフ**。key が違えば 404（存在を教えない）。
//
// 項目：
//   guid        … alert_key と JST の日付（同じ問題は 1 日 1 項目）
//   pubDate     … first_seen（見張りが最初に見つけた時刻・DB が付ける）＝トリガーが新しい項目を見分ける基準
//   title       … 「連携の異常：配置の取込（SF 本番 → 現場人員配置）」など
//   description … 何が起きているか（平文）
//
// 必要な Secrets：HEALTH_FEED_KEY（長いランダム文字列）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VERSION = '2026-10-29.1';
const TABLE = 'integration_alert';
const WINDOW_DAYS = 3;   // これより前の警報は載せない
const MAX_ITEMS = 30;
const TOOL_URL = 'https://msakamoto-alt.github.io/besterra-allocation/';

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

Deno.serve(async (req) => {
  const notFound = () => new Response('Not Found', { status: 404 });
  try {
    if (req.method !== 'GET') return notFound();
    const key = Deno.env.get('HEALTH_FEED_KEY') || '';
    if (key.length < 24 || new URL(req.url).searchParams.get('key') !== key) return notFound();

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
    const { data, error } = await admin.from(TABLE).select('alert_key, day, title, detail, first_seen')
      .gte('first_seen', since).order('first_seen', { ascending: false }).limit(MAX_ITEMS);
    if (error) throw new Error(error.message);

    const items = (data || []).map((r) => `
    <item>
      <title>${xml('連携の異常：' + String(r.title || ''))}</title>
      <link>${TOOL_URL}</link>
      <guid isPermaLink="false">${xml(String(r.alert_key) + '@' + String(r.day))}</guid>
      <pubDate>${new Date(r.first_seen).toUTCString()}</pubDate>
      <description>${xml(String(r.detail || ''))}</description>
    </item>`).join('');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>連携の見張り（統合管理ツール）</title>
    <link>${TOOL_URL}</link>
    <description>integration-health-feed ${VERSION}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>`;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return new Response('Error: ' + String((e as Error)?.message || e).slice(0, 200), { status: 500 });
  }
});
