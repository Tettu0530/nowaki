// Parallel routes: photos/@modal/ is a slot of this layout. Its file matching the URL (or its
// default.tsx) renders beside the page and arrives here as `slots.modal`.
import type { LayoutProps } from "@nowaki-dev/runtime";

export default function PhotosLayout({ children, slots }: LayoutProps) {
  return (
    <div data-photos>
      {children}
      {slots.modal}
    </div>
  );
}
