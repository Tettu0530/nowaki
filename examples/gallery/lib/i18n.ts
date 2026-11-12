// A tiny dictionary keyed by getLocale(). It runs on the server and in islands (getLocale from
// /navigation reads the request's locale on the server and <html> in the browser). The Japanese
// strings are \u escapes because this repo is English-only; an app would write them as is.
import { getLocale, localePath, type Href } from "@nowaki-dev/runtime/navigation";

const en = {
  gallery: "Gallery",
  allPhotos: "All photos",
  close: "Close",
  account: "Account",
  signIn: "Sign in",
  signOut: "Sign out",
  password: "Password",
  wrongPassword: "Wrong password",
  signedInAs: "Signed in as",
  posts: "Posts",
  caption: "Caption",
  save: "Save",
  signInToEdit: "Sign in to edit the caption.",
  allPosts: "All posts",
  like: "Like",
};

// Gallery, all photos, close, account, sign in, sign out, password, wrong password, signed in as,
// posts, caption, save, "sign in to edit the caption", all posts, like.
const ja: typeof en = {
  gallery: "\u30AE\u30E3\u30E9\u30EA\u30FC",
  allPhotos: "\u3059\u3079\u3066\u306E\u5199\u771F",
  close: "\u9589\u3058\u308B",
  account: "\u30A2\u30AB\u30A6\u30F3\u30C8",
  signIn: "\u30ED\u30B0\u30A4\u30F3",
  signOut: "\u30ED\u30B0\u30A2\u30A6\u30C8",
  password: "\u30D1\u30B9\u30EF\u30FC\u30C9",
  wrongPassword: "\u30D1\u30B9\u30EF\u30FC\u30C9\u304C\u9055\u3044\u307E\u3059",
  signedInAs: "\u30ED\u30B0\u30A4\u30F3\u4E2D",
  posts: "\u6295\u7A3F",
  caption: "\u30AD\u30E3\u30D7\u30B7\u30E7\u30F3",
  save: "\u4FDD\u5B58",
  signInToEdit: "\u30ED\u30B0\u30A4\u30F3\u3059\u308B\u3068\u30AD\u30E3\u30D7\u30B7\u30E7\u30F3\u3092\u7DE8\u96C6\u3067\u304D\u307E\u3059\u3002",
  allPosts: "\u3059\u3079\u3066\u306E\u6295\u7A3F",
  like: "\u3044\u3044\u306D",
};

const dictionaries: Record<string, typeof en> = { en, ja };

export type Locale = "en" | "ja";
export const locales: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  // "Japanese", in Japanese.
  { code: "ja", label: "\u65E5\u672C\u8A9E" },
];

export function t(key: keyof typeof en): string {
  return (dictionaries[getLocale() ?? "en"] ?? en)[key];
}

// The basePath ("/gallery"). <Link>, ctx.redirect and href() from /navigation add it; reading a
// browser URL back (below) takes it off.
const base = import.meta.env.BASE_URL.replace(/\/$/, "");

/// The route path of a browser URL: no base, no locale prefix ("/gallery/ja/photo/1" → "/photo/1").
export function routePath(url: URL): Href {
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : url.pathname;
  return localePath(path, "en") as Href;
}
