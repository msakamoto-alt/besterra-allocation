# 段階E4a 安全Eラーニング セットアップ／カットオーバー手順

新タブ「安全学習」を追加する段階。**完全に追加のみ**（既存タブ・既存テーブルは一切変更なし）。
新テーブル `quiz_questions` / `quiz_answers` と新ビュー `elearning.js` を足すだけなので、
SQL を先に流してもアプリ未マージなら本番は無変化（新タブが現れるのはマージ後）。

## 前提
- `phaseE1a_roles.sql` 実行済み（`user_roles` / `app_role()` が存在）。E3まで稼働中なので満たしている。

## 手順

### 1. テーブル＋RLS作成（Supabase SQL Editor で admin が実行）
`supabase/phaseE4_elearning.sql` を貼り付け → Run。
- `quiz_questions`：読取=ログイン者全員（非公開は admin のみ）／書込=admin
- `quiz_answers`：INSERT=本人のみ／SELECT=本人＋admin/manager/executive／DELETE=admin

### 2. 初期問題の投入（同じく SQL Editor で実行）
`supabase/phaseE4_seed_questions.sql` を貼り付け → Run。
- 単元「安全のしおり」24問を `qid` で冪等 upsert（再実行で最新に更新）。
- 問題の元データ：`Box\…\09_安全・品質\安全管理\Eラーニング問題集\安全Eラーニング_問題集_v1_2026-05-27.xlsx`
- 追加・修正は `gen_questions.py` を編集→再実行で Excel と SQL の両方を再生成（または「出題管理」画面でアプリから直接編集）。

### 3. アプリのマージ＆公開
```
git checkout main
git merge --ff-only feature/phase-e4-elearning
git push
```
GitHub Pages 反映に1〜2分。以後、ログイン者全員に「安全学習」タブが見える。

### 4. 動作確認（本番 or ローカル）
- **学習**：安全学習タブ → 分野・問題数を選び「はじめる」→ 4択をタップ → 正解/不正解＋解説＋出典 → 次へ → 結果。
- **記録**：解くたびに `quiz_answers` に1行。ヘッダの「今日/通算」が増える。
- **出題管理（adminのみ）**：右上「出題管理」→ 一覧で公開/非公開トグル・編集・追加・削除。**ここでツール上の問題精査ができる**。
- **権限確認**：別ロール（manager/viewer等）でログイン → 学習はできるが「出題管理」ボタンは出ない。manager/executive は将来の全社モニタリング（E4c）で全員分の解答を閲覧可（RLSは設定済み）。

## パイロット運用（数名）
- 監督3〜5名に 👥アカウント でアカウント発行（ロールは viewer か manager）。
- 「安全学習」タブを毎朝開いて10〜20問。まずは安全のしおり24問で回す。
- 効果を見て問題量産（規程類・ベステラスタンダード・過去事例）＋67名展開へ。

## ロールバック
- アプリ：main を `feature/phase-e4-elearning` マージ前へ戻す（新タブが消える）。
- データ：`drop table public.quiz_answers; drop table public.quiz_questions;`（学習ログも消えるので注意）。

## 補足（設計メモ）
- `quiz_answers.user_id` は `default auth.uid()`＋RLS `with check (user_id = auth.uid())` で本人名義を強制（JS改ざんでも他人名義の記録不可・自分の記録も削除不可）。
- タブ着地：admin/executive=経営レポート、manager=監督リスト、viewer=現場人員配置（DOM先頭の閲覧可タブ）。安全学習は末尾タブなので各自クリックで開く（E4bで学習者の着地最適化を検討）。
- 学習進捗ダッシュボード（個人の日別バー・ストリーク・単元別習得度）と全社モニタリングは E4b/E4c。E4a は「解ける・記録される・adminが精査できる」までを最小実装。
