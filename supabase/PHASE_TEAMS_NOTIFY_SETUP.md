# SF の承認待ち・回覧 → Teams 通知（sf-teams-notify）設定手順 — 2026-10-10 第 1 段

## 何をするものか

Salesforce（いまは dev6）で「あなた宛ての承認待ち」と「回覧」ができたら、5 分以内に宛先の人へ Teams の個人チャットでカードを送ります。
カードには要旨と［Salesforce で開く］ボタンが付いています。**承認・既読は SF で付けます**。Teams から SF へは何も書きません。

```
SF（承認待ち ProcessInstanceWorkitem・回覧 Circulation__c）
  → 統合管理ツールの Edge Function sf-teams-notify（5 分おき・送った記録＝teams_notify_log）
  → Teams Workflows の Webhook → Flow bot → 宛先の人の個人チャット
```

**テスト中は、本来の宛先に関係なく全部を原島さんへ送ります**（Secrets の `TEAMS_TEST_RECIPIENT`）。カードの先頭に「本来の宛先は ○○ さん」と出ます。
テストの宛先も本番の許可（`TEAMS_LIVE=true`）も無いときは、誰にも送りません（dev6 のメールは末尾の `.invalid` を外すと実在の社員になるため）。

## 1. 表を作る（SQL Editor・1 回）

`supabase/teams_notify.sql` を貼り付けて実行します。

## 2. Teams 側のフローを作る（坂本さんのアカウント）

1. https://make.powerautomate.com を開く →［＋作成］→［自動化したクラウド フロー］
2. 名前「SF 通知 → Teams（テスト）」、トリガーに「Teams Webhook」と入れて［**Teams Webhook 要求を受信したとき**］を選び［作成］
3. トリガーの設定で［フローをトリガーできるユーザー］＝［**誰でも**］
4. ［＋］→ Microsoft Teams の［**チャットまたはチャネルでカードを投稿する**］
   - 投稿者：**Flow bot**
   - 投稿先：**Flow ボットとチャットする**
   - 受信者：式（fx）で `triggerBody()?['to']`
   - アダプティブ カード：式（fx）で `string(triggerBody()?['attachments']?[0]?['content'])`
5. ［保存］→ トリガーを開き、表示された **HTTP URL** をコピー

画面の言葉は版によって少し違うことがあります。迷ったら英語名（When a Teams webhook request is received ／ Post card in a chat or channel）で探してください。
**この URL は合鍵と同じです。** チャット・メール・リポジトリに貼らないでください。

## 3. Secrets を足す（Supabase → Edge Functions → Secrets）

| 名前 | 値 |
|---|---|
| `TEAMS_WEBHOOK_URL` | 2 でコピーした URL |
| `TEAMS_TEST_RECIPIENT` | 原島さんの会社のメールアドレス |

SF への接続（`SF_EXPORT_*`）と `IMPORT_SECRET` は sf-export と同じものを使うので、追加はいりません。

## 4. 関数を作る（エディタから）

Edge Functions →［Deploy a new function］→［Via Editor］→ 名前 `sf-teams-notify` → 中身を全部消して `supabase/functions/sf-teams-notify/index.ts` を貼り付け →［Deploy］。
Verify JWT は sf-export と同じく **オン** のままにします。

## 5. 試す（手元のスクリプト）

スクリプトは git の外にあります（`自動化\SF連携検証\teams_notify_call.py`）。

```
python teams_notify_call.py          # 送らずに、拾った件数と送る予定を見る
python teams_notify_call.py send     # 1 回目＝起点を記録するだけ（送らない）
```

dev6 で承認を 1 件申請してから、もう一度 `send` を実行します。原島さんの Teams に「承認待ちです」のカードが届き、［Salesforce で開く］で承認パネルまで行ければ合格です。

## 6. 定期実行にする

`supabase/teams_notify_cron.sql` の `<ANON_KEY>` と `<IMPORT_SECRET>` を埋めた写しを git の外に作り、SQL Editor で実行します。止めるときは `select cron.unschedule('sf-teams-notify');` を実行します。

## 本番の宛先へ切り替えるとき（第 1 段の完了後・別途判断）

1. `TEAMS_TEST_RECIPIENT` を消して `TEAMS_LIVE=true` を足す
2. 接続先を本番 SF にするかどうかは別の判断です（`SF_EXPORT_*` は sf-export と共通なので、分けるなら Secrets の名前を分けます）
3. Teams のフローを会社の所有（共有の所有者）に移す
