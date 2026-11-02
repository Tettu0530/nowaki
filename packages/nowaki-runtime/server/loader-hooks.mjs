// Node module loader hooks。変換器を Rust 一本に統一するため、.tsx/.ts を
// Rust dev サーバーの変換エンドポイントから取得して ESM として返す (vite-node 方式)。

const RUST = `http://127.0.0.1:${process.env.NOWAKI_RUST_PORT ?? "3000"}`;
const TS_RE = /\.(tsx|ts|jsx|tsrx)$/;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  // 親モジュールの ?v= (HMR世代) を相対importへ伝播し、変更後の再評価を強制する
  if (context.parentURL && result.url.startsWith("file:")) {
    const parentV = safeParam(context.parentURL, "v");
    if (parentV) {
      const url = new URL(result.url);
      if (TS_RE.test(url.pathname) && !url.searchParams.get("v")) {
        url.searchParams.set("v", parentV);
        return { ...result, url: url.href, shortCircuit: true };
      }
    }
  }
  return result;
}

export async function load(url, context, nextLoad) {
  const u = new URL(url);
  if (u.protocol === "file:" && TS_RE.test(u.pathname)) {
    const v = u.searchParams.get("v") ?? "0";
    // u.pathname はパーセントエンコード済み（[slug] → %5Bslug%5D）。実ファイルパスへ復号する。
    const fsPath = decodeURIComponent(u.pathname);
    const endpoint = `${RUST}/__nowaki/ssr-module?path=${encodeURIComponent(fsPath)}&v=${v}`;
    const res = await fetch(endpoint);
    if (!res.ok) {
      throw new Error(`[nowaki] SSR変換に失敗 (${fsPath}): ${await res.text()}`);
    }
    return { format: "module", source: await res.text(), shortCircuit: true };
  }
  return nextLoad(url, context);
}

function safeParam(href, key) {
  try {
    return new URL(href).searchParams.get(key);
  } catch {
    return null;
  }
}
