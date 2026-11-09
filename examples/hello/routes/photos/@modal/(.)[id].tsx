// An intercepting route: client navigation from /photos to /photos/[id] will show this in the
// slot instead of loading the full page. Recorded by the router, not served yet.
export default function InterceptedPhoto({ params }: { params: { id: string } }) {
  return <aside id="photo-intercepted">intercepted {params.id}</aside>;
}
