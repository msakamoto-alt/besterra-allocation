# 段階E1 セットアップ手順（あなたが Supabase で行う作業）

E1は「全員が個人アカウントでログインし、ロールで権限を分ける」基盤づくり。
**今やるのは E1a（追加のみ・本番は無傷）だけ**。anon遮断（E1b）は後日コードと同時に行う。

---

## ステップ1：ロール基盤SQLを実行（E1a）

1. Supabase ダッシュボードを開く → 左メニュー **SQL Editor**
2. 「New query」→ `supabase/phaseE1a_roles.sql` の中身を全部貼り付け → **Run**
3. エラーなく完了すればOK（`user_roles` テーブルと `app_role()` 関数ができる）
   - ⚠️ この時点では権限は今まで通り。本番アプリは普通に動き続ける。

## ステップ2：管理者アカウントを作る

1. 左メニュー **Authentication** → **Users** → **Add user**（または「Add user → Create new user」）
2. 入力：
   - Email：`m.sakamoto@besterra.co.jp`（あなたの管理者用メール）
   - Password：任意の強いパスワード（**パスワードマネージャーで管理**・メモには残さない）
   - **Auto Confirm User：ON**（確認メールを省略）
3. 「Create user」

## ステップ3：そのアカウントに admin ロールを付与

1. SQL Editor で次を実行（email はステップ2と同じものに）：

   ```sql
   insert into public.user_roles (user_id, role, display_name, email)
   select id, 'admin', '坂本', email from auth.users
   where email = 'm.sakamoto@besterra.co.jp'
   on conflict (user_id) do update set role = excluded.role;
   ```

2. 確認：

   ```sql
   select user_id, role, email from public.user_roles;
   ```

   → 1行（role=admin）が出ればOK。

---

## ここまで終わったら

「E1a完了」と伝えてください。こちらで **ログイン画面を個人アカウント方式に作り替えるコード**を
ブランチ（feature/phase-e-rbac）に実装し、localhost で一緒に動作確認します。

テスト用に各ロール（editor / executive / manager / viewer）のアカウントも
後で1個ずつ作ると、画面の出し分け（E2）の確認に便利です（今はadminだけでOK）。

---

## まだやらないこと（E1b・カットオーバー）

`phaseE1b_cutover_rls.sql`（anon遮断＋ロール強制）は、**新ログインコードをmainに反映するのと
同時**に実行する。先に実行すると現行本番が読めなくなるため、合図するまで実行しないこと。
