// JSX types for `"jsxImportSource": "@nowaki-dev/runtime"` (the scaffolded tsconfig.json): Preact's
// JSX with `<form action>` also taking a server function. Types only for Nowaki itself, whose
// transform always imports `preact/jsx-runtime`; the JS module re-exports Preact's for other
// tools that read jsxImportSource (a test runner, say).
//
// Preact types `action` as a string, and a module augmentation can't widen a property's type, so
// this is a JSX namespace of its own built from Preact's: augmentations of `preact`'s JSX (the
// `client:*` attributes in nowaki-jsx.d.ts) still apply.

import type { ComponentType, JSX as PreactJSX } from "preact";

export { Fragment, jsx, jsxDEV, jsxs } from "preact/jsx-runtime";

/**
 * A server function (an export of a `"use server"` module) as `<form action={fn}>` in an island:
 * on submit the form's fields go to it as a plain object, and the result arrives as a
 * `nowaki:action` event on the form (`detail: { id, ok, result, error }`).
 */
export type ServerFormAction = (input: any) => unknown;

type PreactForm = PreactJSX.IntrinsicElements["form"];

/** `<form>` attributes, with `action` also taking a {@link ServerFormAction}. */
export interface FormAttributes extends Omit<PreactForm, "action"> {
  action?: PreactForm["action"] | ServerFormAction;
}

export namespace JSX {
  type LibraryManagedAttributes<Component, Props> = PreactJSX.LibraryManagedAttributes<Component, Props>;
  interface IntrinsicAttributes extends PreactJSX.IntrinsicAttributes {}
  type ElementType<P = any> =
    | { [K in keyof IntrinsicElements]: P extends IntrinsicElements[K] ? K : never }[keyof IntrinsicElements]
    | ComponentType<P>;
  interface Element extends PreactJSX.Element {}
  type ElementClass = PreactJSX.ElementClass;
  interface ElementAttributesProperty extends PreactJSX.ElementAttributesProperty {}
  interface ElementChildrenAttribute extends PreactJSX.ElementChildrenAttribute {}
  interface IntrinsicElements extends Omit<PreactJSX.IntrinsicElements, "form"> {
    form: FormAttributes;
  }
}
