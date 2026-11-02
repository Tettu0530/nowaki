# Nowaki ロードマップ

> 方向性を示すものです。項目・順序・時期は予告なく変わります。設計の根拠は
> [DESIGN.md](./DESIGN.md)、各リリースの詳細は [CHANGELOG.md](./CHANGELOG.md) を参照。

## ビジョン

「Next.js の遅さへの構造的な答え」を、3つの柱で実現します。

1. **Rust ツールチェーン** — 変換・解決・バンドル・配信を oxc ベースの Rust が担い、起動とビルドを速く保つ。
2. **デフォルト JS ゼロ（Islands）** — ページはサーバーで描画し、明示した「島」だけがクライアントで動く。
3. **npm エコシステム互換** — SSR は Node に委譲し、既存の資産をそのまま使える。

**成功の指標（1.0 時点の目標）**: dev 起動 < 300ms、HMR 反映 < 100ms、典型ページのクライアント JS < 15KB(gzip)、実アプリでの採用実績。

## 現在地

**alpha（CLI / crates 0.12.x、crates.io / npm に公開済み）**。`npm create nowaki` で雛形を作り、`nowaki dev / build / start / prerender` が通しで動きます。ルーティング・loader/action・ミドルウェア・API・Islands・Jetstream（サーバーリアクティブ島）・サーバー関数・5種のデプロイアダプタ・プラグイン/仮想モジュールが揃っています。本番採用はまだ推奨しません（API は安定化の途中）。

## マイルストーン

各マイルストーンは「テーマ」と「Exit 基準」で定義します。完了済みの実装詳細は CHANGELOG を参照。

### v0.1 「Gust」: Public alpha ✅
世に出す。誰でも `npm create nowaki` → `nowaki dev` が動き、パッケージとドキュメントが公開されている。

### v0.2 「Breeze」: DX & 正しさ ✅
毎日使える開発体験。エラーオーバーレイ、CSS（`.css` import・scoped styles）、環境変数（`.env`、`PUBLIC_*` の露出制御）、コードフレーム診断、`modulepreload` マニフェスト。

### v0.3 「Squall」: ルーティング & データ ✅
ネストレイアウト（`_layout.tsx`）、ミドルウェア（`_middleware.ts`）、`action`（フォーム送信）、メソッド別 API ルート、島間 SPA ルーター、404/500 規約、`LoaderContext`。

### v0.4 「Monsoon」: バンドラーの深化 ✅
真のチャンクバンドリング + スコープホイスティング、ツリーシェイキング、永続ディスクキャッシュ、end-to-end ソースマップ、CSS Modules、アセット import とハッシュ、循環依存対応。

### v0.5 「Typhoon」: エコシステム & デプロイ ✅
デプロイアダプタ5種（node / static / bun / deno / cloudflare edge）、ストリーミング SSR、プラグイン変換フック、TSRX ブリッジ、`nowaki start` の Rust 本番ホットパス。

### v0.6 「Jetstream」: サーバーリアクティブ島 ★flagship ✅
**Jetstream islands** — 島が `export const live = { state, on }` を持つと、コンポーネント JS をクライアントに送らずに動く。状態はサーバーが WebSocket 接続ごとに保持し、HTML パッチを push。クライアント島（楽観 UI）と共存し、静的デプロイでは初期 SSR に劣化する。

### v0.7 「Beta」: 安定化の土台 ✅
`cargo test` スイート、再現可能なベンチマーク（[BENCHMARKS.md](./BENCHMARKS.md)）、信頼境界の明文化（[SECURITY.md](./SECURITY.md)）と CI の依存監査、SemVer 規律と [CHANGELOG.md](./CHANGELOG.md)。

### v0.8〜v0.9 「Beta」: 拡充・実用化 ✅
**サーバー関数（`"use server"` RPC）**、Next/Astro との head-to-head ベンチ + CI 回帰検出、テスト拡充（ルーター snapshot・Jetstream 負荷）、Jetstream の presence・接続スケール、**プラグイン仮想モジュール（resolveId / load）**、ドキュメントサイト（`/docs`）。

> 状態保持（prefresh）HMR は follow-up（島ホットスワップは既存）。TSRX 島の scoped CSS も継続。

### v0.10〜v0.12 「Beta」: DX・セキュリティ監査 ✅
`npm create nowaki` の対話ウィザードとテンプレート選択、dev/start のバナー。dev/prod サーバーの多段セキュリティ監査（ファイル読み取り、RPC の CSRF、CSWSH、live state の署名、ISR の Vary など 15 件）と、それを守る CI の回帰スイート（`scripts/security-e2e.mjs`）。

### v0.13 「Zephyr」: 足場固め
大きな機能を入れる前に、コードを読みやすく壊しにくくする。

**Exit 基準**: コメント方針が AGENTS.md に明文化され、コードがそれに沿っている。ルート列挙の実装が Rust 側で 1 か所になる。再接続しても live 島の状態が初期値に戻らない。

- [ ] コメント最小化（挙動の変更なし）
- [ ] `nowaki-core` にルート列挙を集約（typegen / prerender で共用、JS 側 routeTable との突き合わせテスト）
- [ ] SECURITY.md の再構成と、AGENTS.md への「Security invariants」節
- [ ] Rust フロントでの受信ヘッダの浄化（`x-forwarded-host` / `x-nowaki-*`、`NOWAKI_TRUST_PROXY`）
- [ ] Jetstream: patch に署名付き state を載せる（再接続で状態が初期値に戻る不具合の修正）
- [ ] Jetstream: セッションループの非同期化、sidecar のタイムアウトとエラー通知

### v0.14 「Gale」: Secure by default
設定しなくても安全側で動く。主張はすべて CI で毎 push 検証する。

**Exit 基準**: SECURITY.md の「既定で有効な防御」の各行に、実装箇所と CI のチェックが対応している。security-e2e が dev と prod の両方で同じチェックを通る。

- [ ] ページ action と非 GET リクエストの既定の Origin 検証（API ルートは段階導入、`export const csrf = false` で無効化）
- [ ] 既定のセキュリティヘッダ（nosniff / frame-ancestors / Referrer-Policy / COOP、ISR の HIT にも付ける）
- [ ] サーバー関数の本文と引数の上限、`serverFn(schema, impl)`（Standard Schema）、未検証の export への build 警告
- [ ] prod でのエラー内容の露出を減らす（`ServerFnError`）、live 署名鍵の運用強化（未設定の警告、`iat` と最大寿命）
- [ ] CI: 全モードで全チェック、edge 経路の単体テスト、`pnpm audit` を必須にする
- [ ] CSP nonce 対応（まず Report-Only から）

### v0.15 「Cyclone」: Jetstream 2 ★flagship
「npm エコシステムの LiveView、コンポーネント JS 0KB」を実用にする。フォームと入力、認証付きハンドラ、外部の変更を push する live query、接続をまたいで共有する状態（rooms）。

**Exit 基準**: 再接続とサーバー再起動をまたいで状態が続く。`publish()` で別の接続の島に patch が届く。2 タブの投票デモが、部屋単位の在席表示付きで動く。1000 接続のファンアウト p95 を BENCHMARKS.md に記録している。

- [ ] イベントの拡張（submit / input / change、debounce、keyed morph）
- [ ] 安定した署名鍵、stale 通知、resume token（任意）
- [ ] ハンドラからリクエスト文脈を読む（`getContext()`、`live.authorize`）
- [ ] Live queries（`subscribe` / `load` / `publish`、Node→Rust のイベント経路）
- [ ] Multiplayer rooms（`room` / `shared` / 部屋単位の presence）
- [ ] 単一プロセス前提で edge 非対応であることを docs に明記

### v0.16 「Chinook」: 数字で示す
差別化を数字とツールで示す。

**Exit 基準**: `nowaki build` がルートごとの first-load JS を表示し、予算を超えたら失敗する。TTFB と Jetstream のベンチ結果を docs に載せている。`nowaki dev` の MCP に Claude Code から接続できる。

- [ ] ルートごとのクライアント JS 予算（`export const budget`）
- [ ] build 時の「この島は live にできる」提案（live 判定の AST 化を含む）
- [ ] ISR / 静的ページを起動直後から Rust だけで返す（プリレンダの取り込み、ETag / 304、事前 gzip、TTFB 計測）
- [ ] `nowaki dev` の MCP エンドポイント（ルート、モジュールグラフ、直近のエラー）
- [ ] Jetstream の docs・デモ・ベンチの仕上げ

### v1.0 「Nowaki」: 安定版
**Exit 基準**: 公開 API の安定保証、完全なドキュメント、ガバナンス確立。

- [ ] 公開 API の安定保証 + 非互換ポリシー
- [ ] 完全なドキュメントと移行ガイド
- [ ] ガバナンス（メンテナ体制、RFC プロセス、リリース手順）
- [ ] LTS / サポートポリシー

## 横断的に続くこと

マイルストーンを縦糸とすると、以下は横糸として常時進みます。

- **DX** — HMR、エラー表示、CLI 体験、型補完（`.d.ts`）、テンプレート拡充
- **性能** — バンドルグラフ、キャッシュ、ソースマップ、ベンチ回帰検出
- **エコシステム** — アダプタ、プラグイン API、TSRX
- **品質** — テスト、`cargo audit` / `pnpm audit`、セキュリティレビュー
- **コミュニティ** — ドキュメント、レシピ、RFC、コントリビュータ導線
