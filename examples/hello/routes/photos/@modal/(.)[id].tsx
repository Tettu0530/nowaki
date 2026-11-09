// An intercepting route: client navigation from /photos to /photos/[id] shows this in the slot
// (the URL changes, the list stays); a reload or a direct visit renders photos/[id].tsx.
export default function InterceptedPhoto({ params }: { params: { id: string } }) {
  return <aside id="photo-intercepted">intercepted {params.id}</aside>;
}
