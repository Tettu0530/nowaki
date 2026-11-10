// Closing the modal goes back in history: the router puts the gallery's slot back as it was.
export default function CloseButton({ label }: { label: string }) {
  return (
    <button type="button" id="close" class="close" onClick={() => history.back()}>
      {label}
    </button>
  );
}
