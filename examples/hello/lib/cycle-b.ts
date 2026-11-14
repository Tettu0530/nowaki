import { a } from "./cycle-a.ts";
export function b(): string {
  return "b";
}
// An import cycle (cycle-a imports cycle-b, and cycle-b imports cycle-a) is fine here: a() is only
// called at runtime, after both modules have loaded.
export function full(): string {
  return a();
}
