// A route group: "(marketing)" adds no URL segment (this folder's pricing.tsx serves /pricing).
// Its layout wraps only the files inside the group, inside the root _layout.
export default function MarketingLayout({ children }: { children: unknown }) {
  return <div data-group="marketing">{children}</div>;
}
