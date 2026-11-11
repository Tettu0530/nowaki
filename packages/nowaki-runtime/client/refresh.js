// Fast Refresh runtime for `nowaki dev` (never part of a build). The dev transform (oxc's React
// Refresh transform) makes every app module register its components here:
//   $RefreshReg$(Counter, "<module url> Counter")   -> register()
//   _s(Counter, "useState{[n, setN](0)}")            -> the hook signature, via $RefreshSig$()
// Each component id is a family. An options.vnode hook replaces a registered function with the
// family's stable proxy, so a new version of the module only swaps `family.current`: the proxy's
// instances keep their hook state and render the new code. A changed hook signature remounts
// the family's instances (state resets, as in React Refresh). Public Preact API only (options,
// Component, h), so it works on Preact 10 and 11.

import { Component, h, options } from "preact";

// One registry per page, even if this module were loaded under two URLs.
const R = (globalThis.__nowakiRefresh ??= {
  families: new Map(), // id -> family
  byType: new WeakMap(), // component function -> family
  sigs: new WeakMap(), // component or hook function -> { key, forceReset, getCustomHooks }
  pending: new Map(), // family -> its implementation before this update
  remount: false, // a registration this runtime can't swap in place (a class, memo, forwardRef)
  hooked: false,
});

// Plain function components only: classes and Preact's forwardRef / memo wrappers carry
// identity the proxy would hide.
function swappable(type) {
  return typeof type === "function" && !type.prototype?.render && !type.prototype?.isReactComponent && !type._forwarded;
}

function family(type, id) {
  const fam = { id, current: type, gen: 0, instances: new Set() };
  const name = type.displayName || type.name || "Component";
  // Holds the hook state: calls whichever implementation is current, as this component.
  function Inner(props, context) {
    return fam.current.call(this, props, context);
  }
  Inner.displayName = name;
  // Stable across versions; re-renders on an update and remounts Inner when `gen` moves.
  class Outer extends Component {
    constructor(props, context) {
      super(props, context);
      fam.instances.add(this);
    }
    componentWillUnmount() {
      fam.instances.delete(this);
    }
    render(props) {
      return h(Inner, { ...props, key: fam.gen });
    }
  }
  Outer.displayName = name;
  fam.Outer = Outer;
  return fam;
}

/// `$RefreshReg$` (scoped to the module URL by the transform's prelude).
export function register(type, id) {
  if (typeof type !== "function" || typeof id !== "string") return;
  let fam = R.families.get(id);
  if (!fam) {
    fam = family(type, id);
    R.families.set(id, fam);
  } else if (fam.current !== type) {
    if (!R.pending.has(fam)) R.pending.set(fam, fam.current);
    fam.current = type;
  }
  if (swappable(type)) R.byType.set(type, fam);
  else if (R.pending.has(fam)) R.remount = true;
}

/// `$RefreshSig$()`: one per component or custom hook. The module-level call records the hook
/// signature; the call at the top of each render (no arguments) does nothing.
export function $RefreshSig$() {
  return (type, key, forceReset, getCustomHooks) => {
    if (typeof key === "string") R.sigs.set(type, { key, forceReset: !!forceReset, getCustomHooks });
    return type;
  };
}

// The signature with the signatures of the custom hooks it calls, which may live in other modules.
function fullKey(type, seen = new Set()) {
  const sig = R.sigs.get(type);
  if (!sig) return "";
  let key = sig.key;
  if (typeof sig.getCustomHooks === "function") {
    let hooks = [];
    try {
      hooks = sig.getCustomHooks() || [];
    } catch {
      return key + "|?";
    }
    for (const hook of hooks) {
      if (typeof hook !== "function") key += "|?";
      else if (!seen.has(hook)) {
        seen.add(hook);
        key += "|" + fullKey(hook, seen);
      }
    }
  }
  return key;
}

/// Whether `type` renders through a family proxy (an island whose default export isn't one is
/// remounted instead).
export function isRefreshable(type) {
  return R.byType.has(type);
}

/// Applies the registrations since the last call: re-renders each changed family's instances,
/// remounting those whose hook signature changed. `remount` says the caller has to remount the
/// islands it re-imported (a class or wrapper component changed).
export function performRefresh() {
  const changed = [...R.pending];
  R.pending.clear();
  const remount = R.remount;
  R.remount = false;
  let reset = 0;
  for (const [fam, prev] of changed) {
    if (!swappable(fam.current)) continue; // `remount` is set
    if (fullKey(prev) !== fullKey(fam.current) || R.sigs.get(fam.current)?.forceReset) {
      fam.gen++;
      reset++;
    }
    for (const inst of fam.instances) inst.forceUpdate();
  }
  return { updated: changed.length, reset, remount };
}

if (!R.hooked) {
  R.hooked = true;
  const prev = options.vnode;
  options.vnode = (vnode) => {
    if (typeof vnode.type === "function") {
      const fam = R.byType.get(vnode.type);
      if (fam) vnode.type = fam.Outer;
    }
    if (prev) prev(vnode);
  };
}
