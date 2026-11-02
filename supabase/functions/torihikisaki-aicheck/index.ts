// 取引先マスタ AIの点検 Edge Function（torihikisaki-aicheck・2026-11-02）
//
// 役割：会社の画面の［AIで点検］を押したとき、その会社の保存済みの内容を Claude に点検させ、指摘を company_ai_check に残す
//   （11/02 坂本さん：保存のたびに自動 → 手動に変更）。
//   点検の中身（坂本さん 11/02 決定）＝ ①社名の揺れ ②住所の食い違い ③重複しそうな会社 ④種別と中身の矛盾
//
// 🔴設計の鉄則：
//   1) AI は値を書き換えない。この関数が書くのは company_ai_check（点検の記録）だけ。
//      直す値が決まる指摘には path（項目）と value（案）を付ける＝画面の［案を入れる］で未保存の変更に入り、経理が「💾 保存」で確定する。
//   2) 鍵（ANTHROPIC_API_KEY）は Secrets にだけ置く。ブラウザへは返さない（status は有無だけ）。
//      鍵は坂本さんの Claude API（個人の org）＝本番の会社でも動かす（11/02 坂本さん）。
//   3) 口座（bank_account）・支払条件・請求先は Claude に送らない。送るのは会社の基本情報・種別・支店・
//      旧社名・種別ごとの情報・与信の有無（金額は送らない）・国税庁の登記情報・重複の候補。
//   4) 時刻は DB が付ける（requested_at／finished_at は表の既定値とトリガ）。
//   5) 鍵が無い・Claude が落ちている・断られた ときも、記録は status='error' と理由で閉じる（running のまま残さない）。
//
// 認証：Supabase JWT（admin または accounting）＝取引先マスタの RLS と同じ。
//
// アクション（POST body の action）：
//   status … 版・鍵の有無・モデル
//   check  … { company_id, trigger: 'manual'|'retry' } → 点検して記録を返す
//
// 必要な Secrets：
//   ANTHROPIC_API_KEY … 坂本さんの Claude API の鍵（Masaji's Individual Org）
//   NTA_APP_ID        … 国税庁 法人番号Web-API（torihikisaki-enrich と共通・無ければ登記との突き合わせを省く）
//   （SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は自動で入る）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@0.135.0';

const FN_VERSION = '2026-11-02.2';
const MODEL = 'claude-opus-5-5';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const env = (k: string) => (Deno.env.get(k) || '').trim();

const TYPE_LABELS: Record<string, string> = {
  customer: '顧客', owner: '施主', scrap: 'スクラップ', subcontractor: '外注（請負）', survey3d: '3D計測', analysis: '分析・解析',
  waste: '産廃処理', lease: '重機・リース', material: '資材', fuel: '燃料', security: '保安警備', sga: '販管費先',
};

// ===== 国税庁 法人番号Web-API（登記の商号・所在地・旧商号）=====
// torihikisaki-enrich の fetchKokuzei と同じ呼び方の最小版（読むだけ）
function xmlTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  const v = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
  return v === '' ? null : v;
}
async function fetchRegistry(corporateNumber: string | null) {
  const num = String(corporateNumber || '').replace(/\D/g, '');
  if (!/^\d{13}$/.test(num)) return { note: '法人番号が無い（または 13 桁でない）ので登記は引いていない' };
  const id = env('NTA_APP_ID');
  if (!id) return { note: '国税庁の鍵が無いので登記は引いていない' };
  try {
    const qs = new URLSearchParams({ id, number: num, history: '1', type: '12' });
    const res = await fetch(`https://api.houjin-bangou.nta.go.jp/4/num?${qs}`, { headers: { Accept: 'application/xml' } });
    const text = await res.text();
    if (!res.ok) return { note: `国税庁 HTTP ${res.status}（登記は引けなかった）` };
    const rows = [...text.matchAll(/<corporation>([\s\S]*?)<\/corporation>/g)].map((m) => ({
      name: xmlTag(m[1], 'name'), furigana: xmlTag(m[1], 'furigana'), postCode: xmlTag(m[1], 'postCode'),
      address: [xmlTag(m[1], 'prefectureName'), xmlTag(m[1], 'cityName'), xmlTag(m[1], 'streetNumber')].filter(Boolean).join('') || xmlTag(m[1], 'addressOutside'),
      changeDate: xmlTag(m[1], 'changeDate'), closeDate: xmlTag(m[1], 'closeDate'), closeCause: xmlTag(m[1], 'closeCause'),
      latest: xmlTag(m[1], 'latest'),
    }));
    if (!rows.length) return { note: 'この法人番号は国税庁に見つからなかった' };
    const cur = rows.find((r) => r.latest === '1') || rows[rows.length - 1];
    return {
      current: { name: cur.name, furigana: cur.furigana, postCode: cur.postCode, address: cur.address, closeDate: cur.closeDate, closeCause: cur.closeCause },
      past: rows.filter((r) => r !== cur).map((r) => ({ changeDate: r.changeDate, name: r.name, address: r.address })),
    };
  } catch (e) {
    return { note: `国税庁に届かなかった（${e instanceof Error ? e.message : String(e)}）` };
  }
}

// ===== 点検に渡す材料 =====
const CO_COLS = 'company_id,official_name,name_kana,name_kana_half,name_half,corporate_number,representative_name,search_name_normalized,established_on,' +
  'capital_amount,listing_class,entity_class,domestic_class,industry_code,business_summary,employee_count,postal_code,prefecture,address_line,' +
  'building,registered_address,phone,fax,website_url,invoice_reg_number,invoice_status,trade_status,major_class,construction_class,' +
  'is_suspended,suspend_reason,last_trade_on,registration_stage,remarks,updated_at';

// deno-lint-ignore no-explicit-any
type Sb = any;

async function loadMaterial(sb: Sb, cid: string) {
  const one = (t: string, cols = '*') => sb.from(t).select(cols).eq('company_id', cid);
  const [co, ty, br, sc, nh, sub, cus, scr, cl] = await Promise.all([
    sb.from('company').select(CO_COLS).eq('company_id', cid).maybeSingle(),
    one('company_type', 'type_code'), one('branch', 'branch_no,branch_name,postal_code,address,phone'),
    one('system_code', 'system'), one('company_name_history', 'changed_on,old_name,new_name'),
    one('company_subcontractor', 'specialty_work,service_areas,outsourcing_class'),
    one('company_customer', 'industry_sector'), one('company_scrap', 'item_types,trade_direction'),
    one('credit_line', 'company_id'),
  ]);
  const bad = [co, ty, br, sc, nh, sub, cus, scr, cl].find((r) => r.error);
  if (bad) throw new Error(`会社の読み込みに失敗: ${bad.error.message}`);
  if (!co.data) throw new Error(`会社 ${cid} が見つかりません`);
  const c = co.data;
  return {
    company: c,
    types: (ty.data || []).map((r: { type_code: string }) => TYPE_LABELS[r.type_code] || r.type_code),
    branches: br.data || [],
    linkedSystems: (sc.data || []).map((r: { system: string }) => r.system),
    nameHistory: nh.data || [],
    subcontractorInfo: (sub.data || [])[0] || null,
    customerInfo: (cus.data || [])[0] || null,
    scrapInfo: (scr.data || [])[0] || null,
    hasCreditLine: (cl.data || []).length > 0,
  };
}

// 重複の候補＝同じ法人番号・同じ電話・同じ FAX・似た名前（自分は除く・停止の会社も含める）
async function findDuplicates(sb: Sb, c: Record<string, unknown>) {
  const safe = (v: unknown) => String(v ?? '').replace(/[,()*"\\]/g, '').trim();
  const ors: string[] = [];
  const num = safe(c.corporate_number);
  if (/^\d{13}$/.test(num)) ors.push(`corporate_number.eq.${num}`);
  for (const k of ['phone', 'fax']) {
    const p = safe(c[k]);
    if (p.replace(/\D/g, '').length >= 9) { ors.push(`phone.eq.${p}`, `fax.eq.${p}`); }
  }
  const core = safe(c.search_name_normalized || c.official_name);
  if (core.length >= 2) ors.push(`search_name_normalized.ilike.*${core.length > 10 ? core.slice(0, 8) : core}*`);
  if (!ors.length) return [];
  const { data, error } = await sb.from('company')
    .select('company_id,official_name,corporate_number,phone,fax,prefecture,address_line,is_suspended,is_test')
    .or([...new Set(ors)].join(',')).neq('company_id', c.company_id).limit(15);
  if (error) throw new Error(`重複の候補の検索に失敗: ${error.message}`);
  return data || [];
}

// ===== Claude =====
// [案を入れる] で直せる項目（画面の会社の欄のパス）。画面の側でも直せる欄かを確かめる
const FIXABLE: Record<string, string> = {
  'company.official_name': '正式社名', 'company.name_kana': 'カナ（全角）', 'company.name_kana_half': 'カナ（半角）', 'company.name_half': '略称（半角）',
  'company.corporate_number': '法人番号', 'company.representative_name': '代表者名', 'company.postal_code': '郵便番号（ハイフンなし 7 桁）',
  'company.prefecture': '都道府県', 'company.address_line': '住所（市区町村以下）', 'company.building': '建物名',
  'company.registered_address': '本店所在地（登記）', 'company.phone': '電話番号', 'company.fax': 'FAX', 'company.website_url': 'ホームページ',
  'company.invoice_reg_number': 'インボイス登録番号（T＋13 桁）',
};

const SYSTEM = `あなたは建設会社（ベステラ株式会社）の経理部で、取引先マスタの登録内容を点検する担当者です。
渡された 1 社分の登録内容を読み、次の 4 つの観点で「直すべき・確かめるべき点」だけを指摘してください。

1. 社名の揺れ: 登録の社名（official_name）と国税庁の登記の商号（registry.current.name）の違い。株式会社の前後・㈱などの略記・全角と半角・旧商号のまま、など。カナ（name_kana）が社名と合わないものも含む。
2. 住所の食い違い: 郵便番号と都道府県・住所が合っているか。登記の所在地（registry.current）や本店所在地の欄（registered_address）との違い。支店の住所の明らかな誤りも含む。
3. 重複しそうな会社: duplicateCandidates の中で、同じ会社が二重に登録されていそうなもの（同じ法人番号・同じ電話・ほぼ同じ名前と住所）。名前が少し似ているだけの別会社は指摘しない。
   法人番号が両方に入っていて違うものは別の法人なので、電話や住所が同じでも指摘しない（グループ会社の代表電話は同じことが多い）。
   候補がすでに取引停止（is_suspended）なら、そのことを why に書く。
4. 種別と中身の矛盾: 取引先種別（types）と、書かれている中身がはっきり食い違うもの。例: 事業内容が種別と明らかに相いれない、閉鎖した法人（registry.current.closeDate）が取引中のまま、取引停止なのに停止の理由が取引中を示している。
   種別は経理が取引の台帳を見て付けている。あなたは台帳を見ていないので、種別ごとの情報（subcontractorInfo／customerInfo／scrapInfo）が null・空であること、与信が無いこと、事業内容に書かれていないことは、種別が誤っている根拠にしない。

守ること:
- 法人番号は本店を移しても変わらない。法人番号の数字から所在地や管轄を推し量って指摘しない（インボイスの登録番号が「T＋法人番号」と合わないのは指摘してよい）。
- 渡されたデータに根拠があるものだけを書く。推測や一般論は書かない。データが無いこと自体（空欄）は指摘しない（必須の空欄は別の仕組みが出している）。
- 1 つの指摘は 1 つの項目について。field は画面の項目名の日本語（例: 社名・カナ・郵便番号・住所・電話番号・種別・重複）。
- why は何と何が食い違っているかを、値を引用して 1 文で。fix は直し方の案を短く（例:「株式会社東亜テクノ」に直す／同じ会社なら 00001234 を使う）。
- level は、明らかな誤り・重複の疑いが強いものを err、確かめてほしいものを warn。
- 直す値がデータから一つに決まるときだけ、path に直す項目、value に入れる値そのもの（欄に入れる完全な値）を入れる。
  例: カナを社名の読みに合わせる／インボイス登録番号を「T＋法人番号」に／登記の商号・郵便番号に合わせる。
  直す値が一つに決まらないもの（「〜など」「確かめて直す」）、重複、種別の指摘は path と value を空文字にする。
  直せる項目（path: 意味）: ${Object.entries(FIXABLE).map(([k, v]) => `${k}: ${v}`).join('／')}
- 指摘は多くても 8 件。気になる点が無ければ findings は空の配列。`;

const SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['warn', 'err'] },
          field: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
          path: { type: 'string', enum: ['', ...Object.keys(FIXABLE)] },
          value: { type: 'string' },
        },
        required: ['level', 'field', 'why', 'fix', 'path', 'value'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

type Finding = { level: 'warn' | 'err'; field: string; why: string; fix: string; path: string; value: string };

async function askClaude(material: unknown) {
  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), timeout: 120_000, maxRetries: 2 });
  // deno-lint-ignore no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    // 断られたときは Claude 側で別のモデルが引き継ぐ（server-side fallback・既定の振り分け）
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: '点検する会社の登録内容（JSON）:\n' + JSON.stringify(material, null, 1) }],
  };
  const res = await client.beta.messages.create(params);
  if (res.stop_reason === 'refusal') throw new Error('Claude が点検を断りました');
  if (res.stop_reason === 'max_tokens') throw new Error('点検の返事が途中で切れました');
  // deno-lint-ignore no-explicit-any
  const text = (res.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  let parsed: { findings?: Finding[] };
  try { parsed = JSON.parse(text); } catch { throw new Error('点検の返事が読めませんでした'); }
  const findings = (parsed.findings || []).slice(0, 8).map((f) => ({
    level: f.level === 'err' ? 'err' : 'warn', field: String(f.field || '').slice(0, 40),
    why: String(f.why || '').slice(0, 300), fix: String(f.fix || '').slice(0, 200),
    ...(FIXABLE[f.path] && String(f.value || '').trim() ? { path: f.path, value: String(f.value).trim().slice(0, 300) } : {}),
  }));
  return { findings, model: res.model || MODEL, usage: res.usage || {} };
}

function readable(e: unknown) {
  const s = e instanceof Error ? e.message : String(e);
  if (e instanceof Anthropic.RateLimitError) return 'Claude が混み合っています（しばらくしてもう一度）';
  if (e instanceof Anthropic.AuthenticationError) return 'Claude の鍵が通りません（Secrets の ANTHROPIC_API_KEY を確かめてください）';
  if (e instanceof Anthropic.APIError && Number(e.status ?? 0) >= 500) return 'Claude が応答しません（しばらくしてもう一度）';
  if (e instanceof Anthropic.APIConnectionError) return 'Claude に届きませんでした';
  if (/credit balance|billing/i.test(s)) return 'Claude API のクレジットが足りません';
  return s.slice(0, 280);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST のみ' }, 405);

  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
  let who = '';
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await sb.auth.getUser(jwt);
    const uid = u?.user?.id;
    if (!uid) return json({ error: 'ログインが必要です' }, 401);
    const { data: row } = await sb.from('user_roles').select('role').eq('user_id', uid).maybeSingle();
    if (row?.role !== 'admin' && row?.role !== 'accounting') {
      return json({ error: '取引先マスタの点検の権限がありません（admin/accounting のみ）' }, 403);
    }
    who = u?.user?.email || uid;
  } catch (e) {
    return json({ error: `認証に失敗しました: ${e instanceof Error ? e.message : String(e)}` }, 401);
  }

  let body: { action?: string; company_id?: string; trigger?: string };
  try { body = await req.json(); } catch { return json({ error: 'JSON body が必要です' }, 400); }
  if (!body.action || body.action === 'status') {
    return json({ version: FN_VERSION, model: MODEL, key: !!env('ANTHROPIC_API_KEY'), registry: !!env('NTA_APP_ID') });
  }
  if (body.action !== 'check') return json({ error: `未知の action: ${body.action}` }, 400);

  const cid = String(body.company_id || '').trim();
  if (!/^[0-9A-Za-z-]{1,8}$/.test(cid)) return json({ error: 'company_id が必要です' }, 400);
  const trigger = ['manual', 'retry'].includes(String(body.trigger)) ? String(body.trigger) : 'manual';

  const ins = await sb.from('company_ai_check').insert({ company_id: cid, trigger, requested_by: who, model: MODEL, status: 'running' })
    .select('id').single();
  if (ins.error) return json({ error: `点検の記録を作れませんでした: ${ins.error.message}` }, 500);
  const id = ins.data.id;

  const close = async (patch: Record<string, unknown>) => {
    const r = await sb.from('company_ai_check').update(patch).eq('id', id).select('*').single();
    return r.data || { id, ...patch };
  };

  try {
    if (!env('ANTHROPIC_API_KEY')) throw new Error('Claude の鍵が未設定です（Secrets の ANTHROPIC_API_KEY）');
    const m = await loadMaterial(sb, cid);
    const [registry, duplicateCandidates] = await Promise.all([fetchRegistry(m.company.corporate_number), findDuplicates(sb, m.company)]);
    const { updated_at, ...companyForAi } = m.company;
    const material = { ...m, company: companyForAi, registry, duplicateCandidates };
    const r = await askClaude(material);
    const rec = await close({
      status: 'done', findings: r.findings, model: r.model, company_updated_at: updated_at,
      input_tokens: r.usage.input_tokens ?? null, output_tokens: r.usage.output_tokens ?? null,
    });
    return json({ ok: true, check: rec });
  } catch (e) {
    const rec = await close({ status: 'error', error: readable(e) });
    return json({ ok: false, check: rec });
  }
});
