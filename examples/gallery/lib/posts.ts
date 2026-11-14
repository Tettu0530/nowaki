// A post per photo: the photo and a caption a signed-in user can edit. The captions live in this
// server process's memory (an app would use a database), so an edit lasts until a restart.
import { getLocale } from "@nowaki-dev/runtime/navigation";

// "A dune at noon.", "The sea from the cliff.", "Dusk over the town.", in English and Japanese.
const defaults: Record<string, { en: string; ja: string }> = {
  "1": { en: "A dune at noon.", ja: "\u663c\u306e\u7802\u4e18\u3002" },
  "2": { en: "The sea from the cliff.", ja: "\u5d16\u304b\u3089\u898b\u305f\u6d77\u3002" },
  "3": { en: "Dusk over the town.", ja: "\u753a\u306e\u5915\u66ae\u308c\u3002" },
};

const edited = new Map<string, string>();

export const CAPTION_MAX = 200;

// The caption in the request's locale, or the edited one (which replaces both).
export function caption(id: string): string {
  const own = defaults[id];
  return edited.get(id) ?? (getLocale() === "ja" ? own?.ja : own?.en) ?? "";
}

export function setCaption(id: string, text: string): void {
  edited.set(id, text);
}
