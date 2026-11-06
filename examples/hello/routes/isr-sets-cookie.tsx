// ISR page whose loader sets a cookie. The response carries Set-Cookie, so it is per-user: it goes
// out as `cache-control: private, no-cache` (never shared by a CDN) and `nowaki start` doesn't
// cache it.
import type { LoaderContext } from "@nowaki-dev/runtime";

export const revalidate = 30;

let renders = 0;

export const loader = (ctx: LoaderContext) => {
  renders += 1;
  ctx.setCookie("visited", "1", { path: "/" });
  return { renders };
};

export default function IsrSetsCookie({ data }: { data: { renders: number } }) {
  return <p>RENDER={data.renders}</p>;
}
