# 連携の見張り（画面の帯＋Teams）設定手順 — 2026-10-29

## 何をするものか

配置の取込（SF 本番 → 現場人員配置・毎朝 6:00）と、取引先の配信（統合管理ツール → SF・夜間全件は毎朝 5:30）がうまく動いていないときに知らせます。

- **A 画面の帯**：admin・経理のログイン中、見出しの下に赤い帯で「連携の異常：…」と出ます（30 分おきに見直し）。
- **B Teams**：1 時間おき（6:15〜20:15）に点検し、見つけた問題を坂本さんの Teams に送ります。同じ問題は 1 日 1 回だけです。

発端：10/19〜10/29 の 11 日間、配置の取込が毎朝失敗していた（SF 本番の実行ユーザー＝坂本さんの権限が変わり、レポートの列が消えた）のに、記録（監査ログ）に残るだけで誰も気づけなかった。

```
audit_logs（取込の記録）・integration_log（配信の記録）
  → integration_health_core()（点検）
      ├→ integration_health()          … 画面の帯（A）
      └→ integration_health_record()   … pg_cron 1 時間おき → integration_alert（1 日 1 行）
            → integration-health-feed（RSS）→ Power Automate（RSS のトリガー）→ Flow bot → 坂本さんの Teams（B）
```

**見るもの**

| 対象 | 異常とみなすとき |
|---|---|
| 配置の取込 | 最後の記録が失敗／26 時間以上成功していない／行数が前回の半分未満 |
| 取引先の配信（送り先の org ごと） | 24 時間以内にエラー／夜間全件が 26 時間以上来ていない／夜間全件の失敗が 1 件以上 |

## 1. SQL（SQL Editor・1 回）

`supabase/integration_health.sql` を貼って実行。続けて確認：

```sql
select * from public.integration_health_core();
```

いまは全部 `ok = true` が期待値（10/29 に取込を復旧済み）。

## 2. Secrets（Edge Functions → Secrets）

| 名前 | 値 |
|---|---|
| `HEALTH_FEED_KEY` | git の外の `自動化\SF連携検証\health_feed_secret.txt` の `HEALTH_FEED_KEY=` の右側 |

## 3. 関数を作る（エディタから）

| 関数 | 中身 | Verify JWT |
|---|---|---|
| `integration-health-feed`（新規） | `supabase/functions/integration-health-feed/index.ts` | **オフ**（RSS のトリガーはヘッダを付けられないため。URL の合鍵で確かめる） |

## 4. Power Automate のフロー（坂本さんのアカウント）

1. https://make.powerautomate.com →［＋作成］→［**自動化したクラウド フロー**］
2. 名前「統合管理ツール 連携の異常 → Teams」、トリガー［**フィード項目が発行されたとき**］（RSS）→［作成］
3. トリガーの設定
   - RSS フィードの URL：`health_feed_secret.txt` の `FEED_URL=` の右側
   - 選択したプロパティ：**PublishDate**
4. ［＋］→ Microsoft Teams の［**チャットまたはチャネルでメッセージを投稿する**］
   - 投稿者：**Flow bot** ／ 投稿先：**Flow ボットとチャットする**
   - Recipient：**坂本さんのメールアドレスを直接書く**（動的な値にしない＝フィードの中身で宛先が変わらない）
   - メッセージ：動的なコンテンツで「フィード タイトル」「フィードの概要」を並べ、最後に統合管理ツールの URL を固定の文字で書く
5. ［保存］

「'フィード項目が発行される場合' の接続が見つかりません」と出たら、トリガーの［接続］で新しい接続を作る（RSS はサインイン不要）→ 保存。
RSS のトリガーは**保存後に発行された項目だけ**を送る。10/29 の初回は、項目の発行から Teams に届くまで約 8 分かかった。

宛先を増やすときは、フローの Recipient を足すか、同じ形のアクションを並べます（関数・SQL は触らない）。
**FEED_URL は合鍵と同じです。** チャット・メール・リポジトリに貼らないでください。

## 5. 試す

- 帯：SQL Editor で、表示だけ確かめたいときは `integration_alert` ではなく画面側を見る（admin でログイン→異常が無ければ帯は出ない）。
- Teams：SQL Editor で試しの警報を 1 行入れる → 数分〜トリガーの間隔で Teams に届く → 消す。

```sql
insert into public.integration_alert (alert_key, day, title, detail)
values ('test', (now() at time zone 'Asia/Tokyo')::date, '試し（見張りの接続確認）', 'これは接続の確認です');
-- 届いたら
delete from public.integration_alert where alert_key = 'test';
```

## 6. 止める・戻す

```sql
select cron.unschedule('integration-health-watch');
```

帯は `index.html` の `#integration-alert` と `App.startIntegrationHealthWatch`。関数 `integration_health` が無ければ帯は出ないだけで、画面は動く。
