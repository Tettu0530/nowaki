// ISR + cookie-dependent route. The page differs per visitor, so it must never be marked
// shareable: the response says `cache-control: private` (a CDN in front could otherwise serve
// one visitor's page to the next). `nowaki start` still caches it per cookie value internally.
import type { LoaderContext } from "@nowaki-dev/runtime";

export const revalidate = 30;

export const loader = (ctx: LoaderContext) => ({ user: ctx.cookies.user ?? "guest" });

export default function IsrCookie({ data }: { data: { user: string } }) {
  return <p>USER={data.user}</p>;
}
