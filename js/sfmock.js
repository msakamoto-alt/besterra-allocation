/**
 * sfmock.js — SF 案件・工事管理モックアップ（レビュー用）の画面。
 *
 * 見た目＝dev6 の実物を撮った画像。目次（どの工事のどの画面か・クリックできる場所）は manifest.json。
 *   → dev6 を直したら撮り直して入れ替えるだけで共有版も追随する
 *     （SF リポジトリの scripts/mockup/run_capture.js で撮る → このページの「画面を入れ替え」か publish.py で上げる）
 *
 * 🔴 画像と目次は GitHub（公開リポジトリ）には置かない。Supabase の**非公開バケット sfmock**に置き、
 *    ログイン済みの人にだけ署名付き URL で配る（工事名・取引先・金額・氏名が入るため）。
 *
 * コメント＝Supabase の sf_mock_comments（同時に何人でも。Realtime で相手のコメントが即座に出る）。
 * 認証＝統合管理ツールと同じ（同一オリジンなのでログイン状態を共有する）。
 */
(function () {
  'use strict';

  const BUCKET = 'sfmock';
  const SIGN_SEC = 3600;
  const $ = (id) => document.getElementById(id);

  const S = {
    sb: null,
    manifest: null,
    byId: {},
    projKey: null,
    screenId: null,
    comments: [],
    user: null,
    scope: 'this',
    openOnly: false,
    commenting: false,
    showHot: false,
    fitWidth: true,
    activeRoot: null,
    tableReady: true,
    urlCache: new Map()
  };

  // ===== 小物 =====
  function toast(msg, ms) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms || 3200);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return d.toDateString() === now.toDateString() ? '今日 ' + hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  // ===== 認証（統合管理ツールと同じ Supabase・同一オリジンでセッション共有）=====
  async function initSupabase() {
    if (!window.Sync || !Sync.SUPABASE_URL || !Sync.SUPABASE_ANON_KEY) {
      alert('Supabase の接続設定（js/config.js）が読めませんでした。管理者へご連絡ください。');
      throw new Error('no config');
    }
    S.sb = window.supabase.createClient(Sync.SUPABASE_URL, Sync.SUPABASE_ANON_KEY);
  }

  async function currentUser() {
    const { data } = await S.sb.auth.getSession();
    if (!data || !data.session) return null;
    const u = data.session.user;
    let name = (u.user_metadata && u.user_metadata.display_name) || '';
    let role = null;
    try {
      const r = await S.sb.from('user_roles').select('display_name, role').eq('user_id', u.id).maybeSingle();
      if (r && r.data) { name = r.data.display_name || name; role = r.data.role; }
    } catch (e) { /* user_roles が読めなくてもレビューはできる */ }
    return { id: u.id, email: u.email, name: name || (u.email || '').split('@')[0], role };
  }

  function showLogin(show) { $('login-screen').classList.toggle('hidden', !show); }

  async function handleLogin(ev) {
    ev.preventDefault();
    const err = $('login-error');
    err.classList.add('hidden');
    const { error } = await S.sb.auth.signInWithPassword({ email: $('auth-email').value.trim(), password: $('auth-password').value });
    if (error) {
      err.textContent = 'ログインできませんでした（メールアドレスかパスワードをご確認ください）';
      err.classList.remove('hidden');
      return;
    }
    S.user = await currentUser();
    showLogin(false);
    await start();
  }

  // ===== 画面の素材（非公開バケットから・ログイン済みだけ）=====
  async function loadManifest() {
    const { data, error } = await S.sb.storage.from(BUCKET).download('manifest.json');
    if (error || !data) return null;
    try { return JSON.parse(await data.text()); } catch (e) { return null; }
  }

  async function signedUrl(path) {
    if (S.urlCache.has(path)) return S.urlCache.get(path);
    const { data, error } = await S.sb.storage.from(BUCKET).createSignedUrl(path, SIGN_SEC);
    if (error || !data) return null;
    S.urlCache.set(path, data.signedUrl);
    setTimeout(() => S.urlCache.delete(path), (SIGN_SEC - 120) * 1000);
    return data.signedUrl;
  }

  // ===== 左レール =====
  function renderRail() {
    const projs = S.manifest.projects.concat([{ key: 'all', label: '人員配置（全工事）', no: '' }]);
    $('proj-list').innerHTML = projs.filter((p) => S.manifest.screens.some((s) => s.project === p.key)).map((p) => `
      <button class="proj${p.key === S.projKey ? ' on' : ''}" data-proj="${esc(p.key)}">
        <div class="proj-name">${esc(p.label)}</div>
        <div class="proj-sub">${esc(p.no || '')}</div>
      </button>`).join('');
    $('proj-list').querySelectorAll('[data-proj]').forEach((b) => b.addEventListener('click', () => {
      S.projKey = b.dataset.proj;
      const first = S.manifest.screens.find((s) => s.project === S.projKey && s.file);
      if (first) S.screenId = first.id;
      S.activeRoot = null;
      renderAll();
    }));

    const list = S.manifest.screens.filter((s) => s.project === S.projKey);
    $('page-list').innerHTML = list.map((s) => {
      const roots = S.comments.filter((c) => c.screen_id === s.id && !c.parent_id);
      const open = roots.filter((c) => c.status !== 'resolved').length;
      const badge = roots.length ? `<span class="pg-badge${open ? '' : ' done'}">${open || roots.length}</span>` : '';
      return `<button class="pg${s.id === S.screenId ? ' on' : ''}${s.locked ? ' locked' : ''}" data-screen="${esc(s.id)}" ${s.locked ? 'disabled' : ''}
        title="${s.locked ? 'この工事ではまだ開けない画面です（dev6 の段階ゲート）' : esc(s.label)}">
        <span>${esc(s.label)}</span>${s.locked ? '<span class="ml-auto text-[10px]">🔒</span>' : badge}</button>`;
    }).join('');
    $('page-list').querySelectorAll('[data-screen]').forEach((b) => b.addEventListener('click', () => go(b.dataset.screen)));
  }

  function go(id) {
    const s = S.byId[id];
    if (!s || s.locked || !s.file) return;
    S.screenId = id;
    S.projKey = s.project;
    S.activeRoot = null;
    renderAll();
    $('stage').scrollTop = 0;
  }

  // ===== 画面（画像＋クリックできる場所＋ピン）=====
  async function renderScreen() {
    const s = S.byId[S.screenId];
    const host = $('canvas-host');
    if (!s || !s.file) { host.innerHTML = '<p class="p-6 text-slate-500 text-sm">画面がありません</p>'; return; }
    const proj = S.manifest.projects.find((p) => p.key === s.project);
    $('screen-title').textContent = (proj ? proj.label + '／' : '') + s.label;
    $('screen-sub').textContent = '撮影 ' + when(S.manifest.capturedAt) + '（dev6）';

    const stageW = $('stage').clientWidth - 28;
    const w = S.fitWidth ? Math.min(stageW, s.width) : s.width;
    const pct = (v, base) => (v / base * 100).toFixed(4) + '%';

    const hots = (s.hotspots || []).map((h, i) => {
      const dead = !h.target || !S.byId[h.target] || S.byId[h.target].locked;
      const title = dead ? (h.label || '') + '（この先はこのモックには入っていません）' : (h.label || '').split('\n')[0] + ' へ移動';
      return `<div class="hot${dead ? ' dead' : ''}" data-hot="${i}" title="${esc(title)}"
        style="left:${pct(h.x, s.width)};top:${pct(h.y, s.height)};width:${pct(h.w, s.width)};height:${pct(h.h, s.height)}"></div>`;
    }).join('');

    const roots = S.comments.filter((c) => c.screen_id === s.id && !c.parent_id && c.x_pct != null);
    const pins = roots.map((c, i) => {
      const stale = c.capture_version && c.capture_version !== S.manifest.capturedAt;
      const cls = 'pin' + (c.status === 'resolved' ? ' resolved' : stale ? ' stale' : '') + (S.activeRoot === c.id ? ' active' : '');
      return `<div class="${cls}" data-pin="${c.id}" title="${esc(c.user_name || '')}：${esc((c.body || '').slice(0, 60))}"
        style="left:${c.x_pct}%;top:${c.y_pct}%"><span>${i + 1}</span></div>`;
    }).join('');

    const url = await signedUrl(s.file);
    host.innerHTML = `<div class="canvas-wrap" id="canvas" style="width:${w}px">
      ${url ? `<img src="${url}" alt="${esc(s.label)}" style="width:${w}px;display:block">` : `<div class="p-8 text-sm text-slate-500">画像を取得できませんでした（権限かネットワーク）</div>`}
      ${hots}${pins}</div>`;

    const canvas = $('canvas');
    canvas.querySelectorAll('[data-hot]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      const h = s.hotspots[Number(el.dataset.hot)];
      if (h && h.target && S.byId[h.target] && !S.byId[h.target].locked) go(h.target);
      else toast('この先はこのモックには入っていません（' + ((h && h.label) || '').split('\n')[0] + '）');
    }));
    canvas.querySelectorAll('[data-pin]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      S.activeRoot = Number(el.dataset.pin);
      S.scope = 'this';
      syncScopeButtons();
      renderScreen(); renderComments();
      const t = document.querySelector('.thread.active');
      if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }));
    canvas.addEventListener('click', (e) => {
      if (!S.commenting) return;
      const r = canvas.getBoundingClientRect();
      openPopover((e.clientX - r.left) / r.width * 100, (e.clientY - r.top) / r.height * 100, e.clientX, e.clientY);
    });
  }

  // ===== 新規コメント（ピンを置く）=====
  function openPopover(xPct, yPct, clientX, clientY) {
    closePopover();
    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.id = 'pop';
    pop.innerHTML = `<div class="text-[11px] text-slate-500 mb-1">この場所へのコメント</div>
      <textarea id="pop-text" placeholder="気になったこと・直してほしいこと・確認したいこと"></textarea>
      <div class="flex justify-end gap-1.5 mt-1.5">
        <button class="btn btn-ghost" id="pop-cancel">やめる</button>
        <button class="btn btn-primary" id="pop-save">置く</button>
      </div>`;
    document.body.appendChild(pop);
    pop.style.left = Math.min(window.innerWidth - 312, Math.max(8, clientX + 12)) + 'px';
    pop.style.top = Math.min(window.innerHeight - 162, Math.max(8, clientY + 8)) + 'px';
    $('pop-text').focus();
    $('pop-cancel').addEventListener('click', closePopover);
    $('pop-save').addEventListener('click', async () => {
      const body = $('pop-text').value.trim();
      if (!body) return;
      closePopover();
      await addComment(body, xPct, yPct, null);
    });
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePopover();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('pop-save').click();
    });
  }
  function closePopover() { const p = $('pop'); if (p) p.remove(); }

  // ===== コメント =====
  async function loadComments() {
    const { data, error } = await S.sb.from('sf_mock_comments').select('*').order('id', { ascending: true });
    if (error) { S.tableReady = false; S.comments = []; return; }
    S.tableReady = true;
    S.comments = data || [];
  }

  async function addComment(body, xPct, yPct, parentId) {
    const s = S.byId[S.screenId];
    const proj = S.manifest.projects.find((p) => p.key === s.project);
    const { data, error } = await S.sb.from('sf_mock_comments').insert({
      user_id: S.user.id,
      user_name: S.user.name,
      screen_id: s.id,
      screen_label: (proj ? proj.label + '／' : '') + s.label,
      x_pct: xPct == null ? null : Number(xPct.toFixed(3)),
      y_pct: yPct == null ? null : Number(yPct.toFixed(3)),
      body,
      parent_id: parentId || null,
      capture_version: S.manifest.capturedAt
    }).select().single();
    if (error) {
      toast(S.tableReady ? '投稿できませんでした（' + error.message + '）' : 'コメントの器がまだありません（管理者が SQL を流すと使えます）', 6000);
      return;
    }
    upsertLocal(data);
    S.activeRoot = data.parent_id || data.id;
    renderAll();
  }

  async function setStatus(id, status) {
    const { error } = await S.sb.from('sf_mock_comments').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) { toast('変えられませんでした（' + error.message + '）'); return; }
    const c = S.comments.find((x) => x.id === id);
    if (c) c.status = status;
    renderAll();
  }

  async function removeComment(id) {
    if (!window.confirm('このコメントを削除します。よろしいですか？')) return;
    const { error } = await S.sb.from('sf_mock_comments').delete().eq('id', id);
    if (error) { toast('削除できませんでした（' + error.message + '）'); return; }
    S.comments = S.comments.filter((c) => c.id !== id && c.parent_id !== id);
    renderAll();
  }

  function upsertLocal(row) {
    const i = S.comments.findIndex((c) => c.id === row.id);
    if (i >= 0) S.comments[i] = row; else S.comments.push(row);
    S.comments.sort((a, b) => a.id - b.id);
  }

  function renderComments() {
    const list = $('c-list');
    if (!S.tableReady) {
      list.innerHTML = `<div class="text-[12.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 leading-relaxed">
        コメントの保存先（テーブル）がまだ作られていません。<br>管理者が <code>supabase/add_sf_mock_comments.sql</code> を
        Supabase の SQL Editor で流すと、この場で書けるようになります。<br><br>画面を見て回ることは今でもできます。</div>`;
      $('c-count').textContent = '';
      return;
    }
    const scoped = S.comments.filter((c) => !c.parent_id && (S.scope === 'all' || c.screen_id === S.screenId));
    const roots = S.openOnly ? scoped.filter((c) => c.status !== 'resolved') : scoped;
    const pinNo = {};
    S.comments.filter((c) => !c.parent_id && c.x_pct != null).forEach((c) => {
      pinNo[c.screen_id] = (pinNo[c.screen_id] || 0) + 1;
      c._no = pinNo[c.screen_id];
    });
    $('c-count').textContent = `未対応 ${S.comments.filter((c) => !c.parent_id && c.status !== 'resolved').length} 件／全 ${S.comments.filter((c) => !c.parent_id).length} 件`;

    if (!roots.length) {
      list.innerHTML = `<p class="text-[12.5px] text-slate-500 leading-relaxed">${S.scope === 'all' ? 'まだコメントはありません。' : 'この画面へのコメントはまだありません。'}<br>
        画面の気になるところを指すときは上の「💬 コメントを置く」を押してから、画面をクリックしてください。</p>`;
      return;
    }
    list.innerHTML = roots.slice().reverse().map(thread).join('');
    bindThreadEvents();
  }

  function thread(c) {
    const replies = S.comments.filter((r) => r.parent_id === c.id);
    const mine = S.user && (c.user_id === S.user.id || S.user.role === 'admin');
    const stale = c.capture_version && c.capture_version !== S.manifest.capturedAt;
    const s = S.byId[c.screen_id];
    return `<div class="thread${S.activeRoot === c.id ? ' active' : ''}${c.status === 'resolved' ? ' resolved' : ''}" data-root="${c.id}">
      <div class="c-head">
        ${c._no ? `<span class="chip" style="background:#1e3a8a;color:#fff">#${c._no}</span>` : ''}
        <span class="c-who">${esc(c.user_name || '—')}</span><span>${when(c.created_at)}</span>
        <span class="chip ${c.status === 'resolved' ? 'chip-done' : 'chip-open'}">${c.status === 'resolved' ? '対応済み' : '未対応'}</span>
        ${stale ? '<span class="chip chip-stale" title="このコメントの後で画面が撮り直されています">画面更新後</span>' : ''}
      </div>
      ${S.scope === 'all' ? `<div class="text-[11px] text-blue-700 cursor-pointer hover:underline" data-jump="${esc(c.screen_id)}">${esc(c.screen_label || (s ? s.label : c.screen_id))}</div>` : ''}
      <div class="c-body">${esc(c.body)}</div>
      ${replies.map((r) => `<div class="c-reply">
          <div class="c-head"><span class="c-who">${esc(r.user_name || '—')}</span><span>${when(r.created_at)}</span>
            ${S.user && (r.user_id === S.user.id || S.user.role === 'admin') ? `<button class="c-act danger ml-auto" data-del="${r.id}">削除</button>` : ''}</div>
          <div class="c-body">${esc(r.body)}</div></div>`).join('')}
      <div class="flex gap-3 mt-2">
        <button class="c-act" data-reply="${c.id}">返信</button>
        <button class="c-act" data-status="${c.id}" data-to="${c.status === 'resolved' ? 'open' : 'resolved'}">${c.status === 'resolved' ? '未対応に戻す' : '対応済みにする'}</button>
        ${mine ? `<button class="c-act danger" data-del="${c.id}">削除</button>` : ''}
      </div>
      <div class="hidden mt-2" data-replybox="${c.id}">
        <textarea rows="2" class="w-full border border-slate-300 rounded px-2 py-1.5 text-[13px]" placeholder="返信"></textarea>
        <div class="flex justify-end gap-1.5 mt-1"><button class="btn btn-primary" data-replysend="${c.id}">返信する</button></div>
      </div>
    </div>`;
  }

  function bindThreadEvents() {
    const list = $('c-list');
    list.querySelectorAll('[data-root]').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('textarea')) return;
      S.activeRoot = Number(el.dataset.root);
      renderScreen(); renderComments();
    }));
    list.querySelectorAll('[data-jump]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); go(el.dataset.jump); }));
    list.querySelectorAll('[data-status]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); setStatus(Number(el.dataset.status), el.dataset.to); }));
    list.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); removeComment(Number(el.dataset.del)); }));
    list.querySelectorAll('[data-reply]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      const box = list.querySelector(`[data-replybox="${el.dataset.reply}"]`);
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) box.querySelector('textarea').focus();
    }));
    list.querySelectorAll('[data-replysend]').forEach((el) => el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(el.dataset.replysend);
      const ta = list.querySelector(`[data-replybox="${id}"] textarea`);
      const body = ta.value.trim();
      if (!body) return;
      ta.value = '';
      await addComment(body, null, null, id);
    }));
  }

  function renderAll() { renderRail(); renderScreen(); renderComments(); }

  function syncScopeButtons() {
    $('tab-this').className = 'btn ' + (S.scope === 'this' ? 'btn-primary' : 'btn-ghost');
    $('tab-all').className = 'btn ' + (S.scope === 'all' ? 'btn-primary' : 'btn-ghost');
    $('tab-this').style.padding = $('tab-all').style.padding = '3px 9px';
  }

  // ===== Realtime（同時コメント）=====
  function subscribe() {
    S.sb.channel('sfmock-comments')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sf_mock_comments' }, (p) => {
        if (p.eventType === 'DELETE') {
          const id = p.old && p.old.id;
          S.comments = S.comments.filter((c) => c.id !== id && c.parent_id !== id);
        } else {
          upsertLocal(p.new);
          if (p.eventType === 'INSERT' && S.user && p.new.user_id !== S.user.id) {
            toast((p.new.user_name || '誰か') + ' さんがコメントしました');
          }
        }
        renderAll();
      })
      .subscribe();
  }

  // ===== 管理者：dev6 の撮影を取り込む（非公開バケットへ）=====
  // SF リポジトリで `node scripts/mockup/run_capture.js` を流すと scripts/mockup/out/ ができる。
  // そのフォルダをここで選ぶだけ（合言葉・鍵をどこにも置かずに済む＝いまのログインのまま上げる）。
  function setupUploader() {
    if (!S.user || S.user.role !== 'admin') return;
    $('admin-bar').classList.remove('hidden');
    $('btn-import').addEventListener('click', () => $('import-input').click());
    $('import-input').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      const man = files.find((f) => f.name === 'manifest.json');
      const pngs = files.filter((f) => /\.png$/i.test(f.name) && /screens[\\/]/.test(f.webkitRelativePath || ''));
      if (!man || !pngs.length) {
        toast('撮影フォルダ（manifest.json と screens/ が入っているもの）を選んでください', 5000);
        return;
      }
      const bar = $('import-status');
      bar.classList.remove('hidden');
      let done = 0;
      const total = pngs.length + 1;
      const step = (label) => { bar.textContent = `取り込み中… ${++done}/${total}　${label}`; };
      for (const f of pngs) {
        const { error } = await S.sb.storage.from(BUCKET).upload('screens/' + f.name, f, { upsert: true, contentType: 'image/png' });
        if (error) { bar.textContent = '取り込みに失敗しました: ' + error.message; return; }
        step(f.name);
      }
      const { error: me } = await S.sb.storage.from(BUCKET).upload('manifest.json', man, { upsert: true, contentType: 'application/json' });
      if (me) { bar.textContent = '目次の取り込みに失敗しました: ' + me.message; return; }
      step('manifest.json');
      // 消えた画面の後片付け（今回の撮影に無いファイルは消す）
      const { data: listed } = await S.sb.storage.from(BUCKET).list('screens', { limit: 500 });
      const keep = new Set(pngs.map((f) => f.name));
      const stale = (listed || []).filter((o) => !keep.has(o.name)).map((o) => 'screens/' + o.name);
      if (stale.length) await S.sb.storage.from(BUCKET).remove(stale);
      bar.textContent = `取り込みました（${pngs.length} 画面${stale.length ? '・古い ' + stale.length + ' 枚を削除' : ''}）`;
      S.urlCache.clear();
      setTimeout(() => location.reload(), 1200);
    });
  }

  // ===== 起動 =====
  function showEmpty(msg) {
    $('canvas-host').innerHTML = `<div class="m-6 p-6 bg-white border border-slate-200 rounded-xl max-w-2xl text-[13px] leading-relaxed text-slate-700">
      <div class="font-bold text-slate-900 mb-2">画面がまだ入っていません</div>${msg}</div>`;
  }

  async function start() {
    $('hdr-user').textContent = S.user.name + (S.user.role ? '（' + S.user.role + '）' : '');
    setupUploader();
    S.manifest = await loadManifest();
    await loadComments();
    if (!S.manifest) {
      $('hdr-sub').textContent = '画面が未取り込み';
      showEmpty(S.user.role === 'admin'
        ? 'SF リポジトリで <code>node scripts/mockup/run_capture.js</code> を流すと <code>scripts/mockup/out</code> ができます。<br>上の「dev6 の撮影を取り込む」でそのフォルダを選んでください。<br><br>先に <code>supabase/add_sf_mock_comments.sql</code> を Supabase の SQL Editor で流しておいてください（置き場所とコメントの器を作ります）。'
        : '管理者が dev6 の画面を取り込むと、ここで見られるようになります。');
      renderComments();
      return;
    }
    S.byId = {};
    S.manifest.screens.forEach((s) => { S.byId[s.id] = s; });
    S.projKey = S.manifest.projects[0].key;
    const first = S.manifest.screens.find((s) => s.project === S.projKey && s.file);
    S.screenId = first ? first.id : null;
    $('hdr-sub').textContent = 'dev6 の画面を ' + when(S.manifest.capturedAt) + ' に撮影／' +
      S.manifest.screens.filter((s) => s.file).length + ' 画面・工事 ' + S.manifest.projects.length + ' 件';
    syncScopeButtons();
    renderAll();
    subscribe();
    if (!S.tableReady) toast('コメントの保存先がまだ作られていません（管理者が SQL を流すと書けます）', 6000);
  }

  window.addEventListener('DOMContentLoaded', async () => {
    await initSupabase();
    $('login-form').addEventListener('submit', handleLogin);
    $('btn-logout').addEventListener('click', async () => { await S.sb.auth.signOut(); location.reload(); });
    $('btn-comment').addEventListener('click', () => {
      S.commenting = !S.commenting;
      $('btn-comment').className = 'btn ' + (S.commenting ? 'btn-on' : 'btn-ghost');
      document.body.classList.toggle('commenting', S.commenting);
      if (S.commenting) toast('画面の気になるところをクリックしてください');
    });
    $('btn-hot').addEventListener('click', () => {
      S.showHot = !S.showHot;
      $('btn-hot').className = 'btn ' + (S.showHot ? 'btn-on' : 'btn-ghost');
      document.body.classList.toggle('show-hot', S.showHot);
    });
    $('btn-zoom').addEventListener('click', () => {
      S.fitWidth = !S.fitWidth;
      $('btn-zoom').textContent = S.fitWidth ? '幅に合わせる' : '実寸（100%）';
      renderScreen();
    });
    $('tab-this').addEventListener('click', () => { S.scope = 'this'; syncScopeButtons(); renderComments(); });
    $('tab-all').addEventListener('click', () => { S.scope = 'all'; syncScopeButtons(); renderComments(); });
    $('chk-open').addEventListener('change', (e) => { S.openOnly = e.target.checked; renderComments(); });
    $('c-send').addEventListener('click', async () => {
      const ta = $('c-new');
      const body = ta.value.trim();
      if (!body || !S.screenId) return;
      ta.value = '';
      await addComment(body, null, null, null);
    });
    window.addEventListener('resize', () => { if (S.screenId) renderScreen(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });

    S.user = await currentUser();
    if (!S.user) { showLogin(true); return; }
    showLogin(false);
    await start();
  });
})();
