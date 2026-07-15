// SF自動取込 Edge Function（sf-import）
//
// 役割：Salesforce Analytics Reports REST API から配置レポートを直接取得し、
//       js/sync.js parseSalesforceCsv と同じ整形・除外条件を適用したうえで
//       salesforce_imports テーブルを全置換する。
//       現行の「SFレポート→手動CSV→Sheets→同期ボタン」の手作業部分を置き換える
//       （テーブルの形は同一のためフロントエンド変更なし）。
//
// 認証（どちらかを満たすこと）：
//   a) Supabase JWT が admin ロール（admin-users と同じ検証）
//   b) x-import-secret ヘッダが IMPORT_SECRET と一致（スケジュール実行用）
//      ※どちらの場合も Verify JWT を通すため Authorization には最低 anon キーが必要
//
// アクション（POST body の action）：
//   dry_run … SF取得＋整形まで実行し、現在の salesforce_imports との差分を報告（書込なし・既定）
//             差分は内容ベース（金額の￥/JPY表記差・日付のゼロ埋め差・空白の全半角差を無視）
//   import  … salesforce_imports を全置換（先に投入→成功後に旧行削除の安全順）
//
// 必要な Secrets（Edge Functions → Secrets で設定）：
//   SF_INSTANCE_URL / SF_CLIENT_ID / SF_CLIENT_SECRET / SF_REPORT_ID / IMPORT_SECRET
//   （SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は実行環境に自動注入される）
//
// 安全鉄則：Salesforce へは読取のみ（トークン取得＋レポートGET）。SFへの書込は一切しない。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-import-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const API_VERSION = 'v61.0';
const TABLE = 'salesforce_imports';

// sync.js REFERENCE_COLUMNS.salesforce_imports と同一（テーブルの契約）
const COLUMNS = [
  'department', 'emp_name', 'emp_name_raw', 'role', 'role_detail', 'contract_type',
  'project_id', 'project_name', 'start', 'end', 'total_revenue', 'order_amount', 'status',
];

// sync.js parseSalesforceCsv の findCol と同じ部分一致パターン
const COLUMN_PATTERNS: Record<string, string[]> = {
  department: ['所属', '部門'],
  emp_name: ['工事部員', '担当者'],
  role: ['ロール'],
  role_detail: ['ロール詳細'],
  contract_type: ['受注形態'],
  project_id: ['工事番号'],
  project_name: ['工事名', '通称'],
  start: ['着工'],
  end: ['完工'],
  total_revenue: ['総売上'],
  order_amount: ['受注金額'],
  status: ['状態'],
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// Analytics API のセルはHTMLリンクを含むことがある（例: 工事名が <a href="...">名前</a>）。
// 手動CSVエクスポートはプレーンテキストのため、タグ除去してCSV経路と揃える。
// また、APIは空欄セルを「-」で返す（CSVは空文字）ため、これもCSV側に揃える。
function stripHtml(s: string): string {
  const t = String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  return t.trim() === '-' ? '' : t;
}

// sync.js normalizeName と同一（絵文字・記号・前後空白の除去）
function normalizeName(name: string): string {
  return String(name || '')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/[☀-➿⬀-⯿]/g, '')
    .trim();
}

// sync.js normalizeDate と同一
function normalizeDate(s: string): string | null {
  if (!s) return null;
  return String(s).trim();
}

async function sfFetchRows(): Promise<{ rows: Record<string, string | null>[]; report: Record<string, unknown> }> {
  const base = (Deno.env.get('SF_INSTANCE_URL') || '').replace(/\/+$/, '');
  const clientId = Deno.env.get('SF_CLIENT_ID');
  const clientSecret = Deno.env.get('SF_CLIENT_SECRET');
  const reportId = Deno.env.get('SF_REPORT_ID');
  if (!base || !clientId || !clientSecret || !reportId) {
    throw new Error('SF_INSTANCE_URL / SF_CLIENT_ID / SF_CLIENT_SECRET / SF_REPORT_ID のSecretsが未設定です');
  }

  // --- 1. トークン取得（クライアントログイン情報フロー・読取専用連携） ---
  const tokenRes = await fetch(base + '/services/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const tokenBody = await tokenRes.json();
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw new Error('SFトークン取得失敗: ' + JSON.stringify(tokenBody).slice(0, 300));
  }

  // --- 2. レポート取得（Analytics REST API・読取のみ） ---
  const repRes = await fetch(
    `${base}/services/data/${API_VERSION}/analytics/reports/${reportId}?includeDetails=true`,
    { headers: { Authorization: 'Bearer ' + tokenBody.access_token } },
  );
  const rep = await repRes.json();
  if (!repRes.ok) throw new Error('SFレポート取得失敗: ' + JSON.stringify(rep).slice(0, 300));
  if (rep.allData === false) {
    throw new Error('レポートが2,000行を超えています（allData=false）。全行取得できないため取込を中止しました。要ページング設計。');
  }

  // --- 3. 列マッピング（parseSalesforceCsv の findCol と同じ部分一致） ---
  const meta = rep.reportMetadata || {};
  const ext = (rep.reportExtendedMetadata || {}).detailColumnInfo || {};
  const apiNames: string[] = meta.detailColumns || [];
  const labels: string[] = apiNames.map((c) => (ext[c] || {}).label || c);

  const findCol = (patterns: string[]) => {
    for (let i = 0; i < labels.length; i++) {
      if (patterns.some((p) => labels[i].includes(p))) return i;
    }
    return -1;
  };
  const cols: Record<string, number> = {};
  for (const [key, patterns] of Object.entries(COLUMN_PATTERNS)) cols[key] = findCol(patterns);
  // 「ロール」と「ロール詳細」が同列を指した場合の補正（完全一致'ロール'を探し直す）
  if (cols.role === cols.role_detail && cols.role_detail >= 0) {
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].trim() === 'ロール') { cols.role = i; break; }
    }
  }
  const missing = Object.entries(cols)
    .filter(([k, v]) => v < 0 && k !== 'role_detail')
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`レポートに必須列が見つかりません: ${missing.join(', ')}（列ラベル: ${labels.join(' | ')}）`);
  }

  // --- 4. 行整形＋除外条件（parseSalesforceCsv と同一） ---
  const rawRows = ((rep.factMap || {})['T!T'] || {}).rows || [];
  const rows: Record<string, string | null>[] = [];
  for (const r of rawRows) {
    const cells: string[] = (r.dataCells || []).map((c: { label?: string }) => stripHtml(String(c.label ?? '')));
    const get = (k: string) => (cols[k] >= 0 ? (cells[cols[k]] || '') : '');

    if (get('department').includes('合計')) continue;
    const empRaw = get('emp_name');
    const emp_name = normalizeName(empRaw);
    if (!emp_name) continue;
    const project_id = get('project_id').trim();
    if (!project_id) continue;
    if (/^(-|nan|null|na|n\/a|undefined)$/i.test(project_id)) continue;
    if (!/[A-Za-z]/.test(project_id) || !/\d/.test(project_id)) continue;

    rows.push({
      department: get('department'),
      emp_name,
      emp_name_raw: empRaw,
      role: get('role'),
      role_detail: get('role_detail'),
      contract_type: get('contract_type'),
      project_id,
      project_name: get('project_name'),
      start: normalizeDate(get('start')),
      end: normalizeDate(get('end')),
      total_revenue: get('total_revenue'),
      order_amount: get('order_amount'),
      status: get('status'),
    });
  }

  return {
    rows,
    report: { name: meta.name, columns: labels, raw_rows: rawRows.length, kept_rows: rows.length },
  };
}

// 内容比較用のセル正規化。API経由とCSV→Sheets経由の無害な表記差
// （￥/JPY・日付ゼロ埋め・空白の全半角・空欄の「-」）を吸収し、実質的な増減だけを差分に出す。
// 消費側と同じ吸収ロジック：金額=parseAmount（数字のみ）/ 日付=new Date が読める粒度。
function normCell(col: string, v: unknown): string {
  const s = (v == null ? '' : String(v)).trim();
  if (col === 'total_revenue' || col === 'order_amount') return s.replace(/[^\d]/g, '');
  if (col === 'start' || col === 'end') {
    const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    return m ? `${m[1]}/${+m[2]}/${+m[3]}` : s;
  }
  const t = s === '-' ? '' : s;
  return t.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function contentKey(r: Record<string, unknown>): string {
  return JSON.stringify(COLUMNS.map((c) => normCell(c, r[c])));
}

// 多重集合の差分：A（SF最新）とB（現テーブル）を keyFn で突合
function diffMultiset(
  a: Record<string, unknown>[], b: Record<string, unknown>[],
  keyFn: (r: Record<string, unknown>) => string,
) {
  const bCount = new Map<string, number>();
  for (const r of b) {
    const k = keyFn(r);
    bCount.set(k, (bCount.get(k) || 0) + 1);
  }
  const added: Record<string, unknown>[] = [];
  for (const r of a) {
    const k = keyFn(r);
    const n = bCount.get(k) || 0;
    if (n > 0) bCount.set(k, n - 1);
    else added.push(r);
  }
  const removed: Record<string, unknown>[] = [];
  for (const r of b) {
    const k = keyFn(r);
    const n = bCount.get(k) || 0;
    if (n > 0) { bCount.set(k, n - 1); removed.push(r); }
  }
  return { added, removed };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // --- 呼び出し元の認証（admin JWT または IMPORT_SECRET） ---
    let authorized = false;
    let caller = 'secret';
    const importSecret = Deno.env.get('IMPORT_SECRET');
    const givenSecret = req.headers.get('x-import-secret');
    if (importSecret && givenSecret === importSecret) {
      authorized = true;
    } else {
      const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
      if (!jwt) return json({ error: '未認証です' }, 401);
      const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
      if (uErr || !userData?.user) return json({ error: '認証が無効です' }, 401);
      const { data: role } = await admin
        .from('user_roles').select('role').eq('user_id', userData.user.id).maybeSingle();
      if (role?.role !== 'admin') return json({ error: '管理者権限が必要です' }, 403);
      authorized = true;
      caller = userData.user.email || userData.user.id;
    }
    if (!authorized) return json({ error: '未認証です' }, 401);

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'dry_run';

    // --- Salesforce から取得・整形（読取のみ） ---
    const { rows, report } = await sfFetchRows();
    if (rows.length === 0) {
      return json({ error: '取込条件適用後の行が0件です。安全のため処理を中止しました（レポート内容を確認してください）。', report }, 400);
    }

    if (action === 'dry_run') {
      // 現在のテーブルと内容ベースで差分比較（書込なし）
      const { data: current, error: selErr } = await admin
        .from(TABLE).select(COLUMNS.join(',')).order('id', { ascending: true }).limit(10000);
      if (selErr) throw selErr;
      const db = current || [];
      const { added, removed } = diffMultiset(rows, db, contentKey);
      return json({
        ok: true, action: 'dry_run', caller, report,
        db_rows: db.length,
        sf_rows: rows.length,
        matched: rows.length - added.length,
        added: added.length,
        removed: removed.length,
        added_samples: added.slice(0, 10),
        removed_samples: removed.slice(0, 10),
        note: '書込は行っていません。比較は内容ベース（￥/JPY・日付ゼロ埋め・空白全半角・空欄「-」の表記差は無視）。',
      });
    }

    if (action === 'import') {
      // 全置換（sync/sheets.js _replaceSupabaseTable と同じ安全順：先に投入→成功後に旧行削除）
      const { data: maxData, error: maxErr } = await admin
        .from(TABLE).select('id').order('id', { ascending: false }).limit(1);
      if (maxErr) throw new Error(`${TABLE} 既存id取得失敗: ${maxErr.message}`);
      const maxOldId = maxData && maxData.length ? maxData[0].id : 0;

      const batch = 500;
      for (let i = 0; i < rows.length; i += batch) {
        const { error: insErr } = await admin.from(TABLE).insert(rows.slice(i, i + batch));
        if (insErr) throw new Error(`${TABLE} 投入失敗(${i}行目付近): ${insErr.message}（旧データは残っています）`);
      }
      const { error: delErr } = await admin.from(TABLE).delete().lte('id', maxOldId);
      if (delErr) {
        throw new Error(`${TABLE} 旧行削除失敗: ${delErr.message}（重複が残った可能性。もう一度実行してください）`);
      }
      return json({ ok: true, action: 'import', caller, report, imported: rows.length, deleted_old: maxOldId });
    }

    return json({ error: '不明なアクションです（dry_run / import）' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
