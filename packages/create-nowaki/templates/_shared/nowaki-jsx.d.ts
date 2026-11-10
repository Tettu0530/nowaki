// Nowaki's additions to preact's JSX types. No need to edit.
// Extends preact's JSX.IntrinsicAttributes so client:* directives can go on any component.
// The import makes this file a module, which a `declare module "preact"` augmentation needs.
// The ambient asset declarations are in nowaki-env.d.ts, which must not be a module.
import "preact";

declare module "preact" {
  namespace JSX {
    interface IntrinsicAttributes {
      /** Hydrate on page load (default). */
      "client:load"?: boolean;
      /** Hydrate when idle, via requestIdleCallback. */
      "client:idle"?: boolean;
      /** Hydrate once visible, via IntersectionObserver. */
      "client:visible"?: boolean;
      /** Hydrate when the media query matches. e.g. client:media="(min-width: 768px)" */
      "client:media"?: string;
      /** Skip SSR and render on the client only (for islands using browser-only APIs). */
      "client:only"?: boolean;
    }
  }
}
