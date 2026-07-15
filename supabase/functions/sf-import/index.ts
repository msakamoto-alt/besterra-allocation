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
// POST body の source（実行元の名乗り・監査ログの表示に使う）：
//   cron   … pg_cronの自動実行（sf_import_cron.sql が送る）
//   script … 手動のsf_import_call.py
//   なし/未知 … 「実行元不明」と記録（勝手に自動扱いしない）。管理者JWT経由なら本人のメールが残る
//
// アクション（POST body の action）：
//   dry_run … SF取得＋整形まで実行し、現在の salesforce_imports との差分を報告（書込なし・既定）
//             差分は内容ベース（金額の￥/JPY表記差・日付のゼロ埋め差・空白の全半角差を無視）
//   import  … salesforce_imports を全置換（先に投入→成功後に旧行削除の安全順）
//             ＋ audit_logs へ1行サマリー記録（成功=IMPORT／失敗=ERROR。dry_runは記録しない）
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

// 取込1回につき audit_logs へ1行だけ記録する（成功=IMPORT / 失敗=ERROR）。
// salesforce_imports は行単位トリガーの対象外（全置換のたび760行のログになるため・add_audit_logs.sql参照）。
// service_role はRLSを迂回するのでここから直接insertできる。
// 実行元（呼び出し側が body.source で名乗る）。監査ログの「操作者」「実行契機」の表示に使う。
// secret経路は cron も手動スクリプトも同じ認証のため、自己申告でしか区別できない
// ＝ 名乗りが無い/未知なら「不明」と正直に記録する（勝手に自動扱いしない）。
// 管理者JWT経路は名乗りに関係なく app（本人のメールが残る）。
const SOURCES: Record<string, { email: string; trigger: string }> = {
  cron:   { email: 'sf-import（自動実行）',       trigger: '自動（毎朝6時）' },
  script: { email: 'sf-import（手動スクリプト）', trigger: '手動（スクリプト）' },
};
const SOURCE_UNKNOWN = { email: 'sf-import（実行元不明）', trigger: '不明（secret経由）' };

function resolveSource(caller: string, source: unknown) {
  if (caller !== 'secret') return { email: caller, trigger: '手動（アプリ）', role: 'admin' };
  const s = SOURCES[String(source || '')] || SOURCE_UNKNOWN;
  return { ...s, role: 'system' };
}

// ログ記録の失敗が取込本体を巻き添えにしないよう、失敗はFunctionログに出すだけで投げ直さない
// （取込は成功しているのにエラーを返すと、cronが失敗と誤認して無用な再実行を招く）。
// 戻り値＝記録できたか。呼び出し側は応答JSONの audit_logged に載せて可視化する。
async function logAudit(
  admin: ReturnType<typeof createClient>,
  entry: { op: string; caller: string; source: unknown; rowKey: string; changes: Record<string, { new: string }> },
): Promise<boolean> {
  const who = resolveSource(entry.caller, entry.source);
  try {
    // supabase-js はエラーを throw せず { error } で返すため、必ず中身を見ること
    const { error } = await admin.from('audit_logs').insert({
      user_id: null,
      user_email: who.email,
      user_role: who.role,
      table_name: TABLE,
      op: entry.op,
      row_key: entry.rowKey,
      changes: { ...entry.changes, trigger: { new: who.trigger } },
    });
    if (error) {
      console.error('監査ログ記録失敗（取込本体は継続）:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error('監査ログ記録失敗（取込本体は継続）:', String((e as Error)?.message || e));
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // import の失敗を監査ログに残すための文脈。認証を通り action=import と判明した時点で設定する
  //（未認証・dry_run の失敗はログに残さない＝ノイズと外部からのログ汚染を防ぐ）。
  let auditCtx: { admin: ReturnType<typeof createClient>; caller: string; source: unknown } | null = null;

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
    if (action === 'import') auditCtx = { admin, caller, source: body.source };

    // --- Salesforce から取得・整形（読取のみ） ---
    const { rows, report } = await sfFetchRows();
    if (rows.length === 0) {
      throw new Error('取込条件適用後の行が0件です。安全のため処理を中止しました（レポート内容を確認してください）。');
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
      // 置換前に差分を算出（監査ログに「何件増えて何件減ったか」を残すため）
      const { data: before, error: befErr } = await admin
        .from(TABLE).select(COLUMNS.join(',')).order('id', { ascending: true }).limit(10000);
      if (befErr) throw new Error(`${TABLE} 既存行の取得失敗: ${befErr.message}`);
      const { added, removed } = diffMultiset(rows, before || [], contentKey);

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

      const logged = await logAudit(admin, {
        op: 'IMPORT',
        caller,
        source: body.source,
        rowKey: String(report.name || 'SFレポート'),
        changes: {
          imported: { new: String(rows.length) },
          added:    { new: String(added.length) },
          removed:  { new: String(removed.length) },
        },
      });

      return json({
        ok: true, action: 'import', caller, report,
        imported: rows.length, deleted_old: maxOldId,
        added: added.length, removed: removed.length,
        audit_logged: logged,
      });
    }

    return json({ error: '不明なアクションです（dry_run / import）' }, 400);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (auditCtx) {
      await logAudit(auditCtx.admin, {
        op: 'ERROR',
        caller: auditCtx.caller,
        source: auditCtx.source,
        rowKey: '取込失敗',
        changes: { error: { new: msg.slice(0, 200) } },
      });
    }
    return json({ error: msg }, 500);
  }
});
