/* ============================================================================
 * pet-embed.js — 統合管理ツールに住むペット兼エージェント「ピー」（1体）。
 *
 * 起動条件＝ログイン済み全ユーザー（2026-07-15 社長判断で全社開放・PILOT_ROLES=null）。未ログインはno-op。
 *   パイロットに戻す場合は PILOT_ROLES にロール配列（例 ['admin','editor']）を設定する。
 * デフォルト画像＝assets/pet/pii_front.png（未配置なら仮の代替SVGを表示）。
 *
 * 仕様（すべてツール内で完結）：
 *   ・1体（キャラ選択なし）。名前・画像・サイズをツール上の設定パネルで変更。
 *   ・画像は「アップロード（端末から選ぶ→220pxに縮小・静止画）」か「デフォルトに戻す」。
 *   ・名前/画像/サイズ/非表示は本番Supabaseの user_pets に本人だけ保存(RLS)＝1人1匹・別端末でも引継ぐ。
 *   ・× で恒久非表示→右下ハンドルで復帰。サイズはスライダー＋つまみ(⤡)。本体はドラッグで移動。
 * ========================================================================== */
(function () {
  'use strict';
  try {
    // 起動条件はファイル末尾でゲート＝「ログイン済み かつ admin」のときだけ表示（パイロット）。
    // 設定・画像は本番Supabaseの user_pets に本人だけ読み書き（RLS）＝1人1匹。
    var PILOT_ROLES = null;   // null/[]＝全ログインユーザーに開放（2026-07-15全社展開）。パイロットに戻すにはロール配列を設定
    // ツールの認証済みSyncを参照（sync.js の Sync はトップレベル const＝window に載らない）
    function SYNC() { return (typeof Sync !== 'undefined') ? Sync : window.Sync; }

    var DEFAULT_IMG = 'assets/pet/pii_front.png';   // 透過済み・3Dピー正面（静止画・ヘルメットb＋りんご）
    // デフォルト画像が未配置(404)のときの仮の代替（やさしい青の雫）
    var FALLBACK_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">' +
      '<defs><radialGradient id="g" cx="40%" cy="35%"><stop offset="0%" stop-color="#a5b4fc"/>' +
      '<stop offset="100%" stop-color="#6366f1"/></radialGradient></defs>' +
      '<path d="M60 12 C82 40 96 60 96 80 a36 36 0 1 1 -72 0 C24 60 38 40 60 12 Z" fill="url(#g)"/>' +
      '<circle cx="48" cy="78" r="6" fill="#fff"/><circle cx="72" cy="78" r="6" fill="#fff"/>' +
      '<circle cx="48" cy="79" r="3" fill="#1e293b"/><circle cx="72" cy="79" r="3" fill="#1e293b"/>' +
      '<path d="M50 92 Q60 100 70 92" stroke="#1e293b" stroke-width="3" fill="none" stroke-linecap="round"/></svg>'
    );

    var BASE_H = 100;            // 倍率1.0のときの表示高さ(px)
    var SMIN = 0.5, SMAX = 2.5;
    var LINES = [
      'やっほー、ここにいるよ。', 'おつかれさま。ひと息どうぞ。', '水分とった？',
      '配置の画面、見てるね。', '資格の期限、ちゃんと見張ってるよ。', '見込み案件、増えてきた？',
      '深呼吸〜。すーっ、はーっ。', '困ったら呼んでね。', 'むりしないでね。',
    ];

    var state = { name: 'ピーちゃん', image: null, scale: 1, hidden: false }; // image:null → デフォルト画像 / hidden:恒久非表示
    var els = {};

    // ---------- スタイル ----------
    function injectStyle() {
      var css =
        '#bpet{position:fixed;right:22px;bottom:22px;z-index:2147483000;display:flex;flex-direction:column;' +
        'align-items:center;gap:6px;cursor:grab;touch-action:none;font-family:-apple-system,"Segoe UI","Yu Gothic UI",sans-serif;}' +
        '#bpet.dragging{cursor:grabbing;}' +
        '#bpet-bubble{max-width:210px;opacity:0;transform:translateY(6px);transition:.25s;background:#fff;color:#334155;' +
        'border:1.5px solid #cbd5e1;border-radius:13px;padding:8px 11px;font-size:13px;line-height:1.5;text-align:center;' +
        'pointer-events:none;box-shadow:0 6px 16px rgba(15,23,42,.18);position:relative;}' +
        '#bpet-bubble.show{opacity:1;transform:translateY(0);}' +
        '#bpet-bubble::after{content:"";position:absolute;left:50%;bottom:-9px;transform:translateX(-50%);' +
        'border:8px solid transparent;border-top-color:#fff;}' +
        '#bpet-wrap{position:relative;display:inline-block;line-height:0;}' +
        '#bpet-img{height:100px;width:auto;object-fit:contain;pointer-events:none;' +
        'filter:drop-shadow(0 8px 10px rgba(15,23,42,.22));animation:bpetbreathe 2.8s ease-in-out infinite;}' +
        '@keyframes bpetbreathe{0%,100%{transform:translateY(0) scaleY(1);}50%{transform:translateY(-6px) scaleY(1.02);}}' +
        '#bpet-name{font-size:12px;font-weight:700;color:#334155;background:rgba(255,255,255,.85);padding:1px 10px;' +
        'border-radius:999px;box-shadow:0 2px 5px rgba(15,23,42,.12);}' +
        '.bpet-mini{position:absolute;width:22px;height:22px;border:none;border-radius:50%;color:#fff;font-size:12px;' +
        'cursor:pointer;line-height:22px;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.3);z-index:2;}' +
        '#bpet-gear{top:-6px;left:-6px;background:#4f46e5;}' +
        '#bpet-close{top:-6px;right:-6px;background:#94a3b8;}' +
        '#bpet-alert{position:absolute;top:-6px;right:24px;min-width:22px;height:22px;padding:0 5px;display:none;' +
        'align-items:center;justify-content:center;border:none;border-radius:999px;background:#dc2626;color:#fff;' +
        'font-size:11px;font-weight:700;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35);z-index:2;}' +
        '#bpet-resize{right:-6px;bottom:-2px;width:26px;height:26px;border-radius:50%;background:#4f46e5;color:#fff;' +
        'font-size:13px;display:flex;align-items:center;justify-content:center;cursor:nwse-resize;touch-action:none;' +
        'box-shadow:0 2px 6px rgba(15,23,42,.3);position:absolute;z-index:2;}' +
        /* 歯車・×・伸縮はマウスホバー時（または操作中）のみ表示。通知バッジ(#bpet-alert)は対象外＝件数>0で常時表示 */
        '#bpet-gear,#bpet-close,#bpet-resize{opacity:0;visibility:hidden;transition:opacity .15s ease;}' +
        '#bpet:hover #bpet-gear,#bpet:hover #bpet-close,#bpet:hover #bpet-resize,' +
        '#bpet.dragging #bpet-gear,#bpet.dragging #bpet-close,#bpet.dragging #bpet-resize,' +
        '#bpet.bpet-active #bpet-gear,#bpet.bpet-active #bpet-close,#bpet.bpet-active #bpet-resize{opacity:1;visibility:visible;}' +
        /* 恒久非表示中に出す再表示ハンドル */
        '#bpet-handle{position:fixed;right:18px;bottom:18px;width:46px;height:46px;border-radius:50%;border:none;' +
        'cursor:pointer;z-index:2147483000;background:#fff;box-shadow:0 4px 12px rgba(15,23,42,.28);' +
        'display:none;align-items:center;justify-content:center;padding:0;overflow:hidden;opacity:.85;transition:opacity .15s,transform .15s;}' +
        '#bpet-handle.show{display:flex;}' +
        '#bpet-handle:hover{opacity:1;transform:scale(1.08);}' +
        '#bpet-handle img{width:36px;height:36px;object-fit:contain;pointer-events:none;}' +
        /* 設定モーダル */
        '#bpet-modal{position:fixed;inset:0;z-index:2147483001;display:none;align-items:center;justify-content:center;' +
        'background:rgba(15,23,42,.45);padding:16px;font-family:-apple-system,"Segoe UI","Yu Gothic UI",sans-serif;}' +
        '#bpet-modal.show{display:flex;}' +
        '#bpet-card{background:#fff;border-radius:18px;width:100%;max-width:340px;padding:20px;box-shadow:0 20px 50px rgba(15,23,42,.3);}' +
        '#bpet-card h2{margin:0 0 14px;font-size:17px;color:#1e293b;}' +
        '.bpet-f{margin-bottom:16px;}' +
        '.bpet-f label{display:block;font-size:12px;color:#64748b;margin-bottom:6px;}' +
        '.bpet-f input[type=text]{width:100%;padding:10px 12px;font-size:16px;border:1.5px solid #cbd5e1;border-radius:10px;outline:none;}' +
        '.bpet-f input[type=text]:focus{border-color:#6366f1;}' +
        '.bpet-f input[type=range]{width:100%;accent-color:#4f46e5;}' +
        '.bpet-imgrow{display:flex;align-items:center;gap:12px;}' +
        '#bpet-preview{width:64px;height:64px;object-fit:contain;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;}' +
        '.bpet-btns{display:flex;flex-direction:column;gap:6px;flex:1;}' +
        '.bpet-btn{padding:8px 10px;border-radius:9px;font-size:13px;font-weight:600;border:1px solid #cbd5e1;background:#fff;color:#334155;cursor:pointer;}' +
        '.bpet-btn.primary{background:#4f46e5;color:#fff;border:none;}' +
        '.bpet-val{color:#4f46e5;font-weight:700;}' +
        '.bpet-actions{display:flex;gap:10px;margin-top:6px;}' +
        '.bpet-actions button{flex:1;padding:11px;border-radius:10px;font-size:15px;font-weight:600;border:none;cursor:pointer;}' +
        '#bpet-cancel{background:#f1f5f9;color:#475569;}#bpet-save{background:#4f46e5;color:#fff;}';
      var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    }

    // ---------- DOM ----------
    function buildDom() {
      var pet = document.createElement('div');
      pet.id = 'bpet';
      pet.innerHTML =
        '<button id="bpet-gear" class="bpet-mini" title="設定">⚙</button>' +
        '<button id="bpet-close" class="bpet-mini" title="閉じる">×</button>' +
        '<button id="bpet-alert" title="お知らせを読み上げ"></button>' +
        '<div id="bpet-bubble"></div>' +
        '<div id="bpet-wrap"><img id="bpet-img" alt="pet"><div id="bpet-resize" title="ドラッグで大きさ変更">⤡</div></div>' +
        '<div id="bpet-name"></div>';
      document.body.appendChild(pet);

      var modal = document.createElement('div');
      modal.id = 'bpet-modal';
      modal.innerHTML =
        '<div id="bpet-card">' +
          '<h2>ペットの設定</h2>' +
          '<div class="bpet-f"><label>なまえ</label><input id="bpet-nameinput" type="text" maxlength="20" placeholder="例：ピーちゃん"></div>' +
          '<div class="bpet-f"><label>画像</label><div class="bpet-imgrow">' +
            '<img id="bpet-preview" alt="preview">' +
            '<div class="bpet-btns">' +
              '<button class="bpet-btn primary" id="bpet-upload">画像をアップロード</button>' +
              '<button class="bpet-btn" id="bpet-usedefault">デフォルトに戻す</button>' +
            '</div>' +
            '<input id="bpet-file" type="file" accept="image/*" style="display:none">' +
          '</div></div>' +
          '<div class="bpet-f"><label>おおきさ <span id="bpet-sizeval" class="bpet-val">100%</span></label>' +
            '<input id="bpet-size" type="range" min="0.5" max="2.5" step="0.05" value="1"></div>' +
          '<div class="bpet-actions"><button id="bpet-cancel">キャンセル</button><button id="bpet-save">保存</button></div>' +
        '</div>';
      document.body.appendChild(modal);

      els = {
        pet: pet, img: document.getElementById('bpet-img'), name: document.getElementById('bpet-name'),
        bubble: document.getElementById('bpet-bubble'), modal: modal,
        nameInput: document.getElementById('bpet-nameinput'), preview: document.getElementById('bpet-preview'),
        file: document.getElementById('bpet-file'), size: document.getElementById('bpet-size'),
        sizeVal: document.getElementById('bpet-sizeval'), alert: document.getElementById('bpet-alert'),
      };
    }

    // ---------- 表示適用 ----------
    function imgSrc() { return state.image || DEFAULT_IMG; }
    function applyImage() {
      els.img.onerror = function () { els.img.onerror = null; els.img.src = FALLBACK_SVG; };
      els.img.src = imgSrc();
    }
    function applyScale(s) {
      s = Math.max(SMIN, Math.min(SMAX, Math.round(s * 100) / 100));
      state.scale = s;
      els.img.style.height = (BASE_H * s) + 'px';
      if (els.sizeVal) els.sizeVal.textContent = Math.round(s * 100) + '%';
      if (els.size && document.activeElement !== els.size) els.size.value = s;
    }
    function applyName() { els.name.textContent = state.name; }

    // ---------- 吹き出し ----------
    var hideT;
    function say(t) { els.bubble.textContent = t; els.bubble.classList.add('show'); clearTimeout(hideT); hideT = setTimeout(function () { els.bubble.classList.remove('show'); }, 6000); }
    function talkLoop() {
      setTimeout(function () {
        // 実データのお知らせがあるときは 4割の確率でそちらを話す
        if (alerts.lines.length && Math.random() < 0.4) sayNextAlert(false);
        else say(LINES[Math.floor(Math.random() * LINES.length)]);
        talkLoop();
      }, 18000 + Math.random() * 32000);
    }

    // ---------- 実データ通知（ツールが読み込んだ Sync.cache を読むだけ・書き込みなし） ----------
    // 判定はツール本体と同じ Sync.isExpiryTracked / Sync.qualExpiryStatus を再利用＝ダッシュボードと一致。
    var alerts = { lines: [], idx: 0, badge: 0, summary: '', key: '' };
    // 既読の通知内容（署名）。全件読み終えたら記録し、内容が変わるまでバッジを出さない。
    var ackKey = '';
    try { ackKey = localStorage.getItem('bpet_ack_alerts') || ''; } catch (e) {}

    function parseYmd(s) {
      var m = String(s || '').trim().replace(/-/g, '/').split('/');
      if (m.length !== 3) return null;
      var dt = new Date(+m[0], +m[1] - 1, +m[2]);
      return isNaN(dt.getTime()) ? null : dt;
    }

    function collectAlerts() {
      // sync.js の Sync はトップレベル const＝window に載らないため typeof で参照
      var S = (typeof Sync !== 'undefined') ? Sync : window.Sync;
      if (!S || !S.cache || !Array.isArray(S.cache.employees) || !S.cache.employees.length ||
          typeof S.qualExpiryStatus !== 'function' || typeof S.isExpiryTracked !== 'function') return false;

      // 1) 資格期限（アラート対象資格のみ）
      var expired = [], warn30 = [], warn90 = [];
      S.cache.employees.forEach(function (e) {
        (e.qual_details || []).forEach(function (q) {
          if (!S.isExpiryTracked(q.name)) return;
          var st = S.qualExpiryStatus(q.expiry);
          var item = { emp: e.name, qual: q.name, days: st.days };
          if (st.status === 'expired') expired.push(item);
          else if (st.status === 'warn30') warn30.push(item);
          else if (st.status === 'warn90') warn90.push(item);
        });
      });
      var byDays = function (a, b) { return a.days - b.days; };
      expired.sort(byDays); warn30.sort(byDays); warn90.sort(byDays);

      // 2) 配置未定・不足（完成済み・終了日が過去の案件は除外＝現役のみ）
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var phByPid = {};
      (S.cache.assignments || []).forEach(function (a) {
        if (String(a.emp_name || '').trim() === '配置未定・不足') {
          phByPid[a.project_id] = (phByPid[a.project_id] || 0) + 1;
        }
      });
      var shortage = [];
      (S.cache.projects || []).forEach(function (p) {
        var cnt = phByPid[p.project_id];
        if (!cnt || p.completed) return;
        var end = parseYmd(p.end);
        if (end && end < today) return;
        shortage.push({ name: p.name, count: cnt });
      });

      var lines = [];
      expired.forEach(function (i) { lines.push('⚠ ' + i.emp + 'さんの「' + i.qual + '」が期限切れだよ（' + (-i.days) + '日経過）'); });
      warn30.forEach(function (i) { lines.push('⏰ ' + i.emp + 'さんの「' + i.qual + '」、期限まであと' + i.days + '日だよ'); });
      shortage.forEach(function (i) { lines.push('🔧 「' + i.name + '」が配置未定・不足' + (i.count > 1 ? '×' + i.count : '') + 'だよ'); });
      warn90.forEach(function (i) { lines.push('📅 ' + i.emp + 'さんの「' + i.qual + '」、あと' + i.days + '日（90日以内）'); });

      alerts.lines = lines;
      alerts.badge = expired.length + warn30.length + shortage.length;  // 90日以内はバッジに数えない
      // 通知内容の署名（日数は含めず emp|資格・現場|件数で安定化＝同じ内容なら既読を維持）
      var newKey = expired.map(function (i) { return 'E' + i.emp + '|' + i.qual; })
        .concat(warn30.map(function (i) { return 'W' + i.emp + '|' + i.qual; }))
        .concat(shortage.map(function (i) { return 'S' + i.name + '|' + i.count; })).join('#');
      if (newKey !== alerts.key) { alerts.idx = 0; alerts.key = newKey; }  // 内容が変わったら読み位置リセット
      var parts = [];
      if (expired.length) parts.push('期限切れ' + expired.length + '件');
      if (warn30.length) parts.push('30日以内' + warn30.length + '件');
      if (shortage.length) parts.push('配置未定' + shortage.length + '件');
      alerts.summary = alerts.badge
        ? 'きょうのお知らせ：' + parts.join('・') + '。私をタップすると1件ずつ教えるね。'
        : '資格期限も配置も、いまは問題なさそう！';
      return true;
    }

    function updateBadge() {
      if (!els.alert) return;
      var show = alerts.badge > 0 && alerts.key !== ackKey;  // 既読(同一内容)なら出さない
      els.alert.textContent = alerts.badge > 99 ? '99+' : String(alerts.badge);
      els.alert.style.display = show ? 'flex' : 'none';
    }

    // refresh=true で最新データに更新してから話す（タップ時）。アラート0件なら平常メッセージ。
    function sayNextAlert(refresh) {
      if (refresh) { collectAlerts(); updateBadge(); }
      if (!alerts.lines.length) { say('いまは知らせることないよ。順調順調！'); return; }
      say(alerts.lines[alerts.idx % alerts.lines.length]);
      alerts.idx++;
      // タップ操作で件数分を読み終えたら既読化＝バッジを消す（同じ内容のうちは再表示しない）
      if (refresh && alerts.badge > 0 && alerts.idx >= alerts.badge) {
        ackKey = alerts.key;
        try { localStorage.setItem('bpet_ack_alerts', ackKey); } catch (e) {}
        updateBadge();
      }
    }

    // データ読込待ち→初回サマリー→以後5分ごとに再計算
    function watchAlerts() {
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        if (collectAlerts()) {
          clearInterval(t);
          updateBadge();
          setTimeout(function () { say(alerts.summary); }, 1200);
          setInterval(function () { collectAlerts(); updateBadge(); }, 5 * 60 * 1000);
        } else if (tries > 60) { clearInterval(t); }  // 2分待ってもデータ無し（未ログイン等）なら諦める
      }, 2000);
    }

    // ---------- Supabase 保存/読込（本番・認証済みセッション＝本人の user_pets 行のみ・RLS） ----------
    // 学習用anonクライアントは廃止。ツールのログインセッション(Sync)を使う＝1人1匹・他人の設定は触れない。
    function petClient() {
      var S = SYNC();
      if (!S || typeof S.getSupabase !== 'function' || !S.userId) return null;
      return { sb: S.getSupabase(), uid: S.userId };
    }
    function loadConfig() {
      var c = petClient(); if (!c) return;
      c.sb.from('user_pets').select('*').eq('user_id', c.uid).limit(1)
        .then(function (res) {
          if (res && res.data && res.data[0]) {
            var r = res.data[0];
            state.name = r.pet_name || state.name;
            state.image = r.image_data || null;
            var sc = parseFloat(r.scale); if (!isNaN(sc)) state.scale = sc;
            state.hidden = !!r.hidden;
            try { localStorage.setItem('bpet_hidden', state.hidden ? '1' : '0'); } catch (e) {}
          }
        }).catch(function () {}).then(function () { applyName(); applyImage(); applyScale(state.scale); applyHidden(); });
    }
    function saveConfig() {
      var c = petClient(); if (!c) return Promise.reject(new Error('ログインが必要です'));
      return c.sb.from('user_pets').upsert({
        user_id: c.uid, pet_name: state.name, image_data: state.image, scale: String(state.scale),
        hidden: !!state.hidden, updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' }).then(function (res) { if (res.error) throw new Error(res.error.message); return true; });
    }
    // サイズ変更の保存（リサイズ用）。本人の行のみなので state 全体を upsert で安全に保存。
    function saveScaleOnly() { return saveConfig(); }

    // ---------- 画像縮小 ----------
    function downscale(file, maxDim, cb) {
      var img = new Image(); var url = URL.createObjectURL(file);
      img.onload = function () {
        var w = img.width, h = img.height, sc = Math.min(1, maxDim / Math.max(w, h));
        var cw = Math.round(w * sc), ch = Math.round(h * sc);
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        try { cb(c.toDataURL('image/png')); } catch (e) { cb(null); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
      img.src = url;
    }

    // ---------- 設定モーダル ----------
    function openSettings() {
      els.nameInput.value = state.name;
      els.preview.onerror = function () { els.preview.onerror = null; els.preview.src = FALLBACK_SVG; };
      els.preview.src = imgSrc();
      els.size.value = state.scale; els.sizeVal.textContent = Math.round(state.scale * 100) + '%';
      els._pendingImage = undefined; // 未確定のアップロード画像
      els.modal.classList.add('show');
    }
    function closeSettings() { els.modal.classList.remove('show'); applyScale(state.scale); }

    function wireSettings() {
      document.getElementById('bpet-gear').addEventListener('click', function (e) { e.stopPropagation(); openSettings(); });
      document.getElementById('bpet-cancel').addEventListener('click', closeSettings);
      document.getElementById('bpet-upload').addEventListener('click', function () { els.file.click(); });
      document.getElementById('bpet-usedefault').addEventListener('click', function () {
        els._pendingImage = null; els.preview.onerror = function () { els.preview.onerror = null; els.preview.src = FALLBACK_SVG; }; els.preview.src = DEFAULT_IMG;
      });
      els.file.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0]; if (!f) return;
        downscale(f, 220, function (dataUrl) {
          if (!dataUrl) { alert('画像の読み込みに失敗しました'); return; }
          els._pendingImage = dataUrl; els.preview.src = dataUrl;
        });
      });
      // ライブプレビュー：スライダーで本体サイズも即変更
      els.size.addEventListener('input', function (e) { applyScale(parseFloat(e.target.value)); });
      document.getElementById('bpet-save').addEventListener('click', function () {
        var btn = this; btn.disabled = true; btn.textContent = '保存中…';
        state.name = (els.nameInput.value || '').trim() || 'ピーちゃん';
        if (els._pendingImage !== undefined) state.image = els._pendingImage; // null=デフォルト/ dataUrl=カスタム
        state.scale = parseFloat(els.size.value);
        applyName(); applyImage(); applyScale(state.scale);
        saveConfig().then(function () { say('よろしくね、' + state.name + 'だよ！'); closeSettings(); })
          .catch(function (err) { alert('保存に失敗：' + (err.message || err) + '\n（pet_config に image_data/scale 列が必要。SQLを実行してね）'); })
          .then(function () { btn.disabled = false; btn.textContent = '保存'; });
      });
    }

    // ---------- 移動＆リサイズ（Pointer Events）----------
    function wirePointer() {
      var pet = els.pet, mode = null, sx = 0, sy = 0, ox = 0, oy = 0, startScale = 1;
      var pos = JSON.parse(localStorage.getItem('bpet_pos') || 'null');
      if (pos) { pet.style.right = 'auto'; pet.style.bottom = 'auto'; pet.style.left = pos.x + 'px'; pet.style.top = pos.y + 'px'; }
      pet.addEventListener('pointerdown', function (e) {
        if (e.target.id === 'bpet-gear' || e.target.id === 'bpet-close' || e.target.id === 'bpet-alert') return;
        sx = e.clientX; sy = e.clientY;
        if (e.target.id === 'bpet-resize') { mode = 'resize'; startScale = state.scale; }
        else { mode = 'move'; var r = pet.getBoundingClientRect(); ox = r.left; oy = r.top; pet.classList.add('dragging'); }
        pet.classList.add('bpet-active');  // 操作中はボタン類を表示し続ける（ホバー外れ対策）
        try { pet.setPointerCapture(e.pointerId); } catch (_) {}
      });
      pet.addEventListener('pointermove', function (e) {
        if (!mode) return;
        if (mode === 'move') {
          var nx = Math.max(0, Math.min(window.innerWidth - pet.offsetWidth, ox + (e.clientX - sx)));
          var ny = Math.max(0, Math.min(window.innerHeight - pet.offsetHeight, oy + (e.clientY - sy)));
          pet.style.right = 'auto'; pet.style.bottom = 'auto'; pet.style.left = nx + 'px'; pet.style.top = ny + 'px';
        } else {
          applyScale(startScale + ((e.clientX - sx) + (e.clientY - sy)) / 2 * 0.006);
        }
      });
      pet.addEventListener('pointerup', function (e) {
        if (mode === 'move') {
          pet.classList.remove('dragging');
          var dist = Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy);
          if (dist < 6) { sayNextAlert(true); }  // ほぼ動いていない＝タップ → お知らせ読み上げ
          else { var r = pet.getBoundingClientRect(); localStorage.setItem('bpet_pos', JSON.stringify({ x: r.left, y: r.top })); }
        }
        else if (mode === 'resize') { saveScaleOnly().catch(function () {}); } // サイズだけ保存（名前を巻き込まない）
        mode = null;
        pet.classList.remove('bpet-active');
        try { pet.releasePointerCapture(e.pointerId); } catch (_) {}
      });
      els.alert.addEventListener('click', function (e) { e.stopPropagation(); sayNextAlert(true); });
      document.getElementById('bpet-close').addEventListener('click', hidePermanently);
    }

    // ---------- 恒久非表示 / 再表示ハンドル ----------
    function buildHandle() {
      if (els.handle) return els.handle;
      var h = document.createElement('button');
      h.id = 'bpet-handle'; h.title = 'ペットを表示';
      var im = document.createElement('img');
      im.onerror = function () { im.onerror = null; im.src = FALLBACK_SVG; };
      im.src = imgSrc();
      h.appendChild(im);
      h.addEventListener('click', showFromHandle);
      document.body.appendChild(h);
      els.handle = h;
      return h;
    }
    function applyHidden() {
      if (state.hidden) {
        if (els.pet) els.pet.style.display = 'none';
        buildHandle();
        var im = els.handle.querySelector('img'); if (im) im.src = imgSrc();
        els.handle.classList.add('show');
      } else {
        if (els.handle) els.handle.classList.remove('show');
        if (els.pet) els.pet.style.display = '';
      }
    }
    function hidePermanently() {
      if (!confirm('ピーを今後表示しません。\n（右下に出る小さなアイコンからいつでも戻せます）\nよろしいですか？')) return;
      state.hidden = true;
      try { localStorage.setItem('bpet_hidden', '1'); } catch (e) {}
      try { if (els.modal) els.modal.classList.remove('show'); } catch (e) {}
      applyHidden();
      saveConfig().catch(function () {});
    }
    function showFromHandle() {
      state.hidden = false;
      try { localStorage.setItem('bpet_hidden', '0'); } catch (e) {}
      applyHidden();
      saveConfig().catch(function () {});
    }

    // ---------- 起動 ----------
    function start() {
      injectStyle(); buildDom(); wireSettings(); wirePointer();
      try { state.hidden = localStorage.getItem('bpet_hidden') === '1'; } catch (e) {}  // 初期ヒント（DBで上書き）
      applyName(); applyImage(); applyScale(state.scale);
      applyHidden();
      loadConfig();
      setTimeout(function () { if (!state.hidden) say('やあ、' + state.name + 'だよ。ツールの中にいるよ！'); }, 1000);
      talkLoop();
      watchAlerts();
    }

    // ---------- 起動ゲート（ログイン後＋admin限定パイロット） ----------
    var started = false;
    function loginOk() {
      var S = SYNC();
      if (!S || !S.userId) return false;                         // 未ログインは出さない
      if (!PILOT_ROLES || !PILOT_ROLES.length) return true;      // 全社開放モード
      return PILOT_ROLES.indexOf(S.role) !== -1;                 // 指定ロールのみ（admin/editor 等）
    }
    function gate() {
      if (started) {
        // ログアウト等でセッションが切れたらペットを撤去
        var S = SYNC();
        if (!S || !S.userId) {
          try { if (els.pet) els.pet.remove(); if (els.modal) els.modal.remove(); if (els.handle) els.handle.remove(); } catch (_) {}
          els = {}; started = false;
        }
        return;
      }
      if (loginOk()) { started = true; start(); }
    }
    function boot() { setInterval(gate, 1500); gate(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  } catch (e) { console.info('pet-embed skipped:', e); }
})();
