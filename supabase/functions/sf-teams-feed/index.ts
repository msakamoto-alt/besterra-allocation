// Teams 通知の RSS 出口 Edge Function（sf-teams-feed）— 2026-10-10
//
// 役割：sf-teams-notify が「RSS に出した」（teams_notify_log.status='queued'）分を RSS 2.0 で返す。読むだけ・書かない。
//       Power Automate の RSS のトリガー（フィード項目が発行されたとき）が読みに来て、項目ごとに Flow bot で宛先へカードを送る。
//       Webhook を外から直接呼べない環境向けに、Teams 側から取りに来てもらう形。
//       手順書＝supabase/PHASE_TEAMS_NOTIFY_SETUP.md
//
// 呼び方：GET /functions/v1/sf-teams-feed?key=<TEAMS_FEED_KEY>
//   RSS のトリガーはヘッダを付けられないので、この関数だけ Verify JWT を **オフ** にし、URL の key で確かめる。
//   key が違えば 404（存在を教えない）。URL は合鍵と同じ扱い（リポジトリ・チャットに書かない）。
//
// 項目：
//   guid        … SF の Id（接続テストは ping-<uuid>）
//   pubDate     … queued_at（RSS に出た時刻・DB が付ける）＝トリガーが「新しい項目」を見分ける基準
//   title       … 通知の見出し
//   link        … Salesforce で開く URL（無ければ空）
//   description … {to, card} の JSON を UTF-8 → base64 にしたもの（RSS の部品に崩されないように包む）
//                 Power Automate 側は json(base64ToString(triggerOutputs()?['body/summary'])) で開く
//
// 必要な Secrets：TEAMS_FEED_KEY（長いランダム文字列）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VERSION = '2026-10-10.1';
const LOG = 'teams_notify_log';
const WINDOW_DAYS = 3;   // これより前に出した分は載せない
const MAX_ITEMS = 50;

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// deno-lint-ignore no-explicit-any
function openUrl(card: any): string {
  const a = Array.isArray(card?.actions) ? card.actions.find((x: { type?: string }) => x?.type === 'Action.OpenUrl') : null;
  return a?.url ? String(a.url) : '';
}

Deno.serve(async (req) => {
  const notFound = () => new Response('Not Found', { status: 404 });
  try {
    if (req.method !== 'GET') return notFound();
    const key = Deno.env.get('TEAMS_FEED_KEY') || '';
    if (key.length < 24 || new URL(req.url).searchParams.get('key') !== key) return notFound();

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
    const { data, error } = await admin.from(LOG).select('sf_id, title, payload, queued_at')
      .eq('status', 'queued').gte('queued_at', since).order('queued_at', { ascending: false }).limit(MAX_ITEMS);
    if (error) throw new Error(error.message);

    const items = (data || []).filter((r) => r.payload && r.queued_at).map((r) => `
    <item>
      <title>${xml(String(r.title || '通知'))}</title>
      <link>${xml(openUrl(r.payload.card))}</link>
      <guid isPermaLink="false">${xml(String(r.sf_id))}</guid>
      <pubDate>${new Date(r.queued_at).toUTCString()}</pubDate>
      <description>${b64utf8(JSON.stringify(r.payload))}</description>
    </item>`).join('');
    const now = new Date().toUTCString();
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>SF 通知（統合管理ツール）</title>
    <link>https://pajmsowweswaxowrbiwr.supabase.co</link>
    <description>sf-teams-feed ${VERSION}</description>
    <lastBuildDate>${now}</lastBuildDate>${items}
  </channel>
</rss>`;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return new Response('Error: ' + String((e as Error)?.message || e).slice(0, 200), { status: 500 });
  }
});
