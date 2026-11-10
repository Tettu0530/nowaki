// The slot's file for /photos/[id]: on a full page load it renders beside photos/[id].tsx.
// Its loader gets the slot's own params; its CSS is linked like the page's.
import "./modal.css";

export function loader(ctx: { params: { id: string } }) {
  return { caption: `caption of ${ctx.params.id}` };
}

export default function PhotoModal({ data, params }: { data: { caption: string }; params: { id: string } }) {
  return (
    <aside id="photo-modal" class="photo-modal">
      modal {params.id}: {data.caption}
    </aside>
  );
}
