# セットアップ手順

このリポジトリを GitHub に push して GitHub Pages で公開するまでの手順です。
プログラミング初心者向けに **コピペで実行できる** よう詳細に記述しています。

---

## 前提

- Windows 11
- Git for Windows がインストール済み（未インストールなら https://git-scm.com/download/win から）
- GitHubアカウント `msakamoto-alt` でログイン済み

---

## 1. GitHub.com で空リポジトリを作成

1. ブラウザで https://github.com/new を開く
2. 以下を入力：
   - **Repository name**: `besterra-allocation`
   - **Description**: `ベステラ 配置管理キャパシティ分析統合システム`
   - **Visibility**: **Private** を選択（必須・人事情報を含むため）
   - **Initialize this repository with**: 全てチェックを外す（READMEもLICENSEも追加しない・既にローカルにある）
3. 緑色の「**Create repository**」ボタンを押す
4. 作成後の画面で表示されるURL（`https://github.com/msakamoto-alt/besterra-allocation.git`）を控えておく

---

## 2. ローカルからGitHubへ初回push

PowerShell を開いて、以下を **1コマンドずつ** コピペ実行：

```powershell
# ローカルディレクトリへ移動
cd C:\Users\sakamoto\besterra-allocation

# Git ユーザー設定（初回のみ）
git config --global user.name "Masashi Sakamoto"
git config --global user.email "m.sakamoto@besterra.co.jp"

# リポジトリ初期化
git init

# ブランチ名を main に
git branch -M main

# すべてステージ
git add .

# 初回コミット
git commit -m "Initial commit: Phase 1 雛形（カードビュー＋暫定パスワード）"

# リモート登録
git remote add origin https://github.com/msakamoto-alt/besterra-allocation.git

# push（初回は認証が求められる）
git push -u origin main
```

**認証ポップアップが出たら**：
- 「Sign in with your browser」を選ぶ
- ブラウザでGitHub認証ページが開く → 承認

---

## 3. GitHub Pages を有効化

1. ブラウザで `https://github.com/msakamoto-alt/besterra-allocation` を開く
2. 上部メニューの「**Settings**」をクリック
3. 左メニューの「**Pages**」をクリック
4. 「Build and deployment」セクションで：
   - **Source**: `Deploy from a branch` を選択
   - **Branch**: `main` / `/ (root)` を選択
   - 「**Save**」を押す
5. 1〜2分待つと「Your site is live at `https://msakamoto-alt.github.io/besterra-allocation/`」と表示される

---

## 4. 動作確認

1. ブラウザで `https://msakamoto-alt.github.io/besterra-allocation/` を開く
2. パスワード入力画面が表示される
3. パスワード：**`besterra2026`** を入力
4. ログイン成功後、サンプル社員カード3枚が表示されればOK

---

## 5. Google Sheets と接続（Sheets 作成後）

Sheets テンプレート（Box配下）から Google Sheets を作成した後：

1. SheetsのURL（例: `https://docs.google.com/spreadsheets/d/【SHEET_ID】/edit`）から SHEET_ID を取得
2. ローカルで `js/config.js` を作成（このファイルは .gitignore で除外されているため push されない）：

```javascript
// js/config.js
Sync.SHEET_ID = 'ここにSHEET_IDを貼り付け';
```

3. ローカルで動作確認後、本番反映用に別途相談（config.js をリポジトリに含めるか、別管理にするか）

---

## 6. パスワード変更手順

暫定パスワード `besterra2026` を変えるとき：

1. PowerShell で新パスワードのSHA-256ハッシュを生成：

```powershell
$pwd = "新しいパスワード"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($pwd)
$hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
($hash | ForEach-Object { $_.ToString("x2") }) -join ""
```

2. 出力されたハッシュ文字列を `js/crypto.js` の `EXPECTED_HASH` に貼り付け
3. コミット & push

---

## トラブルシューティング

### Q. `git push` で `fatal: Authentication failed` と出る

A. GitHub の Personal Access Token が必要。
   https://github.com/settings/tokens で `repo` 権限付きトークンを発行し、push 時のパスワード欄に貼る。

### Q. Pages の URL を開いても 404 になる

A. Pages の反映には数分かかる。Settings > Pages の画面で「Your site is live at ...」が表示されているか確認。

### Q. パスワードを入力しても通らない

A. ブラウザの開発者ツール（F12）→ Console タブでエラーを確認。
   crypto.js の `EXPECTED_HASH` と入力パスワードのSHA-256が一致しているかチェック。

---

## 次のステップ

- Google Sheets テンプレートの構築（別文書）
- 長谷部氏との初回相談（暗号化・ガントチャート方針）
- Phase 2a：本格暗号化への置換
- Phase 2b：ガントビュー4軸切替の実装
