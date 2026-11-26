/**
 * torihikisaki_bank_csv.js - 取引先マスタ 銀行マスタ：tera の「金融機関・店舗マスタ」の取込ファイルを読む・書く
 *   画面（銀行マスタの取込・書き出し）と、手元の試験（supabase/tests/bank_master.test.mjs）の両方が使う。DOM と Supabase には触らない。
 *   形式（経理の資料 2026-11-24 の 23 枚目）: Shift_JIS・見出し行なし・改行 CRLF・全項目を " で囲む・12 列・銀行コードと店コードの順。
 *   tera は取込ファイルに無い店を廃止にするので、書き出しはいつも全件（廃止の店も入れる）。
 *   実データなし（列の定義と変換だけ）。
 */
const TorihikisakiBankCsv = {
  // 列の並びと tera の桁（字の数で見る）。key は DB の v_bank_branch の列名
  COLS: [
    { key: 'bank_code', label: '金融機関コード', max: 4 },
    { key: 'branch_code', label: '店舗コード', max: 3 },
    { key: 'bank_kana', label: '金融機関名称（カナ）', max: 30 },
    { key: 'bank_name', label: '金融機関名称', max: 46 },
    { key: 'branch_kana', label: '店舗名称（カナ）', max: 20 },
    { key: 'branch_name', label: '店舗名称', max: 30 },
    { key: 'postal_code', label: '郵便番号', max: 10 },
    { key: 'address', label: '店舗所在地', max: 110 },
    { key: 'phone', label: '電話番号', max: 17 },
    { key: 'clearing_no', label: '手形交換所番号', max: 4 },
    { key: 'sort_code', label: '並びコード', max: 1 },            // tera の決まりで全行「1」
    { key: 'zengin_member', label: '内国為替制度加盟', max: 1 },   // tera の決まりで全行「1」
  ],
  FIXED: { sort_code: '1', zengin_member: '1' },
  MAX_ERRORS: 50,
  _sjis: null,

  // 文字 → Shift_JIS のバイト の表。ブラウザには Shift_JIS へ書く口が無いので、読む口（TextDecoder）を全部の番号に当てて逆引きを作る。
  //   同じ字に番号が 2 つあるときは小さいほう。ただし NEC 選定 IBM 拡張（0xED・0xEE）は後回し＝ IBM 拡張（0xFA〜）を使う（Windows の変換と同じ）。
  sjisMap() {
    if (this._sjis) return this._sjis;
    const dec = new TextDecoder('shift_jis');
    const map = new Map();
    const put = (ch, bytes) => { if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, bytes); };
    for (let b = 0; b <= 0x7f; b++) put(String.fromCharCode(b), [b]);
    for (let b = 0xa1; b <= 0xdf; b++) put(dec.decode(Uint8Array.of(b)), [b]);
    const leads = [];
    for (let l = 0x81; l <= 0x9f; l++) leads.push(l);
    for (let l = 0xe0; l <= 0xfc; l++) if (l !== 0xed && l !== 0xee) leads.push(l);
    leads.push(0xed, 0xee);
    for (const l of leads) {
      for (let t = 0x40; t <= 0xfc; t++) {
        if (t !== 0x7f) put(dec.decode(Uint8Array.of(l, t)), [l, t]);
      }
    }
    this._sjis = map;
    return map;
  },

  // 文字列 → Shift_JIS。書けない字は bad に集めて返す（黙って ? にしない）
  encode(str) {
    const map = this.sjisMap();
    const out = new Uint8Array(str.length * 2);
    const bad = [];
    let n = 0;
    for (const ch of str) {
      const b = map.get(ch);
      if (!b) { if (bad.indexOf(ch) < 0) bad.push(ch); continue; }
      out[n++] = b[0];
      if (b.length === 2) out[n++] = b[1];
    }
    return { bytes: out.slice(0, n), bad };
  },

  // 行（COLS の key を持つもの）→ 取込ファイルの中身 { bytes, bad }。並びは銀行コード・店コードの順
  build(rows) {
    const k = (r) => String(r.bank_code) + String(r.branch_code);
    const sorted = rows.slice().sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = sorted.map(r => this.COLS.map(c => q(this.FIXED[c.key] !== undefined ? this.FIXED[c.key] : r[c.key])).join(','));
    return this.encode(lines.length ? lines.join('\r\n') + '\r\n' : '');
  },

  // CSV の文字列 → 行の配列（" で囲んだ項目・囲んでいない項目・CRLF／LF のどれも読む）
  splitCsv(text) {
    const recs = [];
    let rec = [], cur = '', inq = false, started = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inq) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inq = false; }
        else cur += ch;
      } else if (ch === '"') { inq = true; started = true; }
      else if (ch === ',') { rec.push(cur); cur = ''; started = true; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        if (started || cur !== '') { rec.push(cur); recs.push(rec); }
        rec = []; cur = ''; started = false;
      } else { cur += ch; started = true; }
    }
    if (started || cur !== '') { rec.push(cur); recs.push(rec); }
    return recs;
  },

  // 取込ファイルの中身（ArrayBuffer か Uint8Array）→ { rows, errors, errorCount }。
  //   rows は 10 項目（空の項目は null）。errors は「何行目の何が違うか」（先頭の MAX_ERRORS 件）。1 件でもあれば取り込まない。
  parse(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const fail = (message) => ({ rows: [], errors: [{ line: 0, message }], errorCount: 1 });
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return fail('UTF-8 の CSV です。tera の取込用の CSV（Shift_JIS）をそのまま選んでください');
    }
    let text;
    try { text = new TextDecoder('shift_jis', { fatal: true }).decode(bytes); }
    catch (e) { return fail('文字コードが Shift_JIS ではありません。tera の取込用の CSV をそのまま選んでください'); }
    const recs = this.splitCsv(text);
    if (!recs.length) return fail('行がありません');
    const map = this.sjisMap();
    const rows = [], errors = [];
    let errorCount = 0;
    const err = (line, message) => { errorCount++; if (errors.length < this.MAX_ERRORS) errors.push({ line, message }); };
    const seen = new Set(), bankOf = new Map();
    const oneByte = /^[\x20-\x7E｡-ﾟ]+$/;
    recs.forEach((rec, idx) => {
      const line = idx + 1;
      if (rec.length !== this.COLS.length) { err(line, `列の数が ${this.COLS.length} ではありません（${rec.length} 列）`); return; }
      const r = {};
      this.COLS.forEach((c, i) => { r[c.key] = rec[i]; });
      let bad = false;
      const ng = (message) => { bad = true; err(line, message); };
      if (!/^\d{4}$/.test(r.bank_code)) ng(`金融機関コード「${r.bank_code}」が 4 桁の数字ではありません（Excel で開いて保存すると先頭の 0 が落ちます）`);
      if (!/^\d{3}$/.test(r.branch_code)) ng(`店舗コード「${r.branch_code}」が 3 桁の数字ではありません（Excel で開いて保存すると先頭の 0 が落ちます）`);
      ['bank_kana', 'bank_name', 'branch_kana', 'branch_name'].forEach(key => {
        if (r[key] === '') ng(`${this.COLS.find(c => c.key === key).label}が空です`);
      });
      ['bank_kana', 'branch_kana'].forEach(key => {
        if (r[key] !== '' && !oneByte.test(r[key])) ng(`${this.COLS.find(c => c.key === key).label}「${r[key]}」に半角でない字があります`);
      });
      this.COLS.forEach(c => {
        const v = r[c.key];
        if (Array.from(v).length > c.max) ng(`${c.label}「${v}」が tera の ${c.max} 桁を超えています`);
        for (const ch of v) { if (!map.has(ch)) { ng(`${c.label}「${v}」に、Shift_JIS に無い字（${ch}）があります`); break; } }
      });
      if (bad) return;
      const key = r.bank_code + '-' + r.branch_code;
      if (seen.has(key)) { err(line, `${key} が 2 行あります`); return; }
      seen.add(key);
      const nm = r.bank_name + '\t' + r.bank_kana;
      if (bankOf.has(r.bank_code) && bankOf.get(r.bank_code) !== nm) {
        err(line, `金融機関コード ${r.bank_code} の銀行名かカナが、前の行と違います（${r.bank_name}）`);
        return;
      }
      bankOf.set(r.bank_code, nm);
      rows.push({
        bank_code: r.bank_code, branch_code: r.branch_code, bank_kana: r.bank_kana, bank_name: r.bank_name,
        branch_kana: r.branch_kana, branch_name: r.branch_name,
        postal_code: r.postal_code || null, address: r.address || null, phone: r.phone || null, clearing_no: r.clearing_no || null,
      });
    });
    return { rows: errorCount ? [] : rows, errors, errorCount };
  },

  // 行 ⇄ DB の口（bank_master_stage_rows・bank_master_export）でやり取りする 10 項目の配列（COLS の先頭 10 列の並び）
  toArray(r) { return this.COLS.slice(0, 10).map(c => (r[c.key] == null ? '' : String(r[c.key]))); },
  fromArray(a) { const r = {}; this.COLS.slice(0, 10).forEach((c, i) => { r[c.key] = a[i] == null ? '' : a[i]; }); return r; },

  // ファイル名に入っている日付 → 'YYYY-MM-DD'（…_261124_… や …_20261124… の形。読めなければ空）。取込の基準日の最初の値に使う
  dateFromName(name) {
    const s = String(name == null ? '' : name);
    const ok = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '');
    let m = s.match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?!\d)/);
    if (m && ok(m[1], +m[2], +m[3])) return ok(m[1], +m[2], +m[3]);
    m = s.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})(?!\d)/);
    return m ? ok('20' + m[1], +m[2], +m[3]) : '';
  },

  // ===== 探す言葉の整え（「名前から探す」。DB の bank_branch_search に渡す形にする）=====
  _KANA_FULL: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンヰヱ',
  _KANA_HALF: 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｲｴ',
  _KANA_SMALL: 'ァィゥェォッャュョヮヵヶ',
  _KANA_LARGE: 'アイウエオツヤユヨワカケ',

  // 全角の英数字 → 半角
  halfAlnum(s) {
    return String(s == null ? '' : s).replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  },

  // ひらがな・全角カナ・半角カナ → tera の書き方の半角カナ（小さいカナは大きく・長音は「-」・英字は大文字）。カナでない字はそのまま残る
  kana(s) {
    let t = String(s == null ? '' : s).normalize('NFKC');                               // 半角カナ → 全角カナ、全角の英数字 → 半角
    t = t.replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));       // ひらがな → カタカナ
    t = t.replace(/[ァィゥェォッャュョヮヵヶ]/g, ch => this._KANA_LARGE[this._KANA_SMALL.indexOf(ch)]);
    t = t.replace(/[ー‐‑–—―−]/g, '-');
    let out = '';
    for (const ch of t.normalize('NFD')) {                                               // 濁点・半濁点を分ける（ガ → カ＋゛）
      const i = this._KANA_FULL.indexOf(ch);
      if (i >= 0) out += this._KANA_HALF[i];
      else if (ch === '゙') out += 'ﾞ';
      else if (ch === '゚') out += 'ﾟ';
      else out += ch;
    }
    return out.toUpperCase();
  },

  // 探す言葉（空白で区切る・6 つまで）→ [{ t, k, c }]
  //   t＝名前で探す形（英数字は半角の大文字）／k＝カナで探す形（カナ・英数字だけの言葉のとき。漢字が入っていれば空）／
  //   c＝コードで探す形（3 桁＝支店コード・4 桁＝銀行コード・4 桁-3 桁 のとき。それ以外は空）
  searchTerms(q) {
    return String(q == null ? '' : q).split(/\s+/).filter(Boolean).slice(0, 6).map(w => {
      const half = this.halfAlnum(w);
      const kn = this.kana(w);
      const code = half.replace(/[－‐‑–—―−ー]/g, '-');
      return {
        t: half.toUpperCase(),
        k: /^[\x21-\x7Eｦ-ﾟ]+$/.test(kn) ? kn : '',
        c: /^(\d{3}|\d{4}|\d{4}-\d{3})$/.test(code) ? code : '',
      };
    });
  },
};
