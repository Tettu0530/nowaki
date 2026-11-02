// サーバー関数（`"use server"`）の dispatch。`POST /__nowaki/fn` の `{ id, args }` の id を
// allowlist で引き、`getContext()` が使える AsyncLocalStorage の中で実行する。
//
// セキュリティ: 呼べるのは allowlist にある id（= `"use server"` モジュールの export）だけ。
// クライアントが module/export を指定して任意の関数を呼ぶことはできない。

import { AsyncLocalStorage } from "node:async_hooks";

export const SERVER_FN_PATH = "/__nowaki/fn";

const JSON_CT = { "content-type": "application/json; charset=utf-8" };

const als = new AsyncLocalStorage();

/// サーバー関数の中から呼ぶと、その呼び出しの LoaderContext を返す（無ければ null）。
/// 例: 認証・cookie 読み取り。`import { getContext } from "@nowaki-dev/runtime/server/functions.mjs"`
export function getContext() {
  return als.getStore() ?? null;
}

/// `/__nowaki/fn` を処理する。`sf` は `{ lookup(id, version), importModule(module, version) }`。
/// 各エントリポイント（dev/prod/edge）が sf の中身を環境ごとに用意する。
export async function dispatchServerFn(ctx, info, sf) {
  if (ctx.method !== "POST") {
    return errBody(405, "Method Not Allowed");
  }
  // CSRF 対策。他オリジンのページから victim の cookie 付きで呼ばれるのを三重に防ぐ:
  //  (1) Content-Type は application/json 必須（text/plain 等の "単純リクエスト" を排除）
  //  (2) カスタムヘッダ x-nowaki-rpc 必須（プリフライトが要るが CORS 許可を返さないので弾かれる）
  //  (3) Origin があれば Host と同一オリジンのみ許可
  // substring 一致だと `multipart/form-data; boundary=application/json` を取りこぼすので、
  // `;` より前のメディアタイプ本体で厳密判定する。
  const ct = String(ctx.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (ct !== "application/json") {
    return errBody(415, "Unsupported Media Type");
  }
  if (ctx.get("x-nowaki-rpc") !== "1") {
    return errBody(403, "Forbidden");
  }
  // Rust フロントは転送時に Host を剥がすので、元のブラウザ Host は x-forwarded-host を優先する。
  // どちらも無ければ比較不能なので Origin 検証は省略し、上の rpc ヘッダ + JSON 必須で防ぐ。
  const origin = ctx.get("origin");
  const host = ctx.get("x-forwarded-host") ?? ctx.get("host");
  if (origin && host && !sameOrigin(origin, host)) {
    return errBody(403, "cross-origin request forbidden");
  }
  let payload = null;
  try {
    payload = await ctx.bodyJson();
  } catch {
    payload = null;
  }
  const id = payload && typeof payload.id === "string" ? payload.id : null;
  const args = payload && Array.isArray(payload.args) ? payload.args : [];
  if (!id) {
    return errBody(400, "Bad Request: missing id");
  }
  const entry = await sf.lookup(id, info.version);
  if (!entry) {
    return errBody(404, "unknown server function");
  }
  try {
    const mod = await sf.importModule(entry.module, info.version);
    const fn = mod[entry.export];
    if (typeof fn !== "function") {
      return errBody(500, `server function is not a function: ${entry.export}`);
    }
    const result = await als.run(ctx, () => fn(...args));
    return {
      status: 200,
      headers: JSON_CT,
      body: JSON.stringify({ result: result === undefined ? null : result }),
    };
  } catch (err) {
    // 実装の詳細（スタック）はクライアントへ返さない。message のみ。
    return errBody(500, String(err?.message ?? err));
  }
}

function errBody(status, message) {
  return { status, headers: JSON_CT, body: JSON.stringify({ error: message }) };
}

function sameOrigin(origin, host) {
  if (!host) return false;
  const i = origin.indexOf("://");
  const originHost = i >= 0 ? origin.slice(i + 3).replace(/\/$/, "") : origin;
  return originHost === host;
}
