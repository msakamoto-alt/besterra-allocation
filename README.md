# besterra-allocation

ベステラ㈱ 人員配置管理ツール

## 概要

現場監督67名（広義監督サポート含む90名規模）の配置・キャパシティを Google Sheets ベースで管理し、GitHub Pages 上で閲覧・編集するツール。

- **データ層**：Google Sheets（10シート構成）
- **アプリ層**：静的HTML + JavaScript（このリポジトリ）
- **ホスティング**：GitHub Pages
- **アクセス制御**：クライアントサイド暗号化（パスワード保護）

## 公開URL

https://msakamoto-alt.github.io/besterra-allocation/

## ドキュメント

仕様書は本リポジトリ外、Box 配下に正本があります：

```
Box\m.sakamoto\Besterra\01_組織\人員配置\配置管理キャパシティ分析統合システム\
  ├ 統合仕様書_v4.0_配置管理キャパシティ分析統合システム.md（社内正式版）
  ├ 配置管理システム_長谷部氏向け仕様書_2026-05-21.md（協業説明用）
  └ 仕様書v3.0_データスキーマ_ドラフト.md（テーブル定義詳細）
```

## ディレクトリ構造

```
besterra-allocation/
├── index.html        エントリ（パスワード入力）
├── css/
│   └── styles.css    全体スタイル
├── js/
│   ├── app.js        アプリ初期化
│   ├── crypto.js     クライアント暗号化（長谷部氏方式移植予定）
│   ├── sync.js       Google Sheets CSV同期
│   └── views/
│       ├── cards.js  カードビュー
│       └── gantt.js  ガントビュー（4軸切替）
├── docs/             開発者向けドキュメント
└── scripts/          Phase 0 Python資産のミラー予定地
```

## 開発状況

| Phase | 内容 | 状態 |
|---|---|---|
| Phase 0 | データ棚卸し・実績抽出 | 完了 |
| Phase 1 | カードビュー（67名）+ 暫定パスワード | 着手中 |
| Phase 2a | 本格暗号化に置換 | 未着手 |
| Phase 2b | ガントビュー（4軸切替） | 未着手 |
| Phase 3 | カード型編集UI | 未着手 |
| Phase 4 | G工番・月次レポート連携 | 未着手 |

## ローカル開発

```bash
git clone git@github.com:msakamoto-alt/besterra-allocation.git
cd besterra-allocation
python -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

## ライセンス

社内専有。Proprietary - Besterra Internal Use Only. See LICENSE.

## 連絡先

坂本 匡司（m.sakamoto@besterra.co.jp）
