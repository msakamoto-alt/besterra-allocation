// 段階E1.5: アカウント管理 Edge Function（admin-users）
//
// 役割：service_role キー（全権・RLS無視）をサーバー側だけで保持し、
//       呼び出し元が本当に admin か検証してから Auth 管理操作を行う。
//       ブラウザ（公開JS）には service_role を絶対に置かないための要。
//
// 認証：呼び出し元の Supabase JWT を検証 → user_roles で role=admin を確認。
//       admin 以外は 403。
//
// service_role / URL は Edge Function 実行環境に自動で注入される
//   （SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL）。手動設定不要。
//
// アクション（POST body の action）：
//   list         … user_roles 一覧
//   create       … { email, password, display_name, role } でユーザー作成＋ロール付与
//   set_role     … { user_id, role } でロール変更
//   set_password … { user_id, password } でパスワード再設定
//   delete       … { user_id } でユーザー削除（user_roles は FK cascade）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ROLES = ['admin', 'editor', 'executive', 'manager', 'viewer'];

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // --- 呼び出し元の認証 & admin 検証 ---
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    if (!jwt) return json({ error: '未認証です' }, 401);
    const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !userData?.user) return json({ error: '認証が無効です' }, 401);
    const callerId = userData.user.id;
    const { data: caller } = await admin
      .from('user_roles').select('role').eq('user_id', callerId).maybeSingle();
    if (!caller || caller.role !== 'admin') return json({ error: '管理者権限が必要です' }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === 'list') {
      const { data, error } = await admin
        .from('user_roles')
        .select('user_id, role, display_name, email, created_at')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return json({ users: data });
    }

    if (action === 'create') {
      const { email, password, display_name, role } = body;
      if (!email || !password) return json({ error: 'メールとパスワードは必須です' }, 400);
      if (!ROLES.includes(role)) return json({ error: '不正なロールです' }, 400);
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (cErr) return json({ error: cErr.message }, 400);
      const uid = created.user!.id;
      const { error: rErr } = await admin.from('user_roles')
        .insert({ user_id: uid, role, display_name: display_name || null, email });
      if (rErr) {
        // ロール付与に失敗したら、作ったユーザーを巻き戻す（孤立アカウントを残さない）
        await admin.auth.admin.deleteUser(uid);
        return json({ error: 'ロール登録に失敗しました: ' + rErr.message }, 400);
      }
      return json({ ok: true, user_id: uid });
    }

    if (action === 'set_role') {
      const { user_id, role } = body;
      if (!ROLES.includes(role)) return json({ error: '不正なロールです' }, 400);
      // 最後の管理者を降格してadmin不在になるのを防ぐ
      if (user_id === callerId && role !== 'admin') {
        const { count } = await admin
          .from('user_roles').select('*', { count: 'exact', head: true }).eq('role', 'admin');
        if ((count ?? 0) <= 1) return json({ error: '最後の管理者は降格できません' }, 400);
      }
      const { error } = await admin.from('user_roles').update({ role }).eq('user_id', user_id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === 'set_name') {
      const { user_id, display_name } = body;
      const { error } = await admin.from('user_roles')
        .update({ display_name: display_name || null }).eq('user_id', user_id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === 'set_password') {
      const { user_id, password } = body;
      if (!password) return json({ error: 'パスワードが未指定です' }, 400);
      const { error } = await admin.auth.admin.updateUserById(user_id, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === 'delete') {
      const { user_id } = body;
      if (user_id === callerId) return json({ error: '自分自身は削除できません' }, 400);
      const { error } = await admin.auth.admin.deleteUser(user_id); // user_roles は FK cascade
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: '不明なアクションです' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
