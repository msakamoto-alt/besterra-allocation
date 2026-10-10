# SF の承認待ち・回覧 → Teams 通知（sf-teams-notify／sf-teams-feed）設定手順 — 2026-10-10 第 1 段

## 何をするものか

Salesforce（いまは dev6）で「あなた宛ての承認待ち」と「回覧」ができたら、数分以内に宛先の人へ Teams の個人チャットでカードを送ります。
カードには要旨と［Salesforce で開く］ボタンが付いています。**承認・既読は SF で付けます**。Teams から SF へは何も書きません。

```
SF（承認待ち ProcessInstanceWorkitem・回覧 Circulation__c）
  → sf-teams-notify（5 分おき）… 新しく来た分を teams_notify_log に「RSS に出した」（queued）として積む
  → sf-teams-feed … 秘密の URL で RSS として出す（読むだけ）
  → Power Automate の RSS のトリガーが読みに来る → Flow bot → 宛先の人の個人チャット
```

**なぜ RSS か**：Teams 側から取りに来てもらう形なので、外から Teams のフローを呼ぶ必要がありません。
外からの呼び出しを使う場合は、Secrets の `TEAMS_DELIVERY=webhook` で直接送る形に戻せます（関数に残してあります）。

**テスト中は、本来の宛先に関係なく全部を原島さんへ送ります**（Secrets の `TEAMS_TEST_RECIPIENT`）。カードの先頭に「本来の宛先は ○○ さん」と出ます。
テストの宛先も本番の許可（`TEAMS_LIVE=true`）も無いときは、誰にも送りません（dev6 のメールは末尾の `.invalid` を外すと実在の社員になるため）。

## 1. 表を作る（SQL Editor・1 回ずつ）

1. `supabase/teams_notify.sql`
2. `supabase/teams_notify_feed.sql`（RSS 用の列と状態を足す）

## 2. Secrets（Supabase → Edge Functions → Secrets）

| 名前 | 値 |
|---|---|
| `TEAMS_TEST_RECIPIENT` | 原島さんの会社のメールアドレス |
| `TEAMS_FEED_KEY` | git の外の `自動化\SF連携検証\teams_feed_secret.txt` の `TEAMS_FEED_KEY=` の右側 |

`TEAMS_DELIVERY` は入れなくて構いません（既定＝feed）。SF への接続（`SF_EXPORT_*`）と `IMPORT_SECRET` は sf-export と共通です。

## 3. 関数を作る・入れ替える（エディタから）

| 関数 | 中身 | Verify JWT |
|---|---|---|
| `sf-teams-notify` | `supabase/functions/sf-teams-notify/index.ts` | **オン**（sf-export と同じ） |
| `sf-teams-feed`（新規） | `supabase/functions/sf-teams-feed/index.ts` | **オフ**（RSS のトリガーはヘッダを付けられないため。URL の合鍵で確かめる） |

## 4. Power Automate のフローを作る（坂本さんのアカウント）

1. https://make.powerautomate.com →［＋作成］→［**自動化したクラウド フロー**］
2. 名前「SF 通知 → Teams（RSS・テスト）」、トリガーの検索に「**RSS**」→［**フィード項目が発行されたとき**］（英語名 When a feed item is published）→［作成］
3. トリガーの設定
   - RSS フィードの URL：`teams_feed_secret.txt` の `FEED_URL=` の右側
   - 選択したプロパティ（Chosen property）：**PublishDate**
4. ［＋］→ Microsoft Teams の［**チャットやチャネルにカードを投稿する**］
   - 投稿者：**Flow bot** ／ 投稿先：**Flow ボットとチャットする**
   - Recipient：歯車 →［動的なコンテンツを使用する］→ `/` →［式の挿入］で
     `json(base64ToString(triggerOutputs()?['body/summary']))?['to']`
   - アダプティブ カード：同じく式で
     `string(json(base64ToString(triggerOutputs()?['body/summary']))?['card'])`
5. ［保存］

**FEED_URL は合鍵と同じです。** チャット・メール・リポジトリに貼らないでください。
Webhook のトリガーで作ったフローは使わないので、オフにしておくか削除して構いません。

## 5. 試す（手元のスクリプト・git の外 `自動化\SF連携検証\teams_notify_call.py`）

```
python teams_notify_call.py ping     # RSS に接続テストを 1 件出す
python teams_notify_call.py feed     # RSS を読んで、出ている項目を表示（合鍵が効いているか・中身が開けるか）
```

数分以内に原島さんへ「統合管理ツールからの接続テストです」のカードが届けば、RSS → Power Automate → Flow bot はつながっています。
届かないときは Power Automate のフローの［実行履歴］を見ます（トリガーが走っていない／カードの投稿で失敗、のどちらか）。

```
python teams_notify_call.py          # 送らずに、拾った件数と送る予定を見る
python teams_notify_call.py send     # 1 回目＝起点を記録するだけ（送らない）
```

dev6 で承認を 1 件申請してから、もう一度 `send` を実行します。原島さんの Teams に「承認待ちです」のカードが届き、［Salesforce で開く］で承認パネルまで行ければ合格です。

## 6. 定期実行にする

`supabase/teams_notify_cron.sql` の `<ANON_KEY>` と `<IMPORT_SECRET>` を埋めた写しを git の外に作り、SQL Editor で実行します。止めるときは `select cron.unschedule('sf-teams-notify');` を実行します。
届くまでの時間＝最大 5 分（拾う間隔）＋ RSS のトリガーが読みに来る間隔です。

## 本番の宛先へ切り替えるとき（第 1 段の完了後・別途判断）

1. `TEAMS_TEST_RECIPIENT` を消して `TEAMS_LIVE=true` を足す
2. 接続先を本番 SF にするかどうかは別の判断です（`SF_EXPORT_*` は sf-export と共通なので、分けるなら Secrets の名前を分けます）
3. Teams のフローを会社の所有（共有の所有者）に移す
4. RSS には承認待ちの要旨（件名・金額・申請者）が載ります。合鍵の URL の扱いと、載せる項目を本番の前に見直します
