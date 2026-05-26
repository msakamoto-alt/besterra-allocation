# 段階E1.5 セットアップ手順（アカウント管理 Edge Function）

アプリ内でアカウント（メール/パスワード）を作成・管理できるようにする。
そのために Supabase 上に小さなサーバー関数「**admin-users**」を1つ置く（初回のみ）。

- `service_role`（全権の鍵）は **この関数の中だけ**で使われ、ブラウザには出ない。
- 鍵は Supabase が関数に自動で渡すので、**あなたが鍵を扱う必要はない**。
- 関数は「呼んできたのが admin か」を毎回サーバー側で検証する。

---

## 方法A：ダッシュボードからデプロイ（推奨・CLIなし）

1. Supabase ダッシュボード左メニュー **Edge Functions**
2. **「Deploy a new function」→「Via Editor」**（エディタで作成）を選択
3. 関数名に **`admin-users`** と入力（この名前でないとアプリから呼べません）
4. エディタの中身を全部消し、`supabase/functions/admin-users/index.ts` の中身を貼り付け
5. **Deploy**（デプロイ）ボタンを押す
6. デプロイ完了後、関数の設定で **「Verify JWT」が ON**（既定）であることを確認
   - ログイン中ユーザーしか呼べなくなる＝余計なアクセスを弾く安全層

> ⚠️ `service_role` の設定は不要です。Edge Function では `SUPABASE_SERVICE_ROLE_KEY` が
> 自動で使えるようになっています。

## 方法B：CLI（ダッシュボードに Editor が無い場合）

```bash
# 初回のみ
npm i -g supabase           # または scoop/brew で supabase CLI を導入
supabase login              # ブラウザ認証
supabase link --project-ref pajmsowweswaxowrbiwr

# デプロイ（リポジトリのルートで）
supabase functions deploy admin-users
```

---

## デプロイできたか確認

アプリ（localhost）に **admin でログイン** → ヘッダー右の **「👥 アカウント」** ボタン →
モーダルが開き、現在のアカウント一覧（最低でも自分=管理者）が表示されれば成功。

うまくいかない時：
- 「読み込み失敗」→ 関数名が `admin-users` でない／デプロイ未完了／Verify JWT 周りを確認
- F12 → Console / Network タブで `functions/v1/admin-users` の応答（赤色）を確認して共有してください

---

## 使い方（admin）

- **新規追加**：メール・氏名・ロール・初期パスワードを入れて「追加」→ 即ログイン可能なアカウントが作られる
- **ロール変更**：一覧の各行のプルダウンで即変更
- **パス再設定 / 削除**：各行のボタンから
- 以降、アカウント運用は**すべてアプリ内で完結**（Supabaseダッシュボードを触る必要なし）

## 補足
- 「最後の管理者」を自分で降格／削除はできない安全装置あり。
- ロール一覧の正体は `user_roles` 表。Auth ユーザー作成と同時に1行作られる。
