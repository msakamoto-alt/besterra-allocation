// 取引先マスタ 外部API取得 Edge Function（torihikisaki-enrich）
//
// 役割：会社情報の取得元（国税庁 法人番号Web-API / gBizINFO / Sansan Data Hub）をサーバー側で束ね、
//       画面（js/views/torihikisaki_enrich.js）へ正規化した1レコードを返す。
//       ブラウザから外部APIを直接呼べない（CORS）ため、この関数が唯一の経路になる。
//
// 🔴設計の鉄則：
//   1) APIキーはこの関数の Secrets にのみ置く。ブラウザへは絶対に返さない（status も真偽と理由だけ返す）。
//   2) 外部APIへは **読取のみ**。取得結果でDBを書き換えることはこの関数ではしない
//      （採用/却下は画面で人が決める＝経理の確定値を自動で上書きしないため）。
//   3) キー未設定でもエラーで落とさず、ok:false＋理由を返す。画面は手入力にフォールバックする。
//
// 認証：Supabase JWT（admin または accounting）。取引先マスタは経理管轄のため他ロールは拒否。
//
// アクション（POST body の action）：
//   status … 各プロバイダのキー設定状況を返す（キーそのものは返さない）
//   fetch  … provider と params を指定して1社分を取得
//            params: { corporateNumber?: "13桁", name?: "商号", soc?: "13桁" }
//   check_invoice … 🔴インボイス登録の**失効・取消を一括チェック**。params: { numbers: ["T…"] }（最大200件・内部で10件ずつ）
//   probe_gbiz … 🔴gBizINFO の疎通・実データ確認。params: { corporateNumber: "13桁", sample?: 0|1 }
//   probe_sansan_open … 🔴Sansan Open API（APIキー1本）の疎通・実データ確認。params: { name?: 会社名, sample?: 件数 }
//   probe_sansan … 🔴Data Hub（OAuth2）の疎通と実データの確認用（結線前の調査）。
//            認証が通るか／会社フィードが何件返るか／実際に来る項目名は何かを返す。
//            params: { days?: 日数(既定7), sample?: 返すサンプル件数(既定2・最大5) }
//            ※Change Feedは「差分」APIのため、単一社のピンポイント取得には向かない。
//              実運用は「定期同期でキャッシュ→キャッシュを引く」形にする（本アクションはその設計を固めるための下見）。
//
// 必要な Secrets（Edge Functions → Secrets。未設定のものは自動的に「未接続」になる）：
//   NTA_APP_ID                … 国税庁 法人番号Web-API のアプリケーションID（申請中・9月上旬見込み）
//   NTA_INVOICE_APP_ID        … 国税庁 インボイス公表システム Web-API のアプリケーションID（無償・要申請）
//   GBIZINFO_TOKEN            … gBizINFO のAPIトークン（即時発行・未申請）
//   SANSAN_API_KEY            … Sansan Open API（名刺管理・32桁）。会社情報は名刺に載っている分のみ
//   SANSAN_CLIENT_ID / SANSAN_CLIENT_SECRET / SANSAN_COMPANY_FEED_ID … Sansan Data Hub（担当者へ申請）
//   （SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は実行環境に自動注入される）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const env = (k: string) => (Deno.env.get(k) || '').trim();

// 🔴この関数の版。Secretsだけ更新して関数の再デプロイを忘れる事故が起きたため、
//   status で版と対応アクションを返し、呼び出し側が「古い版がデプロイされている」と気づけるようにする。
//   ※機能を足したらここも上げること。
const FN_VERSION = '2026-08-26.5';
const FN_ACTIONS = ['status', 'fetch', 'check_invoice', 'probe_gbiz', 'probe_sansan_open', 'probe_sansan'];

// ===== プロバイダ定義（キーの有無だけを外に見せる） =====
function providerStatus() {
  const nta = env('NTA_APP_ID');
  const gbiz = env('GBIZINFO_TOKEN');
  const openKey = env('SANSAN_API_KEY');
  const inv = env('NTA_INVOICE_APP_ID');
  const sansanOk = env('SANSAN_CLIENT_ID') && env('SANSAN_CLIENT_SECRET') && env('SANSAN_COMPANY_FEED_ID');
  return {
    kokuzei: { ok: !!nta, reason: nta ? '接続可' : 'NTA_APP_ID 未設定（アプリケーションID申請中）' },
    gbizinfo: { ok: !!gbiz, reason: gbiz ? '接続可' : 'GBIZINFO_TOKEN 未設定（即時発行・未申請）' },
    invoice: {
      ok: !!inv,
      reason: inv ? '接続可（登録の失効・取消チェック）'
        : 'NTA_INVOICE_APP_ID 未設定（発行届出→申請書提出→国税庁の審査。手数料は不要）',
    },
    sansan_open: {
      ok: !!openKey,
      reason: openKey ? '接続可（名刺経由・法人番号や資本金は取得不可）' : 'SANSAN_API_KEY 未設定',
    },
    sansan: {
      ok: !!sansanOk,
      reason: sansanOk ? '接続可' : 'SANSAN_CLIENT_ID/SECRET/COMPANY_FEED_ID 未設定（Sansan担当者へ申請中）',
    },
  };
}

// ===== Sansan Open API（名刺管理・APIキー1本） =====
// 認証: X-Sansan-Api-Key（32桁）／レート制限 10回/秒（429時は retry_after 秒待つ）
// 会社専用エンドポイントは無い。会社情報は名刺（BizCard）に載っている分だけ取れる。
// 仕様: https://docs.ap.sansan.com/ja/api/openapi/v3.1/index.html
const SANSAN_OPEN_BASE = 'https://api.sansan.com/v3.1';

async function sansanOpenGet(path: string) {
  const res = await fetch(`${SANSAN_OPEN_BASE}${path}`, {
    headers: { 'X-Sansan-Api-Key': env('SANSAN_API_KEY'), Accept: 'application/json' },
  });
  const text = await res.text();
  if (res.status === 429) {
    let wait = '不明';
    try { wait = String(JSON.parse(text).retry_after ?? '不明'); } catch { /* noop */ }
    throw new Error(`Sansan APIのレート制限（10回/秒）に達しました。${wait}秒後に再試行してください`);
  }
  if (!res.ok) throw new Error(`Sansan Open API HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text || '{}');
}

// 名刺を会社名で検索し、会社として共通性の高い情報だけを返す。
//
// 🔴住所は返さない（坂本さん判断 2026-08-26）:
//   名刺の住所は「その人の所属拠点の住所」であって本社住所ではない。枚数が多い＝本社の証拠にもならない
//   （営業拠点ほど名刺交換が多く、ベステラの取引は現場ごとに担当がつくため支店の名刺が集中しやすい）。
//   誤った本社住所は請求書の送付先・反社照合・与信判断を狂わせ、しかも「もっともらしい」ので気づけない。
//   → 本社住所（#25）は登記上の所在地が取れる 国税庁API / gBizINFO の担当とする。
//   ※名刺の拠点情報を #27「支店・拠点(複数)」へ活かす案は将来の検討事項（今は返さない）。
async function fetchSansanOpen(params: Record<string, string>) {
  const name = (params.name || '').trim();
  if (!name) throw new Error('会社名が必要です（Sansan Open API に法人番号での検索はありません）');
  const q = new URLSearchParams({ companyName: name, range: 'all', limit: '100' });
  const d = await sansanOpenGet(`/bizCards/search?${q}`);
  const cards: Record<string, unknown>[] = d.data || d.bizCards || [];
  if (!cards.length) return null;

  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
  const when = (c: Record<string, unknown>) =>
    s(c.updatedTime) || s(c.registeredTime) || s(c.exchangeDate);
  const newest = cards.slice().sort((a, b) => (when(a) > when(b) ? -1 : 1))[0];

  return {
    companyName: s(newest.companyName) || null,
    url: s(newest.url) || null,
    _companyId: s(newest.companyId) || null,   // SF突合キー（32桁）。保持する列が無いため参考情報
    _matched: cards.length,
  };
}

// Sansan Open API の疎通・実データ調査
async function probeSansanOpen(params: Record<string, unknown>) {
  const steps: string[] = [];
  // 1) 自分の情報でキーの有効性を確認（最も軽いエンドポイント）
  try {
    const me = await sansanOpenGet('/me');
    steps.push(`APIキー有効（ユーザー: ${me.name || me.email || 'ー'}）`);
  } catch (e) {
    return {
      ok: false, step: 'auth',
      message: 'APIキーが無効か、権限がありません',
      detail: e instanceof Error ? e.message : String(e),
      hint: 'SANSAN_API_KEY（32桁）を確認してください。前後の空白混入にも注意',
    };
  }
  // 2) 実際の会社名で検索してみる
  const name = String(params.name || '株式会社');
  let cards: Record<string, unknown>[] = [];
  try {
    const q = new URLSearchParams({ companyName: name, range: 'all', limit: '20' });
    const d = await sansanOpenGet(`/bizCards/search?${q}`);
    cards = d.data || d.bizCards || [];
    steps.push(`名刺検索OK（「${name}」で ${cards.length}件）`);
  } catch (e) {
    return {
      ok: false, step: 'search', steps,
      message: '名刺検索に失敗しました',
      detail: e instanceof Error ? e.message : String(e),
      hint: 'APIキーに名刺参照の権限があるか、range=all が許可されているか確認してください',
    };
  }
  // 3) 実データに来た項目名（値は返さない）
  const keyCount: Record<string, number> = {};
  cards.forEach((c) => Object.keys(c).forEach((k) => { keyCount[k] = (keyCount[k] || 0) + 1; }));
  const EXPECT = ['companyName', 'postalCode', 'address', 'prefecture', 'city', 'street', 'building', 'tel', 'fax', 'url', 'companyId'];
  const found = EXPECT.filter((k) => keyCount[k]);
  const missing = EXPECT.filter((k) => !keyCount[k]);
  const nSample = Math.min(Math.max(Number(params.sample ?? 0) || 0, 0), 3);
  return {
    ok: true, steps, records: cards.length,
    mapping: { expected: EXPECT.length, found: found.length, foundKeys: found, missingKeys: missing },
    keysSeen: Object.entries(keyCount).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`),
    samples: nSample ? cards.slice(0, nSample) : undefined,
  };
}

// ===== 国税庁 適格請求書発行事業者公表システム Web-API =====
// 🔴用途が他と違う: 値を埋めるのではなく **登録の失効・取消を見張る**。
// 仕様（公式PDF k-web-api-tetuduki.pdf で確認済み・推測ではない）:
//   valid … 登録番号＋基準日で直近の状態: /1/valid?id=&number=T…&day=YYYY-MM-DD&type=21(JSON)
//   num   … 登録番号を **1〜最大10件** まとめて: /1/num?id=&number=T…,T…&type=21&history=0
//   更新は1回/日（翌開庁日の午前6時）＝ 1日1回のバッチ照会で足りる。頻繁に叩く意味がない。
//   「利用が著しく集中した場合等には利用を制限することがある」（利用規約）→ 礼儀正しく叩く。
const NTA_INVOICE_BASE = 'https://web-api.invoice-kohyo.nta.go.jp/1';

// 事業者処理区分: 01=新規登録 / 02=更新 / 03=取消・失効
// 判定は「取消年月日・失効年月日が入っているか」を主に見る（区分だけに頼らない）
function invoiceJudge(rec: Record<string, unknown>) {
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
  const disposal = s(rec.disposalDate);
  const expire = s(rec.expireDate);
  const process = s(rec.process);
  if (disposal) return { state: 'revoked', label: '取消', on: disposal };
  if (expire) return { state: 'expired', label: '失効', on: expire };
  if (process === '03') return { state: 'revoked', label: '取消・失効', on: '' };
  return { state: 'valid', label: '有効', on: s(rec.registratedDate) };
}

// 登録番号を最大10件まとめて照会（1リクエスト＝最大10件は仕様上の上限）
async function ntaInvoiceNum(numbers: string[]) {
  const id = env('NTA_INVOICE_APP_ID');
  const list = numbers.slice(0, 10).join(',');
  const url = `${NTA_INVOICE_BASE}/num?id=${encodeURIComponent(id)}&number=${encodeURIComponent(list)}&type=21&history=0`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`国税庁インボイスAPI HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('応答をJSONとして読めませんでした: ' + text.slice(0, 200));
  }
}

// 1社分（画面の fetch から呼ばれる）
async function fetchInvoice(params: Record<string, string>) {
  const num = (params.invoiceNumber || params.registratedNumber || '').trim().toUpperCase();
  if (!/^T\d{13}$/.test(num)) throw new Error('登録番号は T＋13桁 で指定してください');
  const d = await ntaInvoiceNum([num]);
  const list = (d.announcement || d.announcements || []) as Record<string, unknown>[];
  const rec = Array.isArray(list) ? list[0] : null;
  if (!rec) return null;
  const j = invoiceJudge(rec);
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);
  return {
    registratedNumber: s(rec.registratedNumber),
    _state: j.state,
    _stateLabel: j.label,
    _stateOn: j.on,
    _name: s(rec.name),
    _address: s(rec.address),
    _process: s(rec.process),
  };
}

// 🔴一括の失効チェック（本命の使い方）。10件ずつ照会し、状態だけを返す。DBは書き換えない。
async function checkInvoiceBatch(params: Record<string, unknown>) {
  const raw = Array.isArray(params.numbers) ? params.numbers as string[] : [];
  const numbers = raw.map((n) => String(n).trim().toUpperCase()).filter((n) => /^T\d{13}$/.test(n));
  if (!numbers.length) return { ok: false, message: '登録番号（T+13桁）を numbers に指定してください' };
  if (numbers.length > 200) return { ok: false, message: '一度に照会できるのは200件までです（10件×20バッチ）' };

  const results: Record<string, unknown>[] = [];
  const errors: string[] = [];
  for (let i = 0; i < numbers.length; i += 10) {
    const chunk = numbers.slice(i, i + 10);
    try {
      const d = await ntaInvoiceNum(chunk);
      const list = (d.announcement || d.announcements || []) as Record<string, unknown>[];
      const byNum = new Map<string, Record<string, unknown>>();
      (Array.isArray(list) ? list : []).forEach((r) => {
        const n = String(r.registratedNumber || '').trim().toUpperCase();
        if (n) byNum.set(n, r);
      });
      for (const n of chunk) {
        const rec = byNum.get(n);
        if (!rec) {
          // 応答に無い＝公表対象外。取消済みでデータが落ちている場合もあるため「要確認」で返す
          results.push({ number: n, state: 'notfound', label: '公表データに無し' });
          continue;
        }
        const j = invoiceJudge(rec);
        results.push({
          number: n, state: j.state, label: j.label, on: j.on,
          name: String(rec.name || ''), address: String(rec.address || ''),
        });
      }
    } catch (e) {
      errors.push(`${chunk[0]}〜: ${e instanceof Error ? e.message : String(e)}`);
      chunk.forEach((n) => results.push({ number: n, state: 'error', label: '照会失敗' }));
    }
    if (i + 10 < numbers.length) await new Promise((r) => setTimeout(r, 300));
  }
  const tally: Record<string, number> = {};
  results.forEach((r) => { const k = String(r.state); tally[k] = (tally[k] || 0) + 1; });
  return { ok: true, checked: results.length, tally, results, errors };
}

// ===== 国税庁 法人番号Web-API =====
// 仕様: GET https://api.houjin-bangou.nta.go.jp/4/num?id={appId}&number={13桁}&type=12（JSON）
//       商号検索は /4/name。1リクエスト10件・1日あたりの上限あり（レート制限は要確認）。
async function fetchKokuzei(params: Record<string, string>) {
  const id = env('NTA_APP_ID');
  const num = (params.corporateNumber || '').replace(/\D/g, '');
  if (!/^\d{13}$/.test(num)) throw new Error('法人番号13桁が必要です');
  const url = `https://api.houjin-bangou.nta.go.jp/4/num?id=${encodeURIComponent(id)}&number=${num}&type=12`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`国税庁API HTTP ${res.status}`);
  const d = await res.json();
  const c = (d.corporations || d.corporation || [])[0];
  if (!c) return null;
  // 画面側 TM_ENRICH.PROVIDERS.kokuzei.map のキーに合わせて正規化する
  return {
    corporateNumber: c.corporateNumber ?? null,
    name: c.name ?? null,
    furigana: c.furigana ?? null,
    postCode: c.postCode ?? null,
    address: [c.prefectureName, c.cityName, c.streetNumber].filter(Boolean).join('') || null,
    registeredAddress: [c.prefectureName, c.cityName, c.streetNumber].filter(Boolean).join('') || null,
    // kind=法人種別コード（101=国の機関/301=株式会社 等）。画面では「法人/個人区分」に入る想定
    kind: c.kind ?? null,
    addressOutside: c.addressOutside || null,
    // 参考（マッピング対象外だが raw で残す）
    closeDate: c.closeDate ?? null,
    successorCorporateNumber: c.successorCorporateNumber ?? null,
  };
}

// ===== gBizINFO（経済産業省・法人情報） =====
// 仕様: GET https://info.gbiz.go.jp/hojin/v1/hojin/{法人番号13桁}  ヘッダ X-hojinInfo-api-token
// 🔴フィールド名は公式クライアントの HojinInfo モデル定義で確認済み（推測ではない・2026-08-26）。
//   本社住所(location)は登記情報が元なので、名刺の拠点住所と違い #25「本社住所」に入れてよい。
async function fetchGbiz(params: Record<string, string>) {
  const token = env('GBIZINFO_TOKEN');
  const num = (params.corporateNumber || '').replace(/\D/g, '');
  if (!/^\d{13}$/.test(num)) throw new Error('法人番号13桁が必要です');
  const res = await fetch(`https://info.gbiz.go.jp/hojin/v1/hojin/${num}`, {
    headers: { 'X-hojinInfo-api-token': token, Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gBizINFO HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  const c = (d['hojin-infos'] || [])[0];
  if (!c) return null;
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);
  // 許認可は別エンドポイント。基本情報に入っていなければ取りに行く
  const cert = c.certification ?? await fetchGbizCertification(num);
  return {
    corporate_number: s(c.corporate_number),
    name: s(c.name),
    kana: s(c.kana),
    postal_code: s(c.postal_code),
    location: s(c.location),
    representative_name: s(c.representative_name),
    capital_stock: c.capital_stock ?? null,
    employee_number: c.employee_number ?? null,
    date_of_establishment: s(c.date_of_establishment),
    business_summary: s(c.business_summary),
    company_url: s(c.company_url),
    // 参考（マッピング未割当・構造を実データで確認してから使う）
    _certification: cert,
    _business_items: c.business_items ?? null,
    _status: s(c.status),
    _close_date: s(c.close_date),
  };
}

// 🔴届出・認定情報（建設業許可を含む）は **基本情報とは別エンドポイント**（2026-08-26 実データで判明）。
//   GET /v1/hojin/{法人番号}/certification
//   基本情報の certification は空で返るため、必要ならこちらを叩く。
//   許可が無い会社では 404/空が正常なので、失敗しても基本情報の取得は止めない。
async function fetchGbizCertification(num: string) {
  try {
    const res = await fetch(`https://info.gbiz.go.jp/hojin/v1/hojin/${num}/certification`, {
      headers: { 'X-hojinInfo-api-token': env('GBIZINFO_TOKEN'), Accept: 'application/json' },
    });
    if (!res.ok) return null;                       // 404=許認可の登録なし。エラー扱いにしない
    const d = await res.json();
    const c = (d['hojin-infos'] || [])[0];
    return c?.certification ?? null;
  } catch {
    return null;                                    // 許認可が取れなくても本体は返す
  }
}

// gBizINFO の疎通・実データ調査（結線前の下見）
async function probeGbiz(params: Record<string, unknown>) {
  const num = String(params.corporateNumber || '').replace(/\D/g, '');
  if (!/^\d{13}$/.test(num)) {
    return { ok: false, step: 'params', message: '法人番号13桁を指定してください（params.corporateNumber）' };
  }
  const res = await fetch(`https://info.gbiz.go.jp/hojin/v1/hojin/${num}`, {
    headers: { 'X-hojinInfo-api-token': env('GBIZINFO_TOKEN'), Accept: 'application/json' },
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false, step: 'auth', message: `認証に失敗しました（HTTP ${res.status}）`,
      detail: text.slice(0, 300), hint: 'GBIZINFO_TOKEN を確認してください',
    };
  }
  if (!res.ok) {
    return { ok: false, step: 'fetch', message: `取得に失敗しました（HTTP ${res.status}）`, detail: text.slice(0, 300) };
  }
  const d = JSON.parse(text || '{}');
  const list = d['hojin-infos'] || [];
  if (!list.length) {
    return { ok: true, steps: ['認証OK'], records: 0, message: 'この法人番号では見つかりませんでした' };
  }
  const c = list[0] as Record<string, unknown>;
  // 画面のマッピングが実データに存在するか
  const EXPECT = ['corporate_number', 'name', 'kana', 'postal_code', 'location', 'representative_name',
    'capital_stock', 'employee_number', 'date_of_establishment', 'business_summary', 'company_url'];
  const has = (k: string) => c[k] !== undefined && c[k] !== null && String(c[k]).trim() !== '';
  const nSample = Math.min(Math.max(Number(params.sample ?? 0) || 0, 0), 1);
  return {
    ok: true,
    steps: [`認証OK`, `法人番号 ${num} で1件取得`],
    records: list.length,
    mapping: {
      expected: EXPECT.length,
      found: EXPECT.filter(has).length,
      foundKeys: EXPECT.filter(has),
      missingKeys: EXPECT.filter((k) => !has(k)),   // 値が空なだけの場合も含む
    },
    keysSeen: Object.keys(c).map((k) => {
      const v = c[k];
      const t = v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v;
      return `${k} : ${t}`;
    }),
    // 許認可の構造は実データを見てから #88 への割当を決める（別エンドポイントも確認する）
    certificationShape: await (async () => {
      const cert = c.certification ?? await fetchGbizCertification(num);
      return cert ? JSON.stringify(cert).slice(0, 1200)
                  : '（基本情報・certificationエンドポイントとも空＝この会社は許認可の登録なし）';
    })(),
    samples: nSample ? [c] : undefined,
  };
}

// ===== Sansan Data Hub =====
// 認証: POST https://account.datahub.sansan.com/connect/token（client_credentials）
// 取得: GET https://api.datahub.sansan.com/change-feed/v1/{feedId}/updated?start=&end=（ND-JSON）
//       ※Change Feedは「差分」APIのため、単一社のピンポイント取得には向かない。
//         当面は取得済みキャッシュからの検索を想定し、ここでは疎通と1社抽出のみ実装する。
async function fetchSansan(params: Record<string, string>) {
  const id = env('SANSAN_CLIENT_ID'), secret = env('SANSAN_CLIENT_SECRET'), feed = env('SANSAN_COMPANY_FEED_ID');
  const tokenRes = await fetch('https://account.datahub.sansan.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!tokenRes.ok) throw new Error(`Sansan 認証 HTTP ${tokenRes.status}`);
  const token = (await tokenRes.json()).access_token;
  // 直近30日の差分から該当社を拾う（実運用では定期取込したキャッシュを引く設計に切り替える）
  const end = new Date();
  const startD = new Date(end.getTime() - 30 * 86400000);
  const url = `https://api.datahub.sansan.com/change-feed/v1/${encodeURIComponent(feed)}/updated`
    + `?start=${startD.toISOString()}&end=${end.toISOString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/ldjson' } });
  if (!res.ok) throw new Error(`Sansan ChangeFeed HTTP ${res.status}`);
  const text = await res.text();
  const want = (params.soc || '').trim();
  const wantNum = (params.corporateNumber || '').replace(/\D/g, '');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line); } catch { continue; }
    const soc = String((rec as { soc?: unknown }).soc ?? '');
    const cn = String(((rec as { nta?: { corporateNumber?: unknown } }).nta?.corporateNumber) ?? '');
    if ((want && soc === want) || (wantNum && cn === wantNum)) return rec;
  }
  return null;
}

// ===== Sansan 疎通・実データ調査（結線前の下見） =====
// 返すのは「認証できたか」「何件来たか」「どんな項目名が来たか」。
// 🔴サンプル値は実データなので、既定では項目名と型だけを返し、値は sample 指定時のみ最小件数だけ返す。
async function probeSansan(params: Record<string, unknown>) {
  const id = env('SANSAN_CLIENT_ID'), secret = env('SANSAN_CLIENT_SECRET'), feed = env('SANSAN_COMPANY_FEED_ID');
  const steps: string[] = [];

  // 1) 認証
  const t0 = Date.now();
  const tokenRes = await fetch('https://account.datahub.sansan.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  const tokenBody = await tokenRes.text();
  if (!tokenRes.ok) {
    return {
      ok: false, step: 'token',
      message: `認証に失敗しました（HTTP ${tokenRes.status}）`,
      detail: tokenBody.slice(0, 300),
      hint: 'SANSAN_CLIENT_ID / SANSAN_CLIENT_SECRET を確認してください',
    };
  }
  const token = JSON.parse(tokenBody).access_token;
  steps.push(`認証OK（${Date.now() - t0}ms）`);

  // 2) 会社フィード取得（差分・期間指定）
  const days = Math.min(Math.max(Number(params.days ?? 7) || 7, 1), 90);
  const end = new Date();
  const startD = new Date(end.getTime() - days * 86400000);
  const url = `https://api.datahub.sansan.com/change-feed/v1/${encodeURIComponent(feed)}/updated`
    + `?start=${startD.toISOString()}&end=${end.toISOString()}`;
  const t1 = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/ldjson' } });
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false, step: 'feed', steps,
      message: `会社フィードの取得に失敗しました（HTTP ${res.status}）`,
      detail: text.slice(0, 300),
      hint: 'SANSAN_COMPANY_FEED_ID が「会社」フィードのIDか確認してください（拠点/人物/名刺と取り違えやすい）',
    };
  }
  const lines = text.split('\n').filter((l) => l.trim());
  steps.push(`フィード取得OK（${days}日分・${lines.length}行・${Date.now() - t1}ms）`);

  // 3) 実際に来た項目名を洗い出す（ネストは 'a.b' 形式で平坦化）
  const flatKeys = (o: unknown, prefix = ''): string[] => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return prefix ? [prefix] : [];
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => {
      const p = prefix ? `${prefix}.${k}` : k;
      return (v && typeof v === 'object' && !Array.isArray(v)) ? flatKeys(v, p) : [p];
    });
  };
  const keyCount: Record<string, number> = {};
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      parsed.push(rec);
      flatKeys(rec).forEach((k) => { keyCount[k] = (keyCount[k] || 0) + 1; });
    } catch { /* 壊れた行は無視 */ }
  }

  // 4) 画面のマッピングが実データに存在するか（ここが今回の眼目）
  const EXPECT = [
    'soc', 'nta.corporateNumber', 'ss.company_name_kanji', 'ss.company_name_kana',
    'ss.postal_code', 'ss.location', 'ss.phone_number', 'ss.legal_capital',
    'ss.employee_number', 'ss.created_year', 'ss.listed_type',
    'ss.latest_sales_term_sales', 'ss.representative_name',
    'ss.main_major_industrial_class', 'ntaInvoice.registratedNumber',
  ];
  const found = EXPECT.filter((k) => keyCount[k]);
  const missing = EXPECT.filter((k) => !keyCount[k]);

  const nSample = Math.min(Math.max(Number(params.sample ?? 0) || 0, 0), 5);
  return {
    ok: true,
    steps,
    records: lines.length,
    days,
    mapping: {
      expected: EXPECT.length,
      found: found.length,
      foundKeys: found,
      missingKeys: missing,           // ここが空でなければ画面のマッピングを直す必要がある
    },
    // 実データに来た全項目名と出現件数（値は含めない）
    keysSeen: Object.entries(keyCount).sort((a, b) => b[1] - a[1]).slice(0, 120)
      .map(([k, n]) => `${k} (${n})`),
    samples: nSample ? parsed.slice(0, nSample) : undefined,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST のみ' }, 405);

  // ===== 認証：admin または accounting のみ（取引先マスタは経理管轄） =====
  try {
    const auth = req.headers.get('Authorization') || '';
    const jwt = auth.replace(/^Bearer\s+/i, '');
    const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const { data: u } = await sb.auth.getUser(jwt);
    const uid = u?.user?.id;
    if (!uid) return json({ error: 'ログインが必要です' }, 401);
    const { data: row } = await sb.from('user_roles').select('role').eq('user_id', uid).maybeSingle();
    const role = row?.role;
    if (role !== 'admin' && role !== 'accounting') {
      return json({ error: '取引先マスタの取得権限がありません（admin/accounting のみ）' }, 403);
    }
  } catch (e) {
    return json({ error: `認証に失敗しました: ${e instanceof Error ? e.message : String(e)}` }, 401);
  }

  let body: { action?: string; provider?: string; params?: Record<string, string> & { days?: number; sample?: number } };
  try { body = await req.json(); } catch { return json({ error: 'JSON body が必要です' }, 400); }

  const status = providerStatus();
  if (!body.action || body.action === 'status') return json({ version: FN_VERSION, actions: FN_ACTIONS, providers: status });

  if (body.action === 'check_invoice') {
    if (!status.invoice.ok) return json({ ok: false, step: 'secrets', message: status.invoice.reason }, 200);
    try {
      return json(await checkInvoiceBatch(body.params || {}));
    } catch (e) {
      return json({ ok: false, step: 'exception', message: e instanceof Error ? e.message : String(e) }, 200);
    }
  }

  if (body.action === 'probe_gbiz') {
    if (!status.gbizinfo.ok) return json({ ok: false, step: 'secrets', message: status.gbizinfo.reason }, 200);
    try {
      return json(await probeGbiz(body.params || {}));
    } catch (e) {
      return json({ ok: false, step: 'exception', message: e instanceof Error ? e.message : String(e) }, 200);
    }
  }

  if (body.action === 'probe_sansan_open') {
    if (!status.sansan_open.ok) return json({ ok: false, step: 'secrets', message: status.sansan_open.reason }, 200);
    try {
      return json(await probeSansanOpen(body.params || {}));
    } catch (e) {
      return json({ ok: false, step: 'exception', message: e instanceof Error ? e.message : String(e) }, 200);
    }
  }

  if (body.action === 'probe_sansan') {
    if (!status.sansan.ok) return json({ ok: false, step: 'secrets', message: status.sansan.reason }, 200);
    try {
      return json(await probeSansan(body.params || {}));
    } catch (e) {
      return json({ ok: false, step: 'exception', message: e instanceof Error ? e.message : String(e) }, 200);
    }
  }

  if (body.action === 'fetch') {
    const p = body.provider || '';
    const st = (status as Record<string, { ok: boolean; reason: string }>)[p];
    if (!st) return json({ error: `未知の取得元: ${p}` }, 400);
    if (!st.ok) return json({ error: st.reason }, 200);   // キー未設定は「エラー」ではなく理由を返す
    try {
      const params = body.params || {};
      const record = p === 'invoice' ? await fetchInvoice(params)
        : p === 'kokuzei' ? await fetchKokuzei(params)
        : p === 'gbizinfo' ? await fetchGbiz(params)
        : p === 'sansan_open' ? await fetchSansanOpen(params)
        : await fetchSansan(params);
      return json({ record: record ?? null });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 200);
    }
  }

  return json({ error: `未知の action: ${body.action}`, version: FN_VERSION, actions: FN_ACTIONS,
    hint: 'デプロイされている関数が古い可能性があります。supabase/functions/torihikisaki-enrich/index.ts を貼り直してください' }, 400);
});
