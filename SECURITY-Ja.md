# セキュリティポリシー

<div align="right">

[**English version →**](./SECURITY.md)

</div>

Nowaki は **Rust HTTP フロント**（`dev` / `start`）と **Node サイドカー**（SSR、プラグイン）から成るフルスタックフレームワークです。本番トラフィックは `nowaki start` またはデプロイアダプターの出力に向けるべきであり、`nowaki dev` 向けではありません。本ドキュメントでは、報告方法、信頼境界、およびフレームワークがデフォルトで適用する防御について説明します。

## サポート対象バージョン

Nowaki はアルファ版です。セキュリティ修正は最新リリース（および `main`）のみに提供されます。

## 脆弱性の報告

セキュリティ上の問題は **dev@voredge.com** へ非公開で報告してください。公開 GitHub Issue は開かないでください。再現手順と影響を受けるバージョンまたはコミットを含めてください。72 時間以内の受領確認を目指します。

開発サーバー（`nowaki dev`）は **開発用ツール** です。設計上、ローカルファイルシステムからファイルを配信します（例: `/@fs/`）。信頼できないネットワークに公開してはいけません。開発サーバーに関する報告も歓迎しますが、本番向けの問題（`nowaki build` の出力、SSR ランタイム、アダプター）を優先します。

## 信頼境界

### Rust フロントと Node サイドカー

| コンポーネント | 役割 | 公開範囲 |
|-----------|------|----------|
| `nowaki dev` / `nowaki start`（Rust） | HTTP 入口、静的アセット、ISR キャッシュ、Jetstream WS、サイドカーへのプロキシ | 本番ではユーザー向け（`start`）、開発では localhost のみ（`dev`）が想定 |
| SSR / 本番サイドカー（`packages/nowaki-runtime/server`） | ルートレンダリング、サーバー関数、アクション | **127.0.0.1** のエフェメラルポート。Rust プロセス経由でのみ到達 |
| プラグインホスト | dev/build 時の `nowaki.config` 変換 | localhost のみ |
| Jetstream `/__nowaki/live-render` | ライブアイランドの再評価 | localhost のみ。Rust から呼び出し |

サイドカーはネットワークインターフェースに直接公開する設計ではありません。

### 開発専用の表面

- **`/@fs/`** — 許可されたルート（アプリルート、ワークスペースルート）配下のファイルを配信し、オンデマンド変換と pnpm の realpath に対応します。正規化、allow-root、deny-list によるゲートがあります（`crates/nowaki/src/dev.rs` 参照）。**本番では有効になりません**（`nowaki start` とアダプターは `dist/` のみ配信）。
- **`/__nowaki/ssr-module`** — 開発 SSR ローダー。パス許可は `@fs` ポリシーと同様。
- **仮想モジュール** — プラグインブリッジ経由で解決。URL パス内の traversal は拒否。

`nowaki dev` は **localhost のみ**（または `--host` で LAN 公開する場合は、拡大した攻撃面を理解した上）として扱ってください。

### 本番のアセット配信

- **`/_nowaki/<file>`** — `dist/client` に対する **ベース名** で解決するため、`../` でクライアント出力ディレクトリ外へ逃げられません（`crates/nowaki/src/start.rs`）。

### シークレットとクライアントに見える環境変数

- クライアントバンドルにインラインされるのは `import.meta.env.PUBLIC_*` と `MODE` のみです。その他の `.env` 値はサーバー側に留まります。`.env*` ファイルは gitignore 対象です。
- サーバー関数のエラーは **`error.message` のみ** を返し、スタックは返しません（`packages/nowaki-runtime/server/functions.mjs`）。

### ビルド時に信頼するコード

プラグイン（`nowaki.config`）と TSRX（`@tsrx/preact`）は dev/build 中に Node 上で、プロジェクトと同じ権限で動きます。通常のビルド依存と同様に扱ってください。アプリに出力を埋め込まない限り、本番リクエストパスでは動きません。

### アプリケーション作者の責任

フレームワークのデフォルトは、アプリ側のチェックに取って代わりません。

- **サーバー関数（`"use server"`）** — RPC は許可リストのみですが、各 export は公開エンドポイントです。JSON 引数を検証し、`getContext()`（Cookie / ヘッダー）で認可してください。
- **Jetstream `on` ハンドラー** — 状態は WebSocket 接続ごとにサーバー側に保持されます。通常のサーバーハンドラーと同様にイベントペイロードを検証してください。
- **アクション / API ルート** — 一般的な Web アプリと同様、CSRF と認証は（下表の防御が適用されない限り）アプリの責任です。

## デフォルトで有効な防御

以下は現時点でリポジトリに実装されています。ROADMAP v0.14 では **各行** を dev と prod の両方で自動 CI チェックに対応させることを目指しています。カバレッジは最終列に記載します。

| 防御 | 制限する内容 | 主な実装箇所 | CI での回帰 |
|---------|----------------|------------------|---------------|
| `@fs` / `ssr-module` の allow root + 機密パス deny | dev URL 経由の任意ファイル読み取り | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs`（dev） |
| dev フォールバックが `.env` を配信しない | catch-all 経由のシークレットファイル漏洩 | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs`（dev） |
| 仮想モジュールの `..` 拒否 | プラグイン URL における path traversal | `crates/nowaki/src/dev.rs` | `scripts/security-e2e.mjs`（dev） |
| サーバー関数許可リスト | 任意のサーバー export の呼び出し | `nowaki-core` + `dist/server/functions.json` + `functions.mjs` | e2e（未知 id の `/__nowaki/fn` → 404） |
| RPC CSRF ゲート（JSON + `x-nowaki-rpc` + Origin/Host） | 被害者 Cookie 付きクロスサイト POST | `packages/nowaki-runtime/server/functions.mjs`；Rust がサイドカー hop で `x-forwarded-host` をブラウザの `Host` から設定 | `scripts/security-e2e.mjs`（dev） |
| WebSocket Origin チェック（CSWSH） | HMR / Jetstream へのクロスオリジンアップグレード | `crates/nowaki/src/dev.rs`、`crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs`（dev） |
| Jetstream 状態署名 | レンダー/ハンドラーで使われる偽造 live 状態 | `server/live.mjs`（各 render/handler 前に検証）；`crates/nowaki/src/live.rs`（セッションごとに状態保持） | `scripts/security-e2e.mjs`（dev） |
| ISR キャッシュキー + `Vary` 学習 | ユーザー間 HTML キャッシュの混線 | `server/context.mjs`（`__vary()`）、`server/handler.mjs`（`x-nowaki-vary`）；`crates/nowaki/src/start.rs`（`isr_key`）；例: `examples/hello/routes/vary.tsx` | `scripts/security-e2e.mjs`（prod） |
| ISR クエリの折りたたみ | 異なるクエリ文字列によるキャッシュ flood | `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs`（prod） |
| 静的クライアントアセット（ベース名） | `/_nowaki/*` 上の path traversal | `crates/nowaki/src/start.rs` | `scripts/security-e2e.mjs`（prod） |
| 依存関係のアドバイザリ | 既知の脆弱な crate / パッケージ | `.github/workflows/ci.yml` | `cargo audit`、`cargo-deny`、`pnpm audit` ジョブ |

**予定（未デフォルト）:** インバウンドプロキシヘッダーのサニタイズ（`NOWAKI_TRUST_PROXY`）、デフォルトセキュリティヘッダー（CSP、`X-Frame-Options` など）、prod における `security-e2e` の拡大 — [ROADMAP.md](./ROADMAP.md) v0.13–v0.14 を参照。

## 依存関係の監査

CI は push 時（および日次スケジュール）に `cargo audit`、`cargo-deny`、`pnpm audit` を実行します。ローカルでは:

```bash
cargo audit
pnpm audit --prod
```

## 関連ドキュメント

- コードベース変更時のエージェント向け不変条件: [AGENTS.md](./AGENTS.md#security-invariants)（英語）
- アーキテクチャとデータフロー: [DESIGN.md](./DESIGN.md)（英語）
- 方向性とセキュリティマイルストーンの完了条件: [ROADMAP.md](./ROADMAP.md)（英語）
