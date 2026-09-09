// 取引先マスタ配信 Edge Function（sf-export）
//
// 役割：統合管理ツール（ハブ）の会社マスタを正本として、Salesforce の取引先（Account）へ配信する。
//       ハブ→SF の一方向。SF 側の値はハブから来たもので上書きし、**ハブが空になった項目は null を送って SF も空にする**
//      （ハブが正本＝削除も反映。2026-09-09 原島さんのテストで「業種を外しても SF に残る」→仕様変更）。
//       例外＝会社マスタID・取引先コード・社名は空にしない。本番の初回だけ「SF が空のときだけ埋める」項目を
//       body.keep_if_empty（API名の配列）で指定できる（DRY 要決定 C／E＝電話・FAX・許可）。
//       キーは会社マスタID（Account.HubCompanyId__c・外部ID）。
//       sf-import（SF→ハブ・読取専用）の逆方向版。認証・呼び出し方は sf-import と同型。
//       実行記録はアプリ共通の監査ログではなく取引先マスタの連携ログ integration_log へ書く（2026-09-09 坂本さん指摘＝
//       即時配信で監査ログが埋まるため）。接続先・版・方式を毎回 meta に残し、画面はそれを最新値として表示する。
//
// 認証（どちらかを満たすこと）：
//   a) Supabase JWT が admin ロール
//   b) x-import-secret ヘッダが IMPORT_SECRET と一致（スクリプト／スケジュール実行用）
//      ※どちらも Verify JWT を通すため Authorization には最低 anon キーが必要
//
// POST body：
//   action  … dry_run（既定・書込なし・件数と分類の報告）
//              link   （SF 側で会社マスタIDを持たない取引先を正規化社名でハブと突合し、
//                       一意に当たったものへ会社マスタID＋取引先コードを付ける＝配信前の「更新扱い」化）
//              export （composite/sobjects で 200件/コールの外部ID upsert・allOrNone=false）
//   mode    … full（既定・有効な会社を全件）／direct（ハブのトリガから保存のたびに呼ばれる即時配信・2026-09-09。
//              company_ids 必須。1回の保存で複数行が別トランザクションで書かれるため、3秒待ってからハブを読み直す）
//   source  … 実行元の名乗り（script / cron / trigger / app）。監査ログの表示に使う
//   scope   … active（既定・有効な会社のみ）／all（欠番も含む。欠番は SF に既存があれば有効フラグ=false で更新、無ければ作らない）
//              ※ mode=direct と company_ids 指定は常に all 相当（欠番化も即時に SF へ伝える）
//   company_ids … 会社マスタIDの配列で対象を絞る（試し流し・個別再送）
//   limit   … 先頭 N 社だけ（試し流し用）
//   writeback … true のとき upsert で返った Account Id を hub の system_code(system='salesforce') へ保存（既定 false）
//
// 必要な Secrets：
//   SF_EXPORT_INSTANCE_URL / SF_EXPORT_CLIENT_ID / SF_EXPORT_CLIENT_SECRET
//   SF_EXPORT_ALLOWED_ORG_IDS … 書込を許す org ID（15桁・カンマ区切り）。本番 org を誤って向けても書かない安全弁
//   IMPORT_SECRET（sf-import と共通）
//
// 安全鉄則：
//   - 接続先 org ID が SF_EXPORT_ALLOWED_ORG_IDS に無ければ、どの action でも書込前に中止
//   - 取引先コードが SF の別レコード（会社マスタID無し）に付いている会社は送らず「コード衝突」として報告
//     （送っても DUPLICATE_VALUE で落ちる。先に link で解消する）
//   - 承認・反社ゲートは第1弾では掛けない（要決定⑤の推奨どおり）。掛けるときは buildRecord の手前で絞る
//   - direct モード／company_ids 指定は対象の会社だけをハブ・SF から読む（全件読取をしない）。
//     失敗は監査ログ ERROR と応答に残し、夜間の全件配信（sf_export_cron.sql）が取りこぼしを拾う

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-import-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const API_VERSION = 'v61.0';
const BATCH = 200; // composite/sobjects の上限
const VERSION = '2026-09-09.5'; // 連携ログ meta.version（画面の「版」に出る）
const PAYLOAD_MAX_ITEMS = 200;  // 連携ログ payload に残す会社数の上限（夜間全件の初回など）
// 送信項目の表示ラベル（連携ログの「送信内容」に出す。SF 側のラベルと同じにしてある）
const FIELD_LABELS: Record<string, string> = {
  Name: '取引先名', NameKana__c: '取引先名称（カナ）', CorporateNumber__c: '法人番号', RepresentativeName__c: '代表者名',
  InvoiceRegNo__c: '適格請求書発行事業者登録番号', InvoiceStatus__c: '適格請求書 該当/非該当', IsNonQualified__c: '非適格事業者',
  BillingPostalCode: '郵便番号', BillingState: '都道府県', BillingCity: '市区郡', BillingStreet: '町名・番地', HeadOfficeAddress__c: '本社所在地',
  Phone: '電話', Fax: 'FAX', PartnerType__c: '取引先種別', IsActive__c: '有効フラグ', LastDealDate__c: '最終取引日', Capital__c: '資本金',
  HubRemarks__c: '会社マスタ備考', CreditLimit__c: '与信額', Licenses__c: '建設業許可（業種）', ConstructionPermitAuthority__c: '建設業許可 大臣/知事',
  ConstructionPermitNo__c: '建設業許可番号', WastePermitNo__c: '産廃収集運搬許可番号', BugyoPartnerCode__c: '奉行 取引先コード',
  Business_Partners_Code__c: '取引先コード', HubCompanyId__c: '会社マスタID',
};
const MULTI_FIELDS = new Set(['PartnerType__c', 'Licenses__c']);
const NUM_FIELDS = new Set(['Capital__c', 'CreditLimit__c']);
// 差分比較用の正規化（空＝null・複数選択は順序無視・数値は数で）
function normVal(f: string, v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (MULTI_FIELDS.has(f)) return String(v).split(';').map((x) => x.trim()).filter(Boolean).sort().join(';');
  if (NUM_FIELDS.has(f)) return String(Number(v));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v).trim();
}
// 送信レコードと SF の現在値から「変わる項目」だけを抜く（old=SF の今・new=送る値）
function diffFields(rec: Record<string, unknown>, cur: Record<string, unknown> | null) {
  const out: { f: string; l: string; old: unknown; new: unknown }[] = [];
  for (const f of Object.keys(rec)) {
    if (f === 'HubCompanyId__c') continue;
    const nv = normVal(f, rec[f]); const ov = cur ? normVal(f, cur[f]) : null;
    if (nv !== ov) out.push({ f, l: FIELD_LABELS[f] || f, old: cur ? (cur[f] ?? null) : null, new: rec[f] ?? null });
  }
  return out;
}
// ハブが空でも SF の値を消さない項目（キーと社名）。本番初回は body.keep_if_empty で電話・FAX・許可などを足せる
const KEEP_IF_EMPTY = new Set(['HubCompanyId__c', 'Name', 'Business_Partners_Code__c']);
const LOG = 'integration_log';   // 取引先マスタの連携ログ
const SYSTEM = 'salesforce';
const DIRECT_SETTLE_MS = 3000; // direct: 保存の残りのトランザクションが確定するのを待つ

type Admin = ReturnType<typeof createClient>;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---------------- マッピング v0.2（ハブ106項目→Account・2026-09-08 の決定を反映） ----------------
// ハブ type_code → PartnerType__c の値（12値・SF とハブで共通）
const TYPE_MAP: Record<string, string> = {
  customer: '顧客', owner: '施主', scrap: 'スクラップ', subcontractor: '外注（請負）', survey3d: '3D計測',
  analysis: '分析・解析', waste: '産廃処理', lease: '重機・リース', material: '資材', fuel: '燃料',
  security: '保安警備', sga: '販管費先',
};
// 建設業許可の略号 → Licenses__c（法定29業種の正式名称）。般/特は落とす。旧列は同名へ畳む。「夕」は「タ」の誤入力
const PERMIT_MAP: Record<string, string> = {
  '土': '土木一式工事', '建': '建築一式工事', '大': '大工工事', '左': '左官工事', 'と': 'とび・土工・コンクリート工事',
  '石': '石工事', '屋': '屋根工事', '電': '電気工事', '管': '管工事', 'タ': 'タイル・れんが・ブロック工事', '夕': 'タイル・れんが・ブロック工事',
  '鋼': '鋼構造物工事', '筋': '鉄筋工事', '舗': '舗装工事', 'しゅ': 'しゅんせつ工事', '板': '板金工事', 'ガ': 'ガラス工事',
  '塗': '塗装工事', '防': '防水工事', '内': '内装仕上工事', '機': '機械器具設置工事', '絶': '熱絶縁工事', '通': '電気通信工事',
  '園': '造園工事', '井': 'さく井工事', '具': '建具工事', '水': '水道施設工事', '消': '消防施設工事', '清': '清掃施設工事',
  '解': '解体工事', 'とび土工(旧列)': 'とび・土工・コンクリート工事', '解体(旧列)': '解体工事',
};
const SEIREI = ['札幌市', '仙台市', 'さいたま市', '千葉市', '横浜市', '川崎市', '相模原市', '新潟市', '静岡市', '浜松市',
  '名古屋市', '京都市', '大阪市', '堺市', '神戸市', '岡山市', '広島市', '北九州市', '福岡市', '熊本市'];

function convertPermit(s: string | null): string[] {
  const names: string[] = [];
  for (const tok of String(s || '').split(';')) {
    const code = tok.trim().split('=')[0].trim();
    const name = PERMIT_MAP[code];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
// address_line の先頭から市区郡を切り出す（dry_diff_本番読取_2026-09-08.py の split_city と同じ規則）
function splitCity(addr: string | null): [string, string] {
  const a = String(addr || '').trim();
  if (!a) return ['', ''];
  const gun = a.match(/^(.{1,6}?郡.{1,8}?[町村])/);
  if (gun && !a.startsWith('郡山') && !/^.{0,3}郡[市区]/.test(a)) return [gun[1], a.slice(gun[0].length)];
  for (const s of SEIREI) {
    if (a.startsWith(s)) {
      const ku = a.slice(s.length).match(/^(.{1,5}?区)/);
      return ku ? [s + ku[1], a.slice(s.length + ku[0].length)] : [s, a.slice(s.length)];
    }
  }
  const head = a.slice(0, 10);
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '市' && i > 0 && a[i + 1] !== '市') return [a.slice(0, i + 1), a.slice(i + 1)];
  }
  for (const re of [/^(.{1,6}?区)/, /^(.{1,6}?[町村])/]) {
    const m = a.match(re);
    if (m) return [m[1], a.slice(m[0].length)];
  }
  return ['', a];
}
function postal(p: string | null): string {
  const s = String(p || '').trim();
  return /^\d{7}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3)}` : s;
}
// 社名の正規化（link 用）: NFKC・空白除去・㈱→株式会社
function normName(s: string | null): string {
  return String(s || '').normalize('NFKC').replace(/[\s　]/g, '').replace(/㈱|\(株\)/g, '株式会社');
}

type Hub = {
  companies: Record<string, unknown>[];
  types: Map<string, string[]>;
  codes: Map<string, Record<string, string>>;
  permits: Map<string, Record<string, unknown>[]>;
  credit: Map<string, number>;
};

// ハブ読取。ids を渡すとその会社だけ（queue／company_ids 指定）、無ければ全件（ページング）
async function fetchRows(admin: Admin, table: string, select: string, order: string, ids: string[] | null) {
  const out: Record<string, unknown>[] = [];
  if (ids) {
    for (const c of chunks(ids, 200)) {
      const { data, error } = await admin.from(table).select(select).in('company_id', c).order(order, { ascending: true });
      if (error) throw new Error(`${table} 読取失敗: ${error.message}`);
      out.push(...(data || []));
    }
    return out;
  }
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from(table).select(select).order(order, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table} 読取失敗: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

async function loadHub(admin: Admin, ids: string[] | null): Promise<Hub> {
  const companies = await fetchRows(admin, 'company',
    'company_id,official_name,name_kana,corporate_number,representative_name,postal_code,prefecture,address_line,building,phone,fax,invoice_reg_number,invoice_status,capital_amount,remarks,last_trade_on,is_suspended', 'company_id', ids);
  const types = new Map<string, string[]>();
  for (const t of await fetchRows(admin, 'company_type', 'company_id,type_code', 'company_id', ids)) {
    const k = String(t.company_id); types.set(k, [...(types.get(k) || []), String(t.type_code)]);
  }
  const codes = new Map<string, Record<string, string>>();
  for (const s of await fetchRows(admin, 'system_code', 'company_id,system,code', 'company_id', ids)) {
    const k = String(s.company_id); const m = codes.get(k) || {}; m[String(s.system)] = String(s.code); codes.set(k, m);
  }
  const permits = new Map<string, Record<string, unknown>[]>();
  for (const p of await fetchRows(admin, 'permit_license', 'company_id,permit_type,construction_types,permit_authority,permit_number', 'permit_id', ids)) {
    const k = String(p.company_id); permits.set(k, [...(permits.get(k) || []), p]);
  }
  const credit = new Map<string, number>();
  for (const c of await fetchRows(admin, 'credit_line', 'company_id,limit_amount', 'credit_id', ids)) {
    if (c.limit_amount != null) credit.set(String(c.company_id), Number(c.limit_amount));
  }
  return { companies, types, codes, permits, credit };
}

// ハブ1社 → Account upsert レコード。ハブが空の項目は null（SF を空にする）。keepIfEmpty の項目だけ送らない
function buildRecord(hub: Hub, c: Record<string, unknown>, keepIfEmpty: Set<string>): Record<string, unknown> {
  const cid = String(c.company_id);
  const codes = hub.codes.get(cid) || {};
  const permits = hub.permits.get(cid) || [];
  const cons = permits.find((p) => p.permit_type === 'construction');
  const waste = permits.find((p) => p.permit_type === 'waste');
  const [city, rest] = splitCity(c.address_line as string);
  const bld = String(c.building || '').trim();
  const wasteNo = waste ? String(waste.permit_number || '') : '';
  const licenses = cons ? convertPermit(cons.construction_types as string) : [];
  const rec: Record<string, unknown> = {
    HubCompanyId__c: cid,
    Name: c.official_name,
    Business_Partners_Code__c: codes.tera,
    BugyoPartnerCode__c: codes.obc_onpre,
    NameKana__c: c.name_kana,
    CorporateNumber__c: c.corporate_number,
    RepresentativeName__c: c.representative_name,
    InvoiceRegNo__c: c.invoice_reg_number,
    InvoiceStatus__c: c.invoice_status,
    IsNonQualified__c: c.invoice_status === '登録なし(確認済)',
    BillingPostalCode: postal(c.postal_code as string),
    BillingState: c.prefecture,
    BillingCity: city,
    BillingStreet: (rest.trim() + (bld ? ' ' + bld : '')).trim(),
    HeadOfficeAddress__c: (String(c.prefecture || '') + String(c.address_line || '') + (bld ? ' ' + bld : '')).trim(),
    Phone: c.phone,
    Fax: c.fax,
    PartnerType__c: (hub.types.get(cid) || []).map((t) => TYPE_MAP[t]).filter(Boolean).join(';'),
    IsActive__c: !c.is_suspended,
    LastDealDate__c: c.last_trade_on,
    Capital__c: c.capital_amount,
    HubRemarks__c: c.remarks,
    CreditLimit__c: hub.credit.get(cid),
    Licenses__c: licenses.join(';'),
    ConstructionPermitAuthority__c: cons ? cons.permit_authority : null,
    ConstructionPermitNo__c: cons ? cons.permit_number : null,
    // 「〇」は"許可あり"の印で番号ではない → 数字を含むときだけ送る
    WastePermitNo__c: /\d/.test(wasteNo) ? wasteNo : null,
  };
  // 取引先コードは4文字まで（X0001〜X0005 の5文字は会社マスタIDで救う）
  if (rec.Business_Partners_Code__c && String(rec.Business_Partners_Code__c).length > 4) delete rec.Business_Partners_Code__c;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (v === null || v === undefined || v === '') {
      if (keepIfEmpty.has(k)) delete rec[k];   // 送らない＝SF の既存値を残す
      else rec[k] = null;                      // 空を送る＝SF も空にする（ハブが正本）
    }
  }
  return rec;
}

// ---------------- Salesforce ----------------
type Sf = { base: string; token: string; orgId: string; isSandbox: boolean; orgName: string };

async function sfConnect(): Promise<Sf> {
  const base = (Deno.env.get('SF_EXPORT_INSTANCE_URL') || '').replace(/\/+$/, '');
  const clientId = Deno.env.get('SF_EXPORT_CLIENT_ID');
  const clientSecret = Deno.env.get('SF_EXPORT_CLIENT_SECRET');
  if (!base || !clientId || !clientSecret) throw new Error('SF_EXPORT_INSTANCE_URL / SF_EXPORT_CLIENT_ID / SF_EXPORT_CLIENT_SECRET のSecretsが未設定です');
  const tokenRes = await fetch(base + '/services/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const tokenBody = await tokenRes.json();
  if (!tokenRes.ok || !tokenBody.access_token) throw new Error('SFトークン取得失敗: ' + JSON.stringify(tokenBody).slice(0, 300));
  const sf: Sf = { base, token: tokenBody.access_token, orgId: '', isSandbox: false, orgName: '' };
  const org = await sfQuery(sf, 'SELECT Id, Name, IsSandbox FROM Organization');
  sf.orgId = String(org[0]?.Id || '').slice(0, 15);
  sf.isSandbox = !!org[0]?.IsSandbox;
  sf.orgName = String(org[0]?.Name || '');
  const allowed = (Deno.env.get('SF_EXPORT_ALLOWED_ORG_IDS') || '').split(',').map((s) => s.trim().slice(0, 15)).filter(Boolean);
  if (!allowed.includes(sf.orgId)) {
    throw new Error(`接続先 org ${sf.orgId}（${sf.orgName}・sandbox=${sf.isSandbox}）は SF_EXPORT_ALLOWED_ORG_IDS に含まれていません。安全のため中止しました`);
  }
  return sf;
}

async function sfQuery(sf: Sf, soql: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let url = `${sf.base}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  for (;;) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + sf.token } });
    const body = await res.json();
    if (!res.ok) throw new Error('SOQL失敗: ' + JSON.stringify(body).slice(0, 300));
    out.push(...(body.records || []));
    if (body.done || !body.nextRecordsUrl) return out;
    url = sf.base + body.nextRecordsUrl;
  }
}
const soqlIn = (vals: string[]) => vals.map((v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');

// SF 側の既存取引先（送信項目すべて＝差分算出に使う）。targets を渡すと対象の会社マスタID＋取引先コードに絞って読む
const SF_SELECT_FIELDS = ['Id', ...Object.keys(FIELD_LABELS)];
async function loadSfAccounts(sf: Sf, targets: { ids: string[]; codes: string[] } | null): Promise<Record<string, unknown>[]> {
  const sel = `SELECT ${SF_SELECT_FIELDS.join(', ')} FROM Account`;
  if (!targets) return await sfQuery(sf, sel);
  const seen = new Map<string, Record<string, unknown>>();
  for (const c of chunks(targets.ids, 200)) for (const a of await sfQuery(sf, `${sel} WHERE HubCompanyId__c IN (${soqlIn(c)})`)) seen.set(String(a.Id), a);
  for (const c of chunks(targets.codes, 200)) for (const a of await sfQuery(sf, `${sel} WHERE Business_Partners_Code__c IN (${soqlIn(c)})`)) seen.set(String(a.Id), a);
  return [...seen.values()];
}

type SfResult = { id?: string; success: boolean; created?: boolean; errors?: { statusCode?: string; message?: string }[] };

// 外部ID upsert（composite/sobjects・allOrNone=false）
async function sfUpsertBatch(sf: Sf, records: Record<string, unknown>[]): Promise<SfResult[]> {
  const res = await fetch(`${sf.base}/services/data/${API_VERSION}/composite/sobjects/Account/HubCompanyId__c`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allOrNone: false, records: records.map((r) => ({ attributes: { type: 'Account' }, ...r })) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error('composite upsert 失敗: ' + JSON.stringify(body).slice(0, 300));
  return body as SfResult[];
}
// Id 指定の一括更新（link 用）
async function sfUpdateBatch(sf: Sf, records: Record<string, unknown>[]): Promise<SfResult[]> {
  const res = await fetch(`${sf.base}/services/data/${API_VERSION}/composite/sobjects`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allOrNone: false, records: records.map((r) => ({ attributes: { type: 'Account' }, ...r })) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error('composite update 失敗: ' + JSON.stringify(body).slice(0, 300));
  return body as SfResult[];
}

// ---------------- 連携ログ（integration_log・1実行1行） ----------------
const SOURCES: Record<string, { email: string; trigger: string }> = {
  cron:    { email: 'sf-export（自動実行）',       trigger: '自動（夜間・全件）' },
  trigger: { email: 'sf-export（即時配信）',       trigger: '自動（保存時・即時）' },
  script:  { email: 'sf-export（手動スクリプト）', trigger: '手動（スクリプト）' },
};
const SOURCE_UNKNOWN = { email: 'sf-export（実行元不明）', trigger: '不明（secret経由）' };
function resolveSource(caller: string, source: unknown) {
  if (caller !== 'secret') return { email: caller, trigger: '手動（アプリ）' };
  return SOURCES[String(source || '')] || SOURCE_UNKNOWN;
}
function targetLabel(sf: Sf | null): string {
  if (sf) return `${sf.orgName}（${sf.orgId}・${sf.isSandbox ? 'sandbox' : '本番'}）`;
  return (Deno.env.get('SF_EXPORT_INSTANCE_URL') || '').replace(/^https?:\/\//, '');
}
// 記録の失敗は配信本体を巻き添えにしない（記録できたかは応答の log_written で可視化）
async function logRun(admin: Admin, e: { kind: 'run' | 'error'; action: string; caller: string; source: unknown; sf: Sf | null;
  counts?: Record<string, number | string>; companyIds?: string[] | null; reason?: unknown; message?: string; meta?: Record<string, unknown>; payload?: unknown; t0: number }): Promise<boolean> {
  const who = resolveSource(e.caller, e.source);
  try {
    const { error } = await admin.from(LOG).insert({
      system: SYSTEM, target: targetLabel(e.sf), kind: e.kind, action: e.action, trigger: who.trigger, actor: who.email,
      counts: e.counts || null, company_ids: e.companyIds || null, reason: e.reason ? String(e.reason) : null, message: e.message || null,
      meta: { version: VERSION, allowed_orgs: Deno.env.get('SF_EXPORT_ALLOWED_ORG_IDS') || '', ...(e.meta || {}) },
      payload: e.payload ?? null,
      duration_ms: Date.now() - e.t0,
    });
    if (error) { console.error('連携ログ記録失敗（配信本体は継続）:', error.message); return false; }
    return true;
  } catch (err) { console.error('連携ログ記録失敗（配信本体は継続）:', String((err as Error)?.message || err)); return false; }
}

// ---------------- 本体 ----------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const t0 = Date.now();
  let logCtx: { admin: Admin; caller: string; source: unknown; action: string; sf: Sf | null } | null = null;
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

    // --- 認証（sf-import と同じ） ---
    let caller = 'secret';
    const importSecret = Deno.env.get('IMPORT_SECRET');
    if (!(importSecret && req.headers.get('x-import-secret') === importSecret)) {
      const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
      if (!jwt) return json({ error: '未認証です' }, 401);
      const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
      if (uErr || !userData?.user) return json({ error: '認証が無効です' }, 401);
      const { data: role } = await admin.from('user_roles').select('role').eq('user_id', userData.user.id).maybeSingle();
      if (role?.role !== 'admin') return json({ error: '管理者権限が必要です' }, 403);
      caller = userData.user.email || userData.user.id;
    }
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'dry_run');
    if (!['dry_run', 'link', 'export'].includes(action)) return json({ error: `不明な action: ${action}` }, 400);
    const mode = String(body.mode || 'full');
    const limit = Number(body.limit || 0) || 0;
    const writeback = body.writeback === true;
    const keepIfEmpty = new Set<string>([...KEEP_IF_EMPTY, ...((Array.isArray(body.keep_if_empty) ? body.keep_if_empty : []).map(String))]);

    // --- 対象の決め方（direct／company_ids＝対象を絞る・欠番も含む） ---
    const onlyIds: string[] | null = Array.isArray(body.company_ids) && body.company_ids.length ? [...new Set(body.company_ids.map(String))] : null;
    if (mode === 'direct') {
      if (!onlyIds) return json({ error: 'direct モードは company_ids が必要です' }, 400);
      // 1回の保存で会社本体・種別・許可などが別々のトランザクションで書かれる。全部確定してから読み直す
      await new Promise((r) => setTimeout(r, DIRECT_SETTLE_MS));
    }
    const scope = onlyIds ? 'all' : String(body.scope || 'active');
    if (action !== 'dry_run') logCtx = { admin, caller, source: body.source, action, sf: null };

    // --- 接続（org ガード込み）・ハブ読取・SF 現状読取 ---
    const sf = await sfConnect();
    if (logCtx) logCtx.sf = sf;
    const hub = await loadHub(admin, onlyIds);
    const targetCodes = onlyIds ? [...new Set(hub.companies.map((c) => (hub.codes.get(String(c.company_id)) || {}).tera).filter((x): x is string => !!x))] : [];
    const sfAccounts = await loadSfAccounts(sf, onlyIds ? { ids: onlyIds, codes: targetCodes } : null);
    const sfByHub = new Map<string, Record<string, unknown>>();
    const sfByCode = new Map<string, Record<string, unknown>>();
    for (const a of sfAccounts) {
      if (a.HubCompanyId__c) sfByHub.set(String(a.HubCompanyId__c), a);
      if (a.Business_Partners_Code__c) sfByCode.set(String(a.Business_Partners_Code__c), a);
    }
    const hubByNorm = new Map<string, string[]>();
    for (const c of hub.companies) {
      const k = normName(c.official_name as string); hubByNorm.set(k, [...(hubByNorm.get(k) || []), String(c.company_id)]);
    }

    // ===== link：会社マスタID無しの SF 取引先を社名で突合してキーを付ける（全件モードのみ） =====
    if (action === 'link') {
      if (onlyIds) return json({ error: 'link は全件モードで実行してください（company_ids／direct は不可）' }, 400);
      const unlinked = sfAccounts.filter((a) => !a.HubCompanyId__c);
      const seenHub = new Set<string>();
      const updates: Record<string, unknown>[] = [];
      const ambiguous: string[] = [];
      const nomatch: string[] = [];
      for (const a of unlinked) {
        const cands = (hubByNorm.get(normName(a.Name as string)) || []).filter((cid) => !sfByHub.has(cid));
        if (cands.length !== 1) { (cands.length ? ambiguous : nomatch).push(String(a.Name)); continue; }
        const cid = cands[0];
        if (seenHub.has(cid)) { ambiguous.push(String(a.Name)); continue; }
        const tera = (hub.codes.get(cid) || {}).tera;
        const codeHolder = tera ? sfByCode.get(tera) : undefined;
        if (codeHolder && codeHolder.Id !== a.Id) { ambiguous.push(`${a.Name}（コード${tera}は別レコードに付与済み）`); continue; }
        seenHub.add(cid);
        const u: Record<string, unknown> = { Id: a.Id, HubCompanyId__c: cid };
        if (tera && String(tera).length <= 4 && !a.Business_Partners_Code__c) u.Business_Partners_Code__c = tera;
        updates.push(u);
      }
      let ok = 0; const failed: { id: string; message: string }[] = [];
      for (const c of chunks(updates, BATCH)) {
        const res = await sfUpdateBatch(sf, c);
        res.forEach((r, j) => { if (r.success) ok++; else failed.push({ id: String(c[j].Id), message: (r.errors || []).map((e) => e.message).join('; ').slice(0, 200) }); });
      }
      const logged = await logRun(admin, { kind: 'run', action: 'link', caller, source: body.source, sf, t0,
        counts: { linked: ok, failed: failed.length, unlinked_before: unlinked.length, ambiguous: ambiguous.length, nomatch: nomatch.length }, meta: { mode } });
      return json({ ok: true, action, org: { id: sf.orgId, name: sf.orgName, sandbox: sf.isSandbox },
        unlinked_before: unlinked.length, linked: ok, failed: failed.length, ambiguous: ambiguous.length, nomatch: nomatch.length,
        failed_samples: failed.slice(0, 20), ambiguous_samples: ambiguous.slice(0, 20), log_written: logged, elapsed_ms: Date.now() - t0 });
    }

    // ===== dry_run / export：配信対象の組み立てと分類 =====
    let targets = hub.companies;
    if (scope === 'active') targets = targets.filter((c) => !c.is_suspended);
    else targets = targets.filter((c) => !c.is_suspended || sfByHub.has(String(c.company_id))); // 欠番は既存があれば更新のみ
    if (limit > 0) targets = targets.slice(0, limit);

    const records: Record<string, unknown>[] = [];
    const cls = { update: 0, create: 0, code_conflict: 0, skipped_suspended: 0 };
    const conflicts: { company_id: string; name: string; code: string; holder: string }[] = [];
    const conflictIds = new Set<string>();
    for (const c of targets) {
      const rec = buildRecord(hub, c, keepIfEmpty);
      const cid = String(c.company_id);
      const tera = rec.Business_Partners_Code__c ? String(rec.Business_Partners_Code__c) : '';
      const holder = tera ? sfByCode.get(tera) : undefined;
      if (holder && String(holder.HubCompanyId__c || '') !== cid) {
        cls.code_conflict++; conflictIds.add(cid); conflicts.push({ company_id: cid, name: String(c.official_name), code: tera, holder: String(holder.Name) });
        continue;
      }
      if (sfByHub.has(cid)) cls.update++; else cls.create++;
      records.push(rec);
    }
    if (onlyIds) cls.skipped_suspended = hub.companies.length - targets.length; // 欠番で SF に無い＝作らない
    const fieldFill: Record<string, number> = {};
    for (const r of records) for (const k of Object.keys(r)) if (r[k] !== null) fieldFill[k] = (fieldFill[k] || 0) + 1;

    if (action === 'dry_run') {
      const linkable = onlyIds ? null : sfAccounts.filter((a) => !a.HubCompanyId__c && (hubByNorm.get(normName(a.Name as string)) || []).length === 1).length;
      return json({ ok: true, action, mode, org: { id: sf.orgId, name: sf.orgName, sandbox: sf.isSandbox },
        hub_companies: hub.companies.length, sf_accounts: sfAccounts.length, sf_linked: sfByHub.size,
        targets: targets.length, will_update: cls.update, will_create: cls.create, code_conflict: cls.code_conflict, skipped_suspended: cls.skipped_suspended,
        conflict_samples: conflicts.slice(0, 20), field_fill: fieldFill, sample: records.slice(0, 2),
        linkable_by_name: linkable,
        note: '書込は行っていません。code_conflict は取引先コードが SF の別レコードに付いている会社＝先に action=link で解消してください。',
        elapsed_ms: Date.now() - t0 });
    }

    // ===== export =====
    // 送信内容（変わる項目だけ）を送る前に確定しておく＝連携ログの payload
    const items: { company_id: string; name: string; action: 'create' | 'update'; fields: { f: string; l: string; old: unknown; new: unknown }[] }[] = [];
    let totalChanged = 0;
    for (const rec of records) {
      const cid = String(rec.HubCompanyId__c);
      const cur = sfByHub.get(cid) || null;
      const fields = diffFields(rec, cur);
      if (!fields.length) continue;
      totalChanged++;
      if (items.length < PAYLOAD_MAX_ITEMS) items.push({ company_id: cid, name: String(rec.Name || ''), action: cur ? 'update' : 'create', fields });
    }
    const payload = { items, total_changed: totalChanged, truncated: totalChanged > items.length };
    let created = 0, updated = 0; const failed: { company_id: string; name: string; message: string }[] = [];
    const idByCompany: Record<string, string> = {};
    for (const chunk of chunks(records, BATCH)) {
      const res = await sfUpsertBatch(sf, chunk);
      res.forEach((r, j) => {
        const cid = String(chunk[j].HubCompanyId__c);
        if (r.success) { if (r.created) created++; else updated++; if (r.id) idByCompany[cid] = r.id; }
        else failed.push({ company_id: cid, name: String(chunk[j].Name), message: (r.errors || []).map((e) => `${e.statusCode}: ${e.message}`).join('; ').slice(0, 200) });
      });
    }
    let wroteBack = 0;
    if (writeback) {
      const rows = Object.entries(idByCompany).map(([company_id, code]) => ({ company_id, system: 'salesforce', code }));
      for (const c of chunks(rows, 500)) {
        const { error } = await admin.from('system_code').upsert(c, { onConflict: 'company_id,system' });
        if (error) { failed.push({ company_id: '-', name: '(writeback)', message: 'system_code 書き戻し失敗: ' + error.message }); break; }
        wroteBack += c.length;
      }
    }
    const logged = await logRun(admin, { kind: 'run', action: 'export', caller, source: body.source, sf, t0,
      counts: { sent: records.length, created, updated, failed: failed.length, code_conflict: cls.code_conflict, writeback: wroteBack, skipped_suspended: cls.skipped_suspended, changed: totalChanged },
      companyIds: onlyIds, reason: body.reason, payload,
      meta: { mode, scope, settle_ms: mode === 'direct' ? DIRECT_SETTLE_MS : 0, writeback, batch: BATCH, key: 'HubCompanyId__c', keep_if_empty: [...keepIfEmpty] } });
    return json({ ok: true, action, mode, org: { id: sf.orgId, name: sf.orgName, sandbox: sf.isSandbox },
      targets: targets.length, sent: records.length, created, updated, failed: failed.length, code_conflict: cls.code_conflict, skipped_suspended: cls.skipped_suspended,
      failed_samples: failed.slice(0, 20), conflict_samples: conflicts.slice(0, 20), writeback: wroteBack,
      changed: totalChanged, changes_sample: items.slice(0, 5),
      log_written: logged, elapsed_ms: Date.now() - t0 });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (logCtx) {
      await logRun(logCtx.admin, { kind: 'error', action: logCtx.action, caller: logCtx.caller, source: logCtx.source, sf: logCtx.sf, t0, message: msg.slice(0, 500) });
    }
    return json({ ok: false, error: msg, elapsed_ms: Date.now() - t0 }, 500);
  }
});
