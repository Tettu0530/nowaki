import { a } from "./cycle-a.ts";
export function b(): string {
  return "b";
}
// Cycle edge: b imports a (fine, since it's referenced lazily at runtime)
export function full(): string {
  return a();
}
