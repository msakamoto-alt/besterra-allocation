// 銀行マスタ（bank_master.sql）と、tera の取込ファイルの読み書き（js/views/torihikisaki_bank_csv.js）を、手元の PostgreSQL（PGlite）で通す
// 使い方: node bank_master.test.mjs [tera の取込用 CSV] [口座の写し JSON] [廃止にする店の JSON]      → 最後に ALL OK
//   引数なし            = 中に持っている 12 行の見本だけで通す（どこでも動く）
//   CSV を渡す          = 全行を入れて、書き出したものが元の CSV と 1 バイトも違わないことまで見る
//   口座の写しも渡す    = 本番の口座（コードだけの写し）で、口座の点検と入力の点検が同じ答えになることを見る
//   廃止にする店も渡す  = その店に廃止の印を付けたときの数を出す
//   CSV・写しは本番や経理の資料から取ったもの＝ git に入れない
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [CSV, ACCOUNTS, ABOLISH] = process.argv.slice(2);
const ddl = fs.readFileSync(path.join(HERE, '..', 'torihikisaki_prod', 'prod_01_schema_rls.sql'), 'utf8');
const extractTable = (name) => ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`, 'i'))[0];
const sql = fs.readFileSync(path.join(HERE, '..', 'bank_master.sql'), 'utf8');
// 画面の部品（<script> で読む形）をそのまま読んで使う
const Csv = new Function(fs.readFileSync(path.join(HERE, '..', '..', 'js', 'views', 'torihikisaki_bank_csv.js'), 'utf8') + '\nreturn TorihikisakiBankCsv;')();

let fails = 0;
const show = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x));
const ok = (label, cond, info) => { console.log((cond ? 'OK   ' : 'FAIL ') + label + (info !== undefined ? '  ' + show(info) : '')); if (!cond) fails++; };
const info = (label, v) => console.log('     ' + label + '  ' + show(v));

async function newDb() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated;
    create function app_role() returns text language sql stable as $$ select current_setting('test.role', true) $$;`);
  await pg.exec(['company', 'bank_account'].map(extractTable).join('\n'));
  await pg.exec('grant all on company, bank_account to authenticated; grant usage, select on all sequences in schema public to authenticated;');
  return pg;
}
const STAGE_COLS = ['bank_code', 'branch_code', 'bank_name', 'bank_kana', 'branch_name', 'branch_kana', 'postal_code', 'address', 'phone', 'clearing_no'];
function tools(pg) {
  const one = async (q, p) => (await pg.query(q, p)).rows[0];
  const all = async (q, p) => (await pg.query(q, p)).rows;
  const err = async (q, p) => { try { await pg.query(q, p); return null; } catch (e) { return e.message; } };
  const as = async (role, appRole, fn) => {
    await pg.exec(`set test.role = '${appRole}'; set role ${role}`);
    try { return await fn(); } finally { await pg.exec('reset role; reset test.role'); }
  };
  const newRun = async (mode, asOf, source = 'csv') => (await one(
    `insert into bank_master_run(source, file_name, as_of, mode, actor) values ($1, '試験.csv', $2::text::date, $3, '試験 太郎') returning run_id::int`,
    [source, asOf, mode])).run_id;
  const stage = async (run, rows) => {
    for (let i = 0; i < rows.length; i += 1000) {
      const params = [];
      const tuples = rows.slice(i, i + 1000).map(r => {
        params.push(run); const ph = ['$' + params.length];
        STAGE_COLS.forEach(c => { params.push(r[c] === undefined || r[c] === '' ? null : r[c]); ph.push('$' + params.length); });
        return '(' + ph.join(',') + ')';
      });
      await pg.query(`insert into bank_master_stage(run_id, ${STAGE_COLS.join(',')}) values ${tuples.join(',')}`, params);
    }
  };
  const preview = async (run) => (await one('select bank_master_preview($1) as j', [run])).j;
  const apply = async (run, allow = false) => (await one('select bank_master_apply($1, $2) as j', [run, allow])).j;
  const state = async () => (await one('select bank_master_state() as j')).j;
  const count = async (t, where = 'true') => (await one(`select count(*)::int n from ${t} where ${where}`)).n;
  return { one, all, err, as, newRun, stage, preview, apply, state, count };
}

// ---- 見本の 12 行（銀行コード・店コード・名前は公開のもの。所在地と電話は試験の値）
const S = (a) => ({ bank_code: a[0], branch_code: a[1], bank_kana: a[2], bank_name: a[3], branch_kana: a[4], branch_name: a[5],
  postal_code: a[6] || null, address: a[7] || null, phone: a[8] || null, clearing_no: a[9] || null });
const SAMPLE = [
  ['0001', '004', 'ﾐｽﾞﾎ', 'みずほ銀行', 'ﾏﾙﾉｳﾁﾁﾕｳｵｳ', '丸の内中央', '100-0005', '東京都千代田区（試験）１－１', '03-0000-0004', '1301'],
  ['0001', '005', 'ﾐｽﾞﾎ', 'みずほ銀行', 'ﾏﾙﾉｳﾁ', '丸之内', '100-0005', '東京都千代田区（試験）１－２', '03-0000-0005', '1301'],
  ['0001', '009', 'ﾐｽﾞﾎ', 'みずほ銀行', 'ｶﾝﾀﾞｴｷﾏｴ', '神田駅前', '101-0044', '東京都千代田区（試験）２－１', '03-0000-0009', '1301'],
  ['0001', '108', 'ﾐｽﾞﾎ', 'みずほ銀行', 'ｶﾝﾀﾞ', '神田', '101-0047', '東京都千代田区（試験）２－２', '03-0000-0108', '1301'],
  ['0005', '002', 'ﾐﾂﾋﾞｼﾕ-ｴﾌｼﾞｴｲ', '三菱ＵＦＪ銀行', 'ﾏﾙﾉｳﾁ', '丸の内', '100-0005', '東京都千代田区（試験）３－１', '03-0000-0002', '1301'],
  ['0038', '506', 'ﾄﾞｺﾓSMTBﾈﾂﾄ', 'ドコモＳＭＴＢネット銀行', 'ﾕﾒ', 'ゆめ', '', '', '', ''],
  ['0544', '001', 'ﾁﾕｳｷﾖｳ', '中京銀行', 'ﾎﾝﾃﾝ', '本店', '460-0008', '愛知県名古屋市（試験）１', '052-000-0001', '2101'],
  ['0544', '002', 'ﾁﾕｳｷﾖｳ', '中京銀行', 'ｵｵｿﾞﾈ', '大曽根', '462-0825', '愛知県名古屋市（試験）２', '052-000-0002', '2101'],
  ['1242', '014', 'ﾕｳｷｼﾝｷﾝ', '結城信用金庫', 'ﾊｸﾞﾛ', '羽黒', '309-1453', '茨城県桜川市（試験）１', '0296-00-0014', ''],
  ['1688', '011', 'ｱﾏｶﾞｻｷｼﾝｷﾝ', '尼崎信用金庫', 'ﾁﾕｳｵｳ', '中央支店', '660-0000', '兵庫県尼崎市（試験）１', '06-0000-0011', ''],
  ['2681', '011', 'ﾋﾛｼﾏｹﾝｼﾝｸﾐ', '広島県信用組合', 'ｶﾝｵﾝ', '観音支店', '733-0000', '広島県広島市（試験）１', '082-000-0011', ''],
  ['9999', '999', 'ﾀﾞﾐ-ﾄｳﾛｸﾖｳ', 'ダミー登録用銀行', 'ﾀﾞﾐ-', 'ダミー', '', '', '', ''],
].map(S);
const codeOnly = (r, extra = {}) => Object.assign({ bank_code: r.bank_code, branch_code: r.branch_code }, extra);

// ======================================================================
// 1. tera の取込ファイルの読み書き（DB なし）
// ======================================================================
{
  const built = Csv.build(SAMPLE.slice().reverse());
  const text = new TextDecoder('shift_jis').decode(built.bytes);
  ok('書き出し: Shift_JIS・CRLF・全項目を " で囲む・12 列・コードの順（逆順で渡しても）',
    built.bad.length === 0 && text.endsWith('","1","1"\r\n') && text.split('\r\n').length === SAMPLE.length + 1 && !/[^\r]\n/.test(text)
    && text.startsWith('"0001","004","ﾐｽﾞﾎ","みずほ銀行","ﾏﾙﾉｳﾁﾁﾕｳｵｳ","丸の内中央","100-0005",')
    && text.split('\r\n')[5] === '"0038","506","ﾄﾞｺﾓSMTBﾈﾂﾄ","ドコモＳＭＴＢネット銀行","ﾕﾒ","ゆめ","","","","","1","1"',
    { bytes: built.bytes.length });
  const back = Csv.parse(built.bytes);
  ok('読み込み: 書き出したものを読むと同じ行に戻る', back.errorCount === 0 && show(back.rows) === show(SAMPLE), { rows: back.rows.length });
  ok('空の一覧を書き出すと 0 バイト', Csv.build([]).bytes.length === 0);

  const s1 = '神田ｶﾝﾀﾞ髙①㈱～－';
  const e1 = Csv.encode(s1);
  ok('Shift_JIS へ書く: 漢字・半角カナ・IBM 拡張（髙＝FBFC）・NEC 特殊文字',
    e1.bad.length === 0 && e1.bytes.length === 18 && new TextDecoder('shift_jis').decode(e1.bytes) === s1 && e1.bytes[8] === 0xfb && e1.bytes[9] === 0xfc,
    Buffer.from(e1.bytes).toString('hex'));
  const e2 = Csv.encode('神〜田−');
  ok('Shift_JIS に無い字は黙って ? にせず、書けない字として返す', e2.bad.length === 2 && e2.bad[0] === '〜' && e2.bad[1] === '−' && e2.bytes.length === 4, e2.bad);

  const enc = (s) => Csv.encode(s).bytes;
  const line = (a) => a.map(v => '"' + v + '"').join(',') + '\r\n';
  const good = ['0001', '108', 'ﾐｽﾞﾎ', 'みずほ銀行', 'ｶﾝﾀﾞ', '神田', '', '', '', '', '1', '1'];
  const with_ = (i, v) => { const a = good.slice(); a[i] = v; return a; };
  const msg = (r) => (r.errors[0] || {}).message || '';
  const p1 = Csv.parse(Uint8Array.of(0xef, 0xbb, 0xbf, 0x22, 0x31, 0x22));
  const p2 = Csv.parse(enc(line(with_(0, '1'))));
  const p3 = Csv.parse(enc(line(with_(4, 'カンダ'))));
  const p4 = Csv.parse(enc(line(good.slice(0, 11))));
  const p5 = Csv.parse(enc(line(good) + line(good)));
  const p6 = Csv.parse(enc(line(good) + line(with_(1, '109').map((v, i) => (i === 3 ? 'みずほ' : v)))));
  const p7 = Csv.parse(enc(line(with_(5, 'あ'.repeat(31)))));
  const p8 = Csv.parse(enc(line(with_(5, ''))));
  const p9 = Csv.parse(new TextEncoder().encode('"0001","108","ミズホ","みずほ銀行"\r\n'));
  ok('読み込みで止める: UTF-8 の CSV', p1.rows.length === 0 && msg(p1).includes('UTF-8'), msg(p1));
  ok('読み込みで止める: 先頭の 0 が落ちたコード', p2.rows.length === 0 && p2.errors[0].line === 1 && msg(p2).includes('4 桁の数字ではありません'), msg(p2));
  ok('読み込みで止める: カナが全角', p3.rows.length === 0 && msg(p3).includes('半角でない字'), msg(p3));
  ok('読み込みで止める: 列の数が違う', p4.rows.length === 0 && msg(p4).includes('列の数が 12 ではありません（11 列）'), msg(p4));
  ok('読み込みで止める: 同じ店が 2 行', p5.rows.length === 0 && p5.errors[0].line === 2 && msg(p5).includes('0001-108 が 2 行あります'), msg(p5));
  ok('読み込みで止める: 同じ銀行コードに銀行名が 2 通り', p6.rows.length === 0 && p6.errors[0].line === 2 && msg(p6).includes('前の行と違います'), msg(p6));
  ok('読み込みで止める: tera の桁を超える', p7.rows.length === 0 && msg(p7).includes('tera の 30 桁を超えています'), msg(p7).slice(0, 30));
  ok('読み込みで止める: 店の名前が空', p8.rows.length === 0 && msg(p8).includes('店舗名称が空です'), msg(p8));
  ok('読み込みで止める: Shift_JIS でない', p9.rows.length === 0 && p9.errorCount >= 1, msg(p9));
  const loose = Csv.parse(enc('0001,108,ﾐｽﾞﾎ,みずほ銀行,ｶﾝﾀﾞ,神田,,,,,1,1\n"0001","009","ﾐｽﾞﾎ","みずほ銀行","ｶﾝﾀﾞｴｷﾏｴ","神田駅前","","","","","1","1"'));
  ok('読み込み: " で囲んでいない行・LF・末尾の改行なしでも読める', loose.errorCount === 0 && loose.rows.length === 2 && loose.rows[0].branch_name === '神田' && loose.rows[0].address === null, loose.rows.length);

  // ---- 探す言葉の整え・DB の口とやり取りする形
  const kn = ['しこくちゅうおう', 'ちばこーぎー', 'チバコーギー', 'ﾁﾊﾞｺｰｷﾞｰ', 'ヴぃっせる', 'ｎｔｔどこも', 'ぱーぷる・たうん', '神田'].map(x => Csv.kana(x));
  ok('カナの整え: ひらがな・全角カナ・半角カナのどれも、tera の書き方の半角カナになる（小さいカナは大きく・長音は「-」・英字は大文字）',
    show(kn) === show(['ｼｺｸﾁﾕｳｵｳ', 'ﾁﾊﾞｺ-ｷﾞ-', 'ﾁﾊﾞｺ-ｷﾞ-', 'ﾁﾊﾞｺ-ｷﾞ-', 'ｳﾞｲﾂｾﾙ', 'NTTﾄﾞｺﾓ', 'ﾊﾟ-ﾌﾟﾙ・ﾀｳﾝ', '神田']), kn);
  const st = Csv.searchTerms('  みずほ　まるのうち ');
  const st2 = Csv.searchTerms('神田 ｓｍｔｂ 108 ０００１ 0001－108 ｶﾝﾀﾞ 七つ目');
  ok('探す言葉: 空白（全角も）で区切る・名前の形とカナの形・漢字の言葉にカナの形は付けない・6 つまで',
    show(st) === show([{ t: 'みずほ', k: 'ﾐｽﾞﾎ', c: '' }, { t: 'まるのうち', k: 'ﾏﾙﾉｳﾁ', c: '' }])
    && st2.length === 6 && st2[0].t === '神田' && st2[0].k === '' && st2[1].t === 'SMTB' && st2[1].k === 'SMTB'
    && st2[2].c === '108' && st2[3].c === '0001' && st2[3].t === '0001' && st2[4].c === '0001-108' && st2[5].k === 'ｶﾝﾀﾞ' && st2[5].c === '', st2);
  ok('探す言葉: 空なら 0 個', Csv.searchTerms('').length === 0 && Csv.searchTerms('　 ').length === 0 && Csv.searchTerms(null).length === 0);
  const arr = Csv.toArray(SAMPLE[5]);
  ok('DB の口とやり取りする形: 10 項目の配列（空は空文字）⇄ 行', arr.length === 10 && arr[0] === '0038' && arr[3] === 'ドコモＳＭＴＢネット銀行' && arr[6] === '' && arr[9] === ''
    && Csv.fromArray(arr).branch_name === 'ゆめ' && Csv.fromArray(arr).address === '' && Object.keys(Csv.fromArray(arr)).length === 10, arr);
  const dn = ['tera取込用_金融機関店舗マスタ_261124_v3_廃止なし.csv', '金融機関_20261207.csv', 'bank_v3.csv', '一覧_261324.csv', 'x_1234567_y.csv'].map(x => Csv.dateFromName(x));
  ok('ファイル名から基準日: 6 桁（年の下 2 桁）と 8 桁を読む・日付にならないものは空', show(dn) === show(['2026-11-24', '2026-12-07', '', '', '']), dn);
}

// ======================================================================
// 2. 銀行マスタの SQL（見本の 12 行）
// ======================================================================
{
  const pg = await newDb();
  const T = tools(pg);
  const run = async () => { const r = await pg.exec(sql); return r[r.length - 1].rows[0]; };
  const r1 = await run(), r2 = await run();
  ok('結果の 1 行', r1.prod_form === true && Number(r1.tables_5) === 5 && Number(r1.views_2) === 2 && Number(r1.policies_14) === 14 && Number(r1.triggers_2) === 2
    && Number(r1.functions_15) === 15 && Number(r1.banks) === 0 && Number(r1.branches) === 0, r1);
  ok('2 回流しても同じ結果', show(r1) === show(r2));
  // 方針は役割を (select app_role()) で引く＝ 1 つの文につき 1 回。行ごとに引く形に戻ると、本番（役割は表を引く関数）で 3 万行の取込が数倍遅くなる
  const pol = await T.one(`select count(*)::int as n,
      count(*) filter (where (qual is null or qual ~* 'select\\s+app_role\\(\\)') and (with_check is null or with_check ~* 'select\\s+app_role\\(\\)'))::int as once
    from pg_policies where schemaname = 'public' and tablename in ('bank', 'bank_branch', 'bank_master_run', 'bank_master_stage', 'bank_master_log')`);
  ok('方針 14 本とも、役割は 1 つの文につき 1 回だけ引く形', pol.n === 14 && pol.once === 14, pol);
  const today = (await T.one(`select (now() at time zone 'Asia/Tokyo')::date::text d`)).d;

  // ---- 銀行マスタが空のあいだ: 口座は今までどおり
  await pg.exec(`insert into company(company_id, official_name, is_suspended) values ('90001', '試験 有効 株式会社', false), ('90002', '試験 停止 株式会社', true)`);
  const insAcc = (cid, pr, name, bank, branch) => T.err(
    `insert into bank_account(company_id, priority, bank_name, bank_code, branch_code, account_type, account_number) values ($1, $2, $3, $4, $5, '普', '0000001')`, [cid, pr, name, bank, branch]);
  const accName = async (cid, pr) => (await T.one('select bank_name from bank_account where company_id = $1 and priority = $2', [cid, pr]) || {}).bank_name;
  const e0 = [await insAcc('90001', 1, 'りそな', null, null), await insAcc('90002', 1, 'てきとう', '000', '000'), await insAcc('90002', 2, '広島県信組', '2681', '011'),
    await insAcc('90002', 3, '青森', '0117', '000'), await insAcc('90002', 4, '中京', '0544', '002'), await insAcc('90002', 5, 'トマト', null, null)];
  ok('銀行マスタが空のあいだ: 口座は今までどおり入る（コードが空・形が違う・無い店でも）・銀行名も打ったまま',
    e0.every(x => x === null) && (await accName('90002', 2)) === '広島県信組', e0);

  // ---- 取込の行の守り
  const rr = await T.one(`insert into bank_master_run(source, mode, started_at, applied_at, counts) values ('csv', 'upsert', '2000-01-01', '2000-01-01', '{"x":1}')
    returning run_id::int, now() - started_at < interval '1 minute' as fresh, applied_at is null as not_applied, counts is null as no_counts, as_of::text as as_of`);
  await pg.query(`update bank_master_run set applied_at = now(), counts = '{"x":2}', started_at = '2001-01-01', file_name = 'x.csv' where run_id = $1`, [rr.run_id]);
  const rr2 = await T.one(`select applied_at is null as not_applied, counts is null as no_counts, now() - started_at < interval '1 minute' as fresh, file_name from bank_master_run where run_id = $1`, [rr.run_id]);
  ok('取込の行: 日時は DB が付ける（送った 2000 年は使われない）・反映の印は手では付けられない・upsert で日付が無ければ今日',
    rr.fresh && rr.not_applied && rr.no_counts && rr.as_of === today && rr2.not_applied && rr2.no_counts && rr2.fresh && rr2.file_name === 'x.csv', { rr, rr2 });
  ok('置いた行が無い取込は反映できない', ((await T.preview(rr.run_id)).problem || '').includes('取り込む行がありません')
    && ((await T.err('select bank_master_apply($1, false)', [rr.run_id])) || '').includes('取り込む行がありません'));
  ok('取込の種類は upsert か latest だけ', (await T.err(`insert into bank_master_run(source, mode) values ('csv', 'replace')`)) !== null);

  // ---- 最初の取込（経理の役割で）
  let run1;
  await T.as('authenticated', 'accounting', async () => {
    run1 = await T.newRun('upsert', '2026-11-24');
    await T.stage(run1, SAMPLE);
    const pv = await T.preview(run1);
    ok('下見（最初）: 銀行 8・店 12 が新設。まだ何も入っていない', pv.problem === null && pv.counts['銀行:新設'] === 8 && pv.counts['店:新設'] === 12 && pv.staged === 12 && pv.same === 0
      && pv.master_branches === 0 && pv.master_as_of === null && pv.samples.length === 20, pv.counts);
    const ap = await T.apply(run1);
    const st = await T.state();
    ok('反映（最初）: 銀行 8・店 12・基準日 2026-11-24・置き場は空・1 行ずつの記録は残さない',
      ap['店:新設'] === 12 && ap['銀行:新設'] === 8 && ap['置いた行'] === 12 && st.banks === 8 && st.branches === 12 && st.abolished_branches === 0 && st.as_of === '2026-11-24'
      && (await T.count('bank_master_stage')) === 0 && (await T.count('bank_master_log')) === 0, { ap, st });
  });
  const sinceRun1 = (await T.one('select clock_timestamp()::text as t')).t;
  const run1row = await T.one(`select now() - applied_at < interval '1 minute' as fresh, counts from bank_master_run where run_id = $1`, [run1]);
  ok('取込の行に、反映した日時（DB が付ける）と数が残る', run1row.fresh === true && run1row.counts['店:新設'] === 12, run1row.counts);
  ok('同じ取込は 2 回反映できない・反映済みの行は直せない', ((await T.err('select bank_master_apply($1, false)', [run1])) || '').includes('反映済み')
    && ((await T.err(`update bank_master_run set file_name = 'y' where run_id = $1`, [run1])) || '').includes('反映済みの取込は直せません'));
  const v108 = await T.one(`select * from v_bank_branch where bank_code = '0001' and branch_code = '108'`);
  const v506 = await T.one(`select * from v_bank_branch where bank_code = '0038' and branch_code = '506'`);
  ok('読み口: 銀行と店が 1 行・空の項目は空文字・廃止の印なし', v108.bank_name === 'みずほ銀行' && v108.branch_name === '神田' && v108.branch_kana === 'ｶﾝﾀﾞ' && v108.abolished === false
    && v506.postal_code === '' && v506.address === '' && v506.phone === '' && v506.clearing_no === '', v108);
  const out1 = Csv.build(await T.all('select * from v_bank_branch'));
  ok('入れたものを書き出すと、入れた 12 行と 1 バイトも違わない', out1.bad.length === 0 && Buffer.compare(Buffer.from(out1.bytes), Buffer.from(Csv.build(SAMPLE).bytes)) === 0, { bytes: out1.bytes.length });

  // ---- 2 回目の取込（upsert）: 新設・改称・変更・銀行の改称・変更なし
  const m = (code, branch) => SAMPLE.find(r => r.bank_code === code && r.branch_code === branch);
  const run2 = await T.newRun('upsert', null);
  await T.stage(run2, [
    S(['0001', '110', 'ﾐｽﾞﾎ', 'みずほ銀行', 'ｸﾀﾞﾝ', '九段', '102-0073', '東京都千代田区（試験）４－１', '03-0000-0110', '1301']),
    Object.assign({}, m('1242', '014'), { branch_name: '桜川', branch_kana: 'ｻｸﾗｶﾞﾜ' }),
    Object.assign({}, m('0001', '108'), { address: '東京都千代田区（試験）移転先', phone: null }),
    Object.assign({}, m('0005', '002'), { bank_name: '三菱ＵＦＪ銀行（試験）' }),
    m('0001', '004'),
  ]);
  const pv2 = await T.preview(run2);
  ok('下見（2 回目）: 店の新設 1・改称 1・変更 1、銀行の改称 1、変更なし 2', pv2.problem === null && pv2.counts['店:新設'] === 1 && pv2.counts['店:改称'] === 1 && pv2.counts['店:変更'] === 1
    && pv2.counts['銀行:改称'] === 1 && Object.keys(pv2.counts).length === 4 && pv2.same === 2 && pv2.samples.length === 4, pv2.counts);
  const before2 = await T.one(`select md5(string_agg(t::text, '' order by bank_code, branch_code)) h from bank_branch t`);
  ok('下見だけでは銀行マスタは 1 文字も変わらない', before2.h === (await T.one(`select md5(string_agg(t::text, '' order by bank_code, branch_code)) h from bank_branch t`)).h && (await T.count('bank_master_log')) === 0);
  const ap2 = await T.apply(run2);
  const log2 = await T.all('select kind, target, bank_code, branch_code, before, after, now() - at < interval \'1 minute\' as fresh from bank_master_log where run_id = $1 order by target, kind', [run2]);
  const ren = log2.find(l => l.kind === '改称' && l.target === '店');
  const b0005 = await T.one(`select name from bank where bank_code = '0005'`);
  const t108 = await T.one(`select address, phone, postal_code from bank_branch where bank_code = '0001' and branch_code = '108'`);
  const st2 = await T.state();
  ok('反映（2 回目）: 変更の記録 4 行（前と後が残る・日時は DB）・店 13・CSV に無い店はそのまま（廃止にしない）',
    ap2['変更なし'] === 2 && log2.length === 4 && log2.every(l => l.fresh) && ren.bank_code === '1242' && ren.before.name === '羽黒' && ren.after.name === '桜川' && ren.after.kana === 'ｻｸﾗｶﾞﾜ'
    && b0005.name === '三菱ＵＦＪ銀行（試験）' && t108.address === '東京都千代田区（試験）移転先' && t108.phone === null && t108.postal_code === '101-0047'
    && st2.branches === 13 && st2.abolished_branches === 0 && st2.as_of === today, { ap2, st2 });

  // ---- 最新の一覧（latest）: 廃止・新設。古い一覧・欠けた一覧は反映しない
  const active = await T.all('select bank_code, branch_code from bank_branch');
  const gone = new Set(['0544-001', '0544-002', '9999-999']);
  const list1 = active.filter(r => !gone.has(r.bank_code + '-' + r.branch_code)).map(r => codeOnly(r))
    .concat([codeOnly({ bank_code: '0001', branch_code: '200' }, { branch_name: '試験新店', branch_kana: 'ｼｹﾝ' })]);
  const run3 = await T.newRun('latest', null, 'zengin');
  await T.stage(run3, list1);
  const prob = async () => (await T.preview(run3)).problem || '';
  const p3a = await prob();
  await pg.query(`update bank_master_run set as_of = '2026-11-01' where run_id = $1`, [run3]);
  const p3b = await prob();
  const e3b = (await T.err('select bank_master_apply($1, true)', [run3])) || '';
  await pg.query('update bank_master_run set as_of = current_date where run_id = $1', [run3]);
  const p3c = await prob();
  const e3c = (await T.err('select bank_master_apply($1, false)', [run3])) || '';
  ok('最新の一覧: 日付が無ければ反映しない', p3a.includes('一覧の日付（基準日）がありません'), p3a);
  ok('最新の一覧: 今の基準日より古い一覧は反映しない（確かめ済みの印を付けても）', p3b.includes('より古いので反映しません') && e3b.includes('より古いので反映しません'), p3b);
  ok('最新の一覧: 今ある店の 5% を超えて廃止になる一覧は、そのままでは反映しない', p3c.includes('13 店のうち 3 店が廃止になります（5% を超える）') && e3c.includes('5% を超える')
    && (await T.count('bank_branch', 'abolished_on is not null')) === 0, p3c);
  const runNoName = await T.newRun('latest', today, 'zengin');
  await T.stage(runNoName, [codeOnly({ bank_code: '0001', branch_code: '300' }), codeOnly({ bank_code: '0777', branch_code: '001' }, { branch_name: '本店', branch_kana: 'ﾎﾝﾃﾝ' })]);
  const pNoName = (await T.preview(runNoName)).problem || '';
  ok('最新の一覧: 新しい銀行・店に名前が無ければ反映しない', pNoName.includes('名前かカナがありません（0001-300・0777-001）'), pNoName);
  await pg.query('delete from bank_master_stage where run_id = $1', [runNoName]);
  const ap3 = await T.apply(run3, true);
  const ab = await T.all(`select bank_code || '-' || branch_code as code, abolished_on::text d from bank_branch where abolished_on is not null order by 1`);
  const abBank = await T.all(`select bank_code, abolished_on::text d from bank where abolished_on is not null order by 1`);
  const keep = await T.one(`select (select name from bank where bank_code = '0005') as b5, (select address from bank_branch where bank_code = '0001' and branch_code = '108') as addr,
    (select name from bank_branch where bank_code = '0001' and branch_code = '200') as n200`);
  const st3 = await T.state();
  ok('最新の一覧（確かめ済みで反映）: 一覧に無い 3 店と 2 銀行に廃止の印（日付は今日）・新設 1・名前と所在地は銀行マスタのまま',
    ap3['店:廃止'] === 3 && ap3['銀行:廃止'] === 2 && ap3['店:新設'] === 1 && ap3['変更なし'] === 10 && show(ab.map(x => x.code)) === show(['0544-001', '0544-002', '9999-999'])
    && ab.every(x => x.d === today) && show(abBank.map(x => x.bank_code)) === show(['0544', '9999']) && keep.b5 === '三菱ＵＦＪ銀行（試験）'
    && keep.addr === '東京都千代田区（試験）移転先' && keep.n200 === '試験新店' && st3.branches === 14 && st3.abolished_branches === 3, { ap3, st3 });
  ok('廃止の店も読み口に残る（tera への書き出しに入る）・印が付く', (await T.count('v_bank_branch')) === 14 && (await T.count('v_bank_branch', 'abolished')) === 3);

  // ---- 最新の一覧 2 回目: 戻ってきた店は廃止を解く
  const list2 = list1.concat([codeOnly({ bank_code: '0544', branch_code: '001' })]);
  const run4 = await T.newRun('latest', today, 'zengin');
  await T.stage(run4, list2);
  const pv4 = await T.preview(run4);
  const ap4 = await T.apply(run4);
  const z = await T.one(`select (select abolished_on is null from bank where bank_code = '0544') as bank_back, (select abolished_on is null from bank_branch where bank_code = '0544' and branch_code = '001') as b1_back,
    (select abolished_on is not null from bank_branch where bank_code = '0544' and branch_code = '002') as b2_still, (select abolished_on is not null from bank where bank_code = '9999') as dummy_still`);
  ok('最新の一覧（2 回目）: 一覧に戻った店と銀行は廃止を解く・戻っていない店は廃止のまま',
    pv4.problem === null && ap4['店:復活'] === 1 && ap4['銀行:復活'] === 1 && ap4['変更なし'] === 11 && z.bank_back && z.b1_back && z.b2_still && z.dummy_still, { ap4, z });

  // ---- CSV の取込（upsert）は廃止を解かない
  const run5 = await T.newRun('upsert', null);
  await T.stage(run5, [m('9999', '999'), Object.assign({}, m('0544', '002'), { phone: '052-000-9999' })]);
  const pv5 = await T.preview(run5);
  const ap5 = await T.apply(run5);
  const z5 = await T.one(`select (select abolished_on is not null from bank_branch where bank_code = '9999' and branch_code = '999') as dummy_still,
    (select abolished_on is not null from bank_branch where bank_code = '0544' and branch_code = '002') as b2_still, (select phone from bank_branch where bank_code = '0544' and branch_code = '002') as phone`);
  ok('CSV の取込: 廃止の店が CSV にあっても廃止は解かない（中身の直しは入る）', pv5.counts['店:変更'] === 1 && Object.keys(pv5.counts).length === 1 && pv5.same === 1
    && ap5['店:変更'] === 1 && z5.dummy_still && z5.b2_still && z5.phone === '052-000-9999', { ap5, z5 });
  ok('変更の記録は取込ごとに残る', (await T.count('bank_master_log')) === 4 + 6 + 2 + 1, await T.all('select run_id, count(*)::int n from bank_master_log group by 1 order by 1'));

  // ---- 途中でやめた取込の置き場は、次の反映のときに片付く（1 日より前のもの）
  const runOld = await T.newRun('upsert', null), runNew = await T.newRun('upsert', null), run6 = await T.newRun('upsert', null);
  await T.stage(runOld, [m('0001', '004')]); await T.stage(runNew, [m('0001', '005')]); await T.stage(run6, [m('0001', '009')]);
  await pg.exec(`alter table bank_master_run disable trigger trg_bank_master_run_guard; update bank_master_run set started_at = now() - interval '2 days' where run_id = ${runOld};
    alter table bank_master_run enable trigger trg_bank_master_run_guard;`);
  await T.apply(run6);
  ok('途中でやめた取込の置き場: 1 日より前のものだけ片付く', (await T.count('bank_master_stage', `run_id = ${runOld}`)) === 0 && (await T.count('bank_master_stage', `run_id = ${runNew}`)) === 1
    && (await T.count('bank_master_stage', `run_id = ${run6}`)) === 0);

  // ---- 口座の点検（入れるとき・コードを変えるとき）
  await T.as('authenticated', 'accounting', async () => {
    const eOk = await insAcc('90001', 2, 'ミズホ', '0001', '108');
    ok('口座: 銀行マスタにある店は入る・銀行名は銀行マスタの名前で入る（打った「ミズホ」は使われない）', eOk === null && (await accName('90001', 2)) === 'みずほ銀行', await accName('90001', 2));
    const eA = await insAcc('90001', 3, 'x', null, null), eB = await insAcc('90001', 3, 'x', '0001', null), eC = await insAcc('90001', 3, 'x', '0002', '001');
    const eD = await insAcc('90001', 3, 'x', '0001', '999'), eE = await insAcc('90001', 3, 'x', '0544', '002'), eF = await insAcc('90001', 3, 'x', '9999', '999');
    const eG = await insAcc('90001', 3, 'x', '1', '108');
    ok('口座で止める: コードが空', (eA || '').includes('銀行コードと支店コードは必須です') && (eB || '').includes('銀行コードと支店コードは必須です'), eA);
    ok('口座で止める: 無い銀行・無い店', (eC || '').includes('銀行コード 0002 は銀行マスタにありません') && (eD || '').includes('みずほ銀行に支店コード 999 はありません')
      && (eG || '').includes('銀行コード 1 は銀行マスタにありません'), [eC, eD, eG]);
    ok('口座で止める: 廃止の店・廃止の銀行', (eE || '').includes('中京銀行 大曽根（0544-002）は廃止の印が付いています') && (eF || '').includes('ダミー登録用銀行 ダミー（9999-999）は廃止の印'), [eE, eF]);
    ok('口座: 廃止が解けた店は入る', (await insAcc('90001', 3, 'x', '0544', '001')) === null && (await accName('90001', 3)) === '中京銀行');
    ok('止まった口座は 1 件も入っていない', (await T.count('bank_account', `company_id = '90001'`)) === 3);
    // 前から入っている口座（コードが空・形が違う）: コードを変えない直しは通る
    const u1 = await T.err(`update bank_account set approved_by = '試験 花子', approved_at = now() where company_id = '90001' and priority = 1`);
    const u2 = await T.err(`update bank_account set account_number = '7654321', bank_name = 'てきとう２' where company_id = '90002' and priority = 1`);
    ok('前から入っている口座: コードを変えない直し（承認・名義など）は止めない・銀行名も触らない', u1 === null && u2 === null && (await accName('90002', 1)) === 'てきとう２', [u1, u2]);
    const u3 = await T.err(`update bank_account set bank_code = '0005', branch_code = '002' where company_id = '90001' and priority = 1`);
    const u4 = await T.err(`update bank_account set bank_code = '0001', branch_code = '999' where company_id = '90002' and priority = 1`);
    const u5 = await T.err(`update bank_account set branch_code = '' where company_id = '90001' and priority = 2`);
    ok('前から入っている口座: コードを直すときは点検する（合えば銀行名も銀行マスタの名前に）', u3 === null && (await accName('90001', 1)) === '三菱ＵＦＪ銀行（試験）'
      && (u4 || '').includes('支店コード 999 はありません') && (u5 || '').includes('必須'), [u3, u4, u5]);
  });
  await T.as('authenticated', 'sales', async () => {
    const eS1 = await insAcc('90001', 9, 'x', '0001', '999'), eS2 = await insAcc('90001', 9, 'x', '0001', '005');
    ok('銀行マスタを見られない役割が口座を書いても、点検は同じに働く', (eS1 || '').includes('支店コード 999 はありません') && eS2 === null && (await accName('90001', 9)) === 'みずほ銀行', [eS1, eS2]);
  });

  // ---- 口座の点検の一覧
  const chk = await T.all('select company_id, priority, reason, is_suspended, bank_code, branch_code from v_bank_account_check order by company_id, priority');
  ok('口座の点検の一覧: 形が違う・無い店・廃止の店・空 の 4 件（合う口座は並ばない）', chk.length === 4 && chk.every(c => c.company_id === '90002' && c.is_suspended === true)
    && show(chk.map(c => c.reason)) === show(['コードの形が違う', '銀行マスタに無い店', '廃止の店', '銀行コード・支店コードが空']) && chk[0].bank_code === '000', chk.map(c => [c.priority, c.reason]));

  // ---- 画面が呼ぶ口（経理の役割で）。ここまでの中身: 店 14（うち廃止 2＝0544-002・9999-999）・銀行 8（うち廃止 1＝9999）
  const keysOf = (j) => j.rows.map(r => r.bank_code + '-' + r.branch_code);
  const search = async (q, withAbolished = false, limit = 30) =>
    (await T.one('select bank_branch_search($1::text::jsonb, $2, $3) as j', [JSON.stringify(Csv.searchTerms(q)), withAbolished, limit])).j;
  const lookup = async (keys) => T.all('select * from bank_branch_lookup(array(select jsonb_array_elements_text($1::text::jsonb)))', [JSON.stringify(keys)]);
  await T.as('authenticated', 'accounting', async () => {
    const lk = await lookup(['0001-108', '0001-999', '0002-001', '0544-002', '9999-999', '0001-108', 'x', '']);
    const by = Object.fromEntries(lk.map(r => [r.k, r]));
    ok('コードから名前を引く: ある店・無い店（銀行名は返る）・無い銀行・廃止の店・廃止の銀行（同じ鍵は 1 行）',
      lk.length === 7 && by['0001-108'].bank_name === 'みずほ銀行' && by['0001-108'].branch_name === '神田' && by['0001-108'].bank_kana === 'ﾐｽﾞﾎ' && by['0001-108'].branch_kana === 'ｶﾝﾀﾞ'
      && by['0001-108'].abolished === false && by['0001-999'].bank_name === 'みずほ銀行' && by['0001-999'].branch_name === null && by['0001-999'].abolished === false
      && by['0002-001'].bank_name === null && by['0002-001'].branch_name === null && by['0544-002'].branch_name === '大曽根' && by['0544-002'].abolished === true
      && by['0544-002'].bank_abolished === false && by['9999-999'].abolished === true && by['9999-999'].bank_abolished === true && by['x'].bank_name === null && by[''].bank_name === null,
      lk.map(r => [r.k, r.bank_name, r.branch_name, r.abolished]));

    const s1 = await search('みずほ まるのうち'), s2 = await search('まるのうち'), s3 = await search('丸の内'), s4 = await search('ｓｍｔｂ'), s5 = await search('ufj');
    ok('名前から探す: ひらがなで銀行と支店（みずほ まるのうち＝2 店）・支店だけ（まるのうち＝3 店）・漢字（丸の内＝2 店。丸之内は当たらない）',
      s1.total === 2 && show(keysOf(s1)) === show(['0001-004', '0001-005']) && s1.rows[0].bank_name === 'みずほ銀行' && s1.rows[0].branch_name === '丸の内中央' && s1.rows[0].branch_kana === 'ﾏﾙﾉｳﾁﾁﾕｳｵｳ'
      && s2.total === 3 && show(keysOf(s2)) === show(['0001-004', '0001-005', '0005-002']) && s3.total === 2 && show(keysOf(s3)) === show(['0001-004', '0005-002']), [keysOf(s1), keysOf(s2), keysOf(s3)]);
    ok('名前から探す: 英字は全角・半角・大文字・小文字を区別しない（ｓｍｔｂ・ufj）', s4.total === 1 && keysOf(s4)[0] === '0038-506' && s5.total === 1 && keysOf(s5)[0] === '0005-002', [keysOf(s4), keysOf(s5)]);
    const c1 = await search('0544'), c2 = await search('0544', true), c3 = await search('0001-108'), c4 = await search('みずほ 108'), c5 = await search('ダミー'), c6 = await search('ダミー', true);
    ok('名前から探す: 廃止の店は出さない（出すと指定したときだけ出て、印が付く）・コードでも探せる',
      c1.total === 1 && keysOf(c1)[0] === '0544-001' && c2.total === 2 && c2.rows[1].abolished === true && c2.rows[0].abolished === false && c3.total === 1 && keysOf(c3)[0] === '0001-108'
      && c4.total === 1 && keysOf(c4)[0] === '0001-108' && c5.total === 0 && c5.rows.length === 0 && c6.total === 1 && c6.rows[0].abolished === true, [keysOf(c1), keysOf(c2), keysOf(c4), c5.total, c6.total]);
    const l1 = await search('みずほ', false, 2), l2 = await search(''), l3 = await search('ちゅうおう'), l4 = await search('みずほ ない店');
    ok('名前から探す: 数は全部の数・行は先頭の指定の数まで（コードの順）・言葉が無ければ 0・当たらなければ 0・小さい「ゅ」も当たる',
      l1.total === 6 && show(keysOf(l1)) === show(['0001-004', '0001-005']) && l2.total === 0 && l2.rows.length === 0 && l3.total === 2 && show(keysOf(l3)) === show(['0001-004', '1688-011'])
      && l4.total === 0, [l1.total, keysOf(l1), keysOf(l3)]);

    const lv = await T.all('select * from bank_master_log_view(100)');
    const line = (r) => [r.kind, r.target, r.bank_code, r.branch_code, r.stores === null ? null : Number(r.stores)].join('|');
    const lvLines = lv.map(line);
    const firstLoad = lv[lv.length - 1], noChange = lv[0];
    ok('変更の記録（画面の形）: 新しい順・銀行ごとの廃止と復活は銀行の 1 行（店の数つき）にまとまる・1 行ずつの記録が無い取込は取込の 1 行',
      lv.length === 11 && show(lvLines) === show(['取込|一覧|||', '変更|店|0544|002|', '復活|銀行|0544||1', '廃止|銀行|0544||2', '廃止|銀行|9999||1', '新設|店|0001|200|',
        '改称|銀行|0005||0', '変更|店|0001|108|', '新設|店|0001|110|', '改称|店|1242|014|', '取込|一覧|||'])
      && firstLoad.counts['店:新設'] === 12 && firstLoad.counts['銀行:新設'] === 8 && noChange.counts['変更なし'] === 1 && noChange.counts['店:新設'] === undefined
      && lv[2].bank_name === '中京銀行' && lv[9].before.name === '羽黒' && lv[9].after.name === '桜川' && lv[9].bank_name === '結城信用金庫', lvLines);
    ok('変更の記録（画面の形）: 数を絞れる', (await T.all('select * from bank_master_log_view(3)')).length === 3);

    const sA = (await T.one('select bank_master_state($1::text::timestamptz) as j', [sinceRun1])).j;
    const sB = (await T.one(`select bank_master_state('2000-01-01'::timestamptz) as j`)).j;
    const sC = (await T.one('select bank_master_state() as j')).j;
    const sD = (await T.one('select bank_master_state(clock_timestamp()) as j')).j;
    ok('今の状態: 前に書き出した日時を渡すと、そのあと変わった数が返る（最初の取込は入れた店の数で数える）・渡さなければ数えない',
      sA.changes_since === 13 && sB.changes_since === 25 && sC.changes_since === null && sD.changes_since === 0 && sC.branches === 14 && sC.abolished_branches === 2 && sC.banks === 8,
      { 最初の取込のあと: sA.changes_since, 全部: sB.changes_since, 今: sD.changes_since });

    const ex = (await T.one('select bank_master_export() as j')).j;
    const exOut = Csv.build(ex.map(a => Csv.fromArray(a)));
    const viaView = Csv.build(await T.all('select * from v_bank_branch'));
    ok('tera への書き出しの中身: 全部の店（廃止の店も）がコードの順・読み口から作ったものと 1 バイトも違わない',
      ex.length === 14 && ex[0][0] === '0001' && ex[0][1] === '004' && ex[13][0] === '9999' && ex.every(a => a.length === 10 && a.every(v => typeof v === 'string'))
      && exOut.bad.length === 0 && Buffer.compare(Buffer.from(exOut.bytes), Buffer.from(viaView.bytes)) === 0, { rows: ex.length, bytes: exOut.bytes.length });

    const ck = (await T.one('select bank_account_check() as j')).j;
    const ckView = await T.all('select account_id from v_bank_account_check');
    ok('口座の点検の一覧（画面の口）: 読み口と同じ口座・有効な会社が先', ck.length === ckView.length && ck.length === 4 && ck.every(r => r.reason && r.official_name && r.is_suspended === true)
      && show(ck.map(r => r.priority)) === show([1, 3, 4, 5]), ck.map(r => [r.company_id, r.priority, r.reason]));

    // 画面の CSV 取込: 始める → 行を置く → 下見 → やめる
    const begin = async (name, asOf) => Number((await T.one('select bank_master_begin($1, $2::text::date, $3) as id', [name, asOf, '試験 太郎'])).id);
    const put = async (run, rows) => (await T.one('select bank_master_stage_rows($1, $2::text::jsonb) as n', [run, JSON.stringify(rows.map(r => Csv.toArray(r)))])).n;
    const runB = await begin('見本_261124.csv', '2026-11-24');
    const rowB = await T.one('select source, mode, file_name, actor, as_of::text as as_of, applied_at is null as open from bank_master_run where run_id = $1', [runB]);
    const nB = await put(runB, [Object.assign({}, m('0001', '005'), { branch_name: '丸ノ内' }), m('0038', '506')]);
    const stB = await T.one(`select postal_code is null and address is null and phone is null and clearing_no is null as empty_is_null from bank_master_stage where run_id = $1 and bank_code = '0038'`, [runB]);
    const pvB = await T.preview(runB);
    const nCancel = (await T.one('select bank_master_cancel($1) as n', [runB])).n;
    ok('画面の取込: 始める（種類は upsert・ファイル名・人・基準日が残る）→ 行を置く（空の項目は NULL）→ 下見 → やめる（置き場が空になり、銀行マスタは変わらない）',
      rowB.source === 'csv' && rowB.mode === 'upsert' && rowB.file_name === '見本_261124.csv' && rowB.actor === '試験 太郎' && rowB.as_of === '2026-11-24' && rowB.open === true
      && nB === 2 && stB.empty_is_null === true && pvB.problem === null && pvB.counts['店:改称'] === 1 && pvB.same === 1 && nCancel === 2
      && (await T.count('bank_master_stage', `run_id = ${runB}`)) === 0 && (await T.one(`select name from bank_branch where bank_code = '0001' and branch_code = '005'`)).name === '丸之内', { rowB, pvB: pvB.counts });
    const eBad = await T.err('select bank_master_stage_rows($1, $2::text::jsonb)', [runB, JSON.stringify([['001', '005', 'ﾐｽﾞﾎ', 'みずほ銀行', 'ﾏﾙﾉｳﾁ', '丸之内', '', '', '', '']])]);
    ok('画面の取込: コードの形が違う行は置けない', (eBad || '').includes('bank_master_stage_code_chk'), eBad);

    // 反映のときに基準日を渡す
    const runC = await begin('見本.csv', null);
    await put(runC, [Object.assign({}, m('0001', '005'), { branch_name: '丸ノ内' })]);
    const eFuture = await T.err(`select bank_master_apply($1, false, '2999-01-01'::date)`, [runC]);
    const openC = await T.one('select applied_at is null as open, as_of::text as as_of from bank_master_run where run_id = $1', [runC]);
    const apC = (await T.one(`select bank_master_apply($1, false, '2026-11-20'::date) as j`, [runC])).j;
    const rowC = await T.one('select applied_at is not null as applied, as_of::text as as_of from bank_master_run where run_id = $1', [runC]);
    ok('画面の取込: 基準日が空なら今日（日本の日付）・未来の基準日では反映しない（何も変わらない）・反映のときに渡した基準日が残る',
      openC.as_of === today && (eFuture || '').includes('基準日に未来の日付は入れられません') && openC.open === true && apC['店:改称'] === 1 && rowC.applied === true && rowC.as_of === '2026-11-20'
      && (await T.one(`select name from bank_branch where bank_code = '0001' and branch_code = '005'`)).name === '丸ノ内' && (await T.state()).as_of === today, { eFuture, apC, rowC });
    ok('画面の取込: 反映済みの取込には置けない（0 が返る）・未来の基準日では始められない', (await put(runC, [m('0001', '004')])) === 0
      && ((await T.err(`select bank_master_begin('x.csv', '2999-01-01'::date, 'x')`)) || '').includes('基準日に未来の日付は入れられません'));
  });

  // ---- 権限
  await T.as('authenticated', 'sales', async () => {
    const sx = await search('みずほ'), lx = await lookup(['0001-108']);
    const ex = (await T.one('select bank_master_export() as j')).j, lvx = await T.all('select * from bank_master_log_view(10)');
    const eb = await T.err(`select bank_master_begin('x.csv', null, 'x')`);
    ok('経理・管理者でない役割: 画面の口を呼んでも何も返らない・取込は始められない', sx.total === 0 && lx.length === 1 && lx[0].bank_name === null && ex.length === 0 && lvx.length === 0
      && (eb || '').includes('row-level security'), { 探す: sx.total, 書き出し: ex.length, 取込: eb });
    const c = await T.one(`select (select count(*)::int from bank) as b, (select count(*)::int from bank_branch) as t, (select count(*)::int from bank_master_log) as l,
      (select count(*)::int from bank_master_run) as r, (select count(*)::int from v_bank_branch) as v`);
    const st = await T.state();
    const e1 = await T.err(`insert into bank_master_run(source, mode) values ('csv', 'upsert')`);
    const e2 = await T.err(`insert into bank(bank_code, name, kana) values ('0777', '試験銀行', 'ｼｹﾝ')`);
    ok('経理・管理者でない役割: 銀行マスタは 1 行も見えない・取込も足すこともできない', c.b === 0 && c.t === 0 && c.l === 0 && c.r === 0 && c.v === 0 && st.branches === 0
      && (e1 || '').includes('row-level security') && (e2 || '').includes('row-level security'), { c, e1 });
  });
  await T.as('anon', '', async () => {
    const e1 = await T.err('select count(*) from bank'), e2 = await T.err('select bank_master_state()'), e3 = await T.err('select count(*) from v_bank_branch'), e4 = await T.err('select count(*) from v_bank_account_check');
    ok('ログインしていない人: 表・読み口・関数に触れない', [e1, e2, e3, e4].every(e => (e || '').includes('permission denied')), [e1, e2]);
  });
  await T.as('authenticated', 'accounting', async () => {
    const e1 = await T.err(`delete from bank_branch where bank_code = '0001'`), e2 = await T.err(`delete from bank where bank_code = '9999'`);
    const e3 = await T.err(`update bank_master_log set kind = '新設'`), e4 = await T.err('delete from bank_master_log');
    ok('経理でも: 銀行・店は消せない・変更の記録は直せない・消せない', [e1, e2, e3, e4].every(e => (e || '').includes('permission denied')), [e1, e3]);
    ok('経理: 銀行マスタは見える', (await T.count('bank')) === 8 && (await T.count('v_bank_branch')) === 14);
  });
  await pg.close();
}

// ======================================================================
// 3. 本物の CSV（渡したときだけ）
// ======================================================================
if (CSV) {
  const raw = fs.readFileSync(CSV);
  let t0 = Date.now();
  const parsed = Csv.parse(raw);
  ok(`本物の CSV を読む: ${parsed.rows.length} 行・直す所 ${parsed.errorCount}`, parsed.errorCount === 0 && parsed.rows.length > 30000, { ms: Date.now() - t0, 先頭の直す所: parsed.errors.slice(0, 3) });
  const pg = await newDb();
  const T = tools(pg);
  await pg.exec(sql);
  const today = (await T.one(`select (now() at time zone 'Asia/Tokyo')::date::text d`)).d;

  // 本番の口座（コードだけの写し）は、銀行マスタが空のうちに入れる＝前から入っている口座
  let accounts = [];
  if (ACCOUNTS) {
    const dump = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8'));
    accounts = dump.accounts;
    for (let i = 0; i < dump.companies.length; i += 1000) {
      const params = [];
      const tuples = dump.companies.slice(i, i + 1000).map(c => { params.push(c.company_id, '（試験）' + c.company_id, !!c.is_suspended); return `($${params.length - 2}, $${params.length - 1}, $${params.length})`; });
      await pg.query(`insert into company(company_id, official_name, is_suspended) values ${tuples.join(',')}`, params);
    }
    for (let i = 0; i < accounts.length; i += 1000) {
      const params = [];
      const tuples = accounts.slice(i, i + 1000).map(a => {
        params.push(a.account_id, a.company_id, a.priority, a.bank_name, a.bank_code, a.branch_code, a.payment_method || '振込');
        const n = params.length; return `($${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
      });
      await pg.query(`insert into bank_account(account_id, company_id, priority, bank_name, bank_code, branch_code, payment_method) values ${tuples.join(',')}`, params);
    }
    ok(`本番の口座の写しを入れる（銀行マスタが空のうち）: ${accounts.length} 件`, (await T.count('bank_account')) === accounts.length);
  }

  // 画面と同じ道すじ: 始める（基準日はファイル名から）→ 2,000 行ずつ置く → 下見 → 反映
  const search = async (q, withAbolished = false, limit = 30) =>
    (await T.one('select bank_branch_search($1::text::jsonb, $2, $3) as j', [JSON.stringify(Csv.searchTerms(q)), withAbolished, limit])).j;
  const keysOf = (j) => j.rows.map(r => r.bank_code + '-' + r.branch_code);
  const exportBytes = async () => Csv.build((await T.one('select bank_master_export() as j')).j.map(a => Csv.fromArray(a)));
  const asOf = Csv.dateFromName(path.basename(CSV)) || null;
  t0 = Date.now();
  const run1 = Number((await T.one('select bank_master_begin($1, $2::text::date, $3) as id', [path.basename(CSV), asOf, '試験 太郎'])).id);
  let placed = 0, calls = 0, maxBody = 0;
  for (let i = 0; i < parsed.rows.length; i += 2000) {
    const body = JSON.stringify(parsed.rows.slice(i, i + 2000).map(r => Csv.toArray(r)));
    maxBody = Math.max(maxBody, Buffer.byteLength(body));
    placed += (await T.one('select bank_master_stage_rows($1, $2::text::jsonb) as n', [run1, body])).n;
    calls++;
  }
  ok(`画面と同じ道すじで置く: 2,000 行ずつ ${calls} 回・基準日はファイル名から ${asOf}`, placed === parsed.rows.length, { 一回の大きさ_バイト: maxBody });
  const tStage = Date.now() - t0; t0 = Date.now();
  const pv = await T.preview(run1);
  const tPreview = Date.now() - t0; t0 = Date.now();
  const ap = await T.apply(run1);
  const tApply = Date.now() - t0;
  const st = await T.state();
  ok(`本物の CSV を入れる: 銀行 ${st.banks}・店 ${st.branches}`, pv.problem === null && pv.counts['店:新設'] === parsed.rows.length && ap['店:新設'] === parsed.rows.length
    && st.branches === parsed.rows.length && st.banks === new Set(parsed.rows.map(r => r.bank_code)).size && st.abolished_branches === 0,
    { 置く_ms: tStage, 下見_ms: tPreview, 反映_ms: tApply });
  ok('基準日: ファイル名の日付が入る', asOf === null || st.as_of === asOf, st.as_of);
  t0 = Date.now();
  const out = await exportBytes();
  ok('書き出したものが、元の CSV と 1 バイトも違わない', out.bad.length === 0 && Buffer.compare(Buffer.from(out.bytes), raw) === 0, { 元: raw.length, 書き出し: out.bytes.length, ms: Date.now() - t0 });
  const run2 = await T.newRun('upsert', null);
  await T.stage(run2, parsed.rows);
  const pv2 = await T.preview(run2);
  const ap2 = await T.apply(run2);
  ok('同じ CSV をもう一度入れても、何も変わらない（変更の記録 0 行）', pv2.problem === null && Object.keys(pv2.counts).length === 0 && pv2.same === parsed.rows.length
    && ap2['変更なし'] === parsed.rows.length && (await T.count('bank_master_log')) === 0, ap2);

  // 名前から探す（本物の中身）
  const odd = await T.one(`select count(*) filter (where bank_kana ~ '[ｧ-ｯｰa-z]')::int as bank, count(*) filter (where branch_kana ~ '[ｧ-ｯｰa-z]')::int as branch from v_bank_branch`);
  const o1 = await search('みなとちゅうおう'), o2 = await search('だみーとうろく'), o3 = await search('ぎょうむとうかつ');
  ok(`カナの書き方が決まりと違う行（小さいカナ・半角の長音「ｰ」。銀行 ${odd.bank}・店 ${odd.branch}）も、同じ言葉で当たる`,
    o1.rows.some(r => r.bank_code === '0544' && r.branch_code === '270') && o2.rows.some(r => r.bank_code === '9999') && o3.rows.some(r => r.bank_code === '0157' && r.branch_code === '051'),
    { みなとちゅうおう: keysOf(o1), だみーとうろく: keysOf(o2), ぎょうむとうかつ: keysOf(o3) });
  t0 = Date.now();
  const r1 = await search('みずほ まるのうち'), r2 = await search('まるのうち'), r3 = await search('みずほ 神田'), r4 = await search('みずほ'), r5 = await search('ちばこーぎー'), r6 = await search('ゆめ'), r7 = await search('0001-108');
  const tSearch = Date.now() - t0;
  ok('名前から探す（本物）: みずほ まるのうち＝2 店・まるのうち＝11 店・みずほ 神田＝2 店', r1.total === 2 && show(keysOf(r1)) === show(['0001-004', '0001-005'])
    && r2.total === 11 && r3.total === 2 && show(keysOf(r3)) === show(['0001-009', '0001-108']) && r4.rows.length === 30 && r4.total > 30 && r7.total === 1,
    { まるのうち: keysOf(r2), みずほ: r4.total, ちばこーぎー: r5.rows.map(r => [r.bank_code + '-' + r.branch_code, r.bank_name, r.branch_name]), ゆめ: r6.total, 七回の_ms: tSearch });
  const lk = await T.all('select * from bank_branch_lookup(array(select jsonb_array_elements_text($1::text::jsonb)))', [JSON.stringify(['0001-108', '0001-999', '1688-011', '2681-011'])]);
  info('コードから名前を引く（本物）', lk.map(r => [r.k, r.bank_name, r.branch_name, r.abolished]));

  if (ACCOUNTS) {
    if (ABOLISH) {
      const drop = new Set(JSON.parse(fs.readFileSync(ABOLISH, 'utf8')).only_tera.map(x => x[0] + '-' + x[1]));
      const run3 = await T.newRun('latest', today, 'zengin');
      await T.stage(run3, parsed.rows.filter(r => !drop.has(r.bank_code + '-' + r.branch_code)).map(r => codeOnly(r)));
      const p3 = (await T.preview(run3)).problem || '';
      const ap3 = await T.apply(run3, true);
      const st3 = await T.state();
      ok(`廃止の印を付ける（渡した ${drop.size} 店）: そのままでは止まり、確かめ済みで通る`, p3.includes('5% を超える') && ap3['店:廃止'] === drop.size && st3.abolished_branches === drop.size
        && st3.branches === parsed.rows.length, { ap3 });
      const out3 = await exportBytes();
      ok('廃止の印を付けたあとも、書き出しは元の CSV と 1 バイトも違わない（廃止の店も入る・名前と所在地は変わらない）', Buffer.compare(Buffer.from(out3.bytes), raw) === 0);
      const a1 = await search('まるのうち'), a2 = await search('まるのうち', true);
      ok('名前から探す（廃止の印のあと）: まるのうち＝廃止を出さなければ 10 店・出せば 11 店（うち廃止 1 店）', a1.total === 10 && a2.total === 11 && a2.rows.filter(r => r.abolished).length === 1,
        { 廃止の店: a2.rows.filter(r => r.abolished).map(r => [r.bank_code + '-' + r.branch_code, r.bank_name, r.branch_name]) });
      t0 = Date.now();
      const lv = await T.all('select * from bank_master_log_view(50)');
      const lvAll = await T.all('select * from bank_master_log_view(500)');
      const stS = (await T.one(`select bank_master_state('2000-01-01'::timestamptz) as j`)).j;
      info('変更の記録（廃止の印のあと・画面の形）', { 先頭の_50_行のうち銀行の行: lv.filter(r => r.target === '銀行').length, 全部で_500_行まで: lvAll.length, 元の記録の行: await T.count('bank_master_log'),
        例: lv.slice(0, 3).map(r => [r.kind, r.target, r.bank_code, r.branch_code, r.bank_name, r.stores === null ? null : Number(r.stores)]), 変わった数: stS.changes_since, ms: Date.now() - t0 });
    }
    const chk = await T.all('select reason, is_suspended, count(*)::int n from v_bank_account_check group by 1, 2 order by 2, 1');
    info('口座の点検（本番の口座の写し）', chk.map(c => [c.is_suspended ? '停止' : '有効', c.reason, c.n]));
    const nChk = await T.count('v_bank_account_check');
    // 入力の点検と一覧が同じ答えになること: 一覧に無い口座は同じコードで入れ直せる・一覧にある口座は入れ直せない
    const e1 = await T.err(`insert into bank_account(company_id, priority, bank_name, bank_code, branch_code, payment_method)
      select a.company_id, a.priority + 100, a.bank_name, a.bank_code, a.branch_code, a.payment_method from bank_account a
       where not exists (select 1 from v_bank_account_check k where k.account_id = a.account_id)`);
    let stopped = 0;
    const bad = await T.all('select account_id from v_bank_account_check');
    for (const b of bad) {
      const e = await T.err(`insert into bank_account(company_id, priority, bank_name, bank_code, branch_code, payment_method)
        select a.company_id, a.priority + 200, a.bank_name, a.bank_code, a.branch_code, a.payment_method from bank_account a where a.account_id = $1`, [b.account_id]);
      if (e) stopped++;
    }
    ok(`入力の点検と一覧が同じ答え: 一覧に無い ${accounts.length - nChk} 件は同じコードで入れ直せる・一覧の ${nChk} 件は止まる`,
      e1 === null && (await T.count('bank_account', 'priority >= 100 and priority < 200')) === accounts.length - nChk && stopped === nChk, e1);
    const renamed = await T.one(`select count(*)::int n, count(*) filter (where not c.is_suspended)::int active from bank_account a join bank_account b
      on b.company_id = a.company_id and b.priority = a.priority + 100 join company c on c.company_id = a.company_id where a.priority < 100 and a.bank_name is distinct from b.bank_name`);
    info('入れ直すと銀行名が銀行マスタの名前に置き換わる口座', { 全部: renamed.n, 有効な会社: renamed.active });
  }
  await pg.close();
}

console.log(fails ? `\n${fails} 件 FAIL` : '\nALL OK');
process.exit(fails ? 1 : 0);
