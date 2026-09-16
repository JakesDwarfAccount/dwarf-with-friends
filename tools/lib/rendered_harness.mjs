// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeRequire = createRequire(import.meta.url);
const REALMS = new WeakMap();
const BLOCKED = new Set(["process", "Buffer", "global", "require", "__filename", "__dirname"]);
const HOST_GLOBALS = [
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "Blob", "File", "FormData",
  "Headers", "Request", "Response", "fetch", "atob", "btoa", "crypto", "performance",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "Date",
];
const DEFAULT_SAFE = vm.runInNewContext("({Object,Function,Array})");
const hostToSafe = new WeakMap();
const safeToHost = new WeakMap();
const hostOriginals = new WeakMap();
const realmToHost = new WeakMap();
const realmFunctions = new WeakMap();
const protectedHosts = new WeakMap();

function realmCache(caches, safe) {
  if (!caches.has(safe)) caches.set(safe, new WeakMap());
  return caches.get(safe);
}

function protectHost(value, safe = DEFAULT_SAFE) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const cache = realmCache(protectedHosts, safe);
  if (cache.has(value)) return cache.get(value);
  if (typeof value === "function") {
    const fn = new Proxy(function () {}, {
      get(_target, property) {
        if (property === "constructor") return safe.Function;
        return protectHost(Reflect.get(value, property, value), safe);
      },
      apply(_target, thisArg, args) { return Reflect.apply(value, thisArg, args); },
      construct(_target, args) { return Reflect.construct(value, args); },
    });
    cache.set(value, fn);
    return fn;
  }
  if (Array.isArray(value)) {
    const array = [];
    cache.set(value, array);
    value.forEach(item => array.push(protectHost(item, safe)));
    if (Object.isFrozen(value)) Object.freeze(array);
    return array;
  }
  const object = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  cache.set(value, object);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ("value" in descriptor) descriptor.value = protectHost(descriptor.value, safe);
    if (descriptor.get) descriptor.get = protectHost(descriptor.get, safe);
    if (descriptor.set) descriptor.set = protectHost(descriptor.set, safe);
    Object.defineProperty(object, key, descriptor);
  }
  if (Object.isFrozen(value)) Object.freeze(object);
  return object;
}

function fromRealm(value, safe = DEFAULT_SAFE) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (safeToHost.has(value)) return safeToHost.get(value);
  if (hostOriginals.has(value)) return hostOriginals.get(value);
  if (typeof value === "function") {
    if (realmFunctions.has(value)) return realmFunctions.get(value);
    const wrapped = function (...args) {
      return safeHost(Reflect.apply(value, safeHost(this, safe), args.map(arg => safeHost(arg, safe))), safe);
    };
    realmFunctions.set(value, wrapped);
    return wrapped;
  }
  if (realmToHost.has(value)) return realmToHost.get(value);
  if (ArrayBuffer.isView(value)) {
    if (Object.prototype.toString.call(value) === "[object DataView]") {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return new DataView(Uint8Array.from(bytes).buffer);
    }
    const name = value.constructor?.name === "Buffer" ? "Uint8Array" : value.constructor?.name;
    const Ctor = globalThis[name] || Uint8Array;
    return new Ctor(Array.from(value));
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]")
    return Uint8Array.from(new Uint8Array(value)).buffer;
  if (Array.isArray(value)) {
    const result = [];
    realmToHost.set(value, result);
    value.forEach(item => result.push(fromRealm(item, safe)));
    return result;
  }
  const result = {};
  realmToHost.set(value, result);
  for (const key of Reflect.ownKeys(value)) result[key] = fromRealm(value[key], safe);
  return result;
}

function safeHostResult(operation, safe = DEFAULT_SAFE) {
  try { return safeHost(operation(), safe); }
  catch (error) { throw safeHost(error, safe); }
}

function safeHost(value, safe = DEFAULT_SAFE) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (safeToHost.has(value)) return value;
  hostOriginals.set(value, value);
  const cache = realmCache(hostToSafe, safe);
  if (cache.has(value)) return cache.get(value);
  if (typeof value === "function") {
    // A proxy around the host function itself must expose its non-configurable `prototype`
    // descriptor unchanged. That gives browser code the real Node prototype, and the familiar
    // `.constructor.constructor(...)` chain escapes the VM. Proxy a harmless shell instead, then
    // forward calls and configurable static properties to the host function through the membrane.
    const shell = function () {};
    let proxy;
    proxy = new Proxy(shell, {
      get(target, property) {
        const own = Reflect.getOwnPropertyDescriptor(target, property);
        if (own && !own.configurable && "value" in own && !own.writable) return own.value;
        if (property === "constructor") return safe.Function;
        if (property === "prototype") return Reflect.get(target, property, target);
        return safeHostResult(() => Reflect.get(value, property, value), safe);
      },
      set(target, property, next) {
        if (property === "prototype") return Reflect.set(target, property, next, target);
        return Reflect.set(value, property, unsafeHost(next), value);
      },
      has(target, property) { return Reflect.has(target, property) || Reflect.has(value, property); },
      ownKeys(target) { return [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(value)])]; },
      getOwnPropertyDescriptor(target, property) {
        const local = Reflect.getOwnPropertyDescriptor(target, property);
        if (local && !local.configurable) return local;
        const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
        if (!descriptor) return local;
        const wrapped = { ...descriptor, configurable: true };
        if ("value" in wrapped) wrapped.value = safeHost(wrapped.value, safe);
        if (wrapped.get) wrapped.get = safeHost(wrapped.get, safe);
        if (wrapped.set) wrapped.set = safeHost(wrapped.set, safe);
        return wrapped;
      },
      getPrototypeOf() { return safe.Function.prototype; },
      apply(_target, thisArg, args) {
        const originalThis = unsafeHost(thisArg);
        const callArgs = originalThis instanceof Promise ? args.map(unsafeHost) : args.map(arg => fromRealm(arg, safe));
        return safeHostResult(() => Reflect.apply(value, originalThis, callArgs), safe);
      },
      construct(_target, args) {
        return safeHostResult(() => Reflect.construct(value, args.map(arg => fromRealm(arg, safe))), safe);
      },
    });
    cache.set(value, proxy);
    safeToHost.set(proxy, value);
    Reflect.set(shell, "prototype", safeHost(value.prototype, safe));
    return proxy;
  }
  const hasProtectedInvariant = Reflect.ownKeys(value).some((property) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
    if (!descriptor || descriptor.configurable) return false;
    if (descriptor.get || descriptor.set) return true;
    return (typeof descriptor.value === "object" || typeof descriptor.value === "function") &&
      descriptor.value !== null;
  });
  if (hasProtectedInvariant && !Object.isFrozen(value)) {
    // A non-configurable object-valued property has the same proxy invariant as a function's
    // `prototype`: proxying the host object directly would force descriptor reflection to return
    // the unwrapped Node value. A clean shell keeps every forwarded descriptor configurable while
    // reads, writes, calls, and construction still reach the original object through the membrane.
    const shell = Array.isArray(value) ? [] : {};
    let proxy;
    proxy = new Proxy(shell, {
      get(target, property) {
        const local = Reflect.getOwnPropertyDescriptor(target, property);
        if (local && !local.configurable && "value" in local && !local.writable) return local.value;
        if (property === "constructor") return Array.isArray(value) ? safe.Array : safe.Object;
        return safeHostResult(() => Reflect.get(value, property, value), safe);
      },
      set(_target, property, next) { return Reflect.set(value, property, unsafeHost(next), value); },
      has(target, property) { return Reflect.has(target, property) || Reflect.has(value, property); },
      ownKeys(target) { return [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(value)])]; },
      getOwnPropertyDescriptor(target, property) {
        const local = Reflect.getOwnPropertyDescriptor(target, property);
        if (local && !local.configurable) return local;
        const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
        if (!descriptor) return local;
        const wrapped = { ...descriptor, configurable: true };
        if ("value" in wrapped) wrapped.value = safeHost(wrapped.value, safe);
        if (wrapped.get) wrapped.get = safeHost(wrapped.get, safe);
        if (wrapped.set) wrapped.set = safeHost(wrapped.set, safe);
        return wrapped;
      },
      getPrototypeOf() { return Array.isArray(value) ? safe.Array.prototype : safe.Object.prototype; },
      deleteProperty(_target, property) { return Reflect.deleteProperty(value, property); },
      defineProperty(_target, property, descriptor) {
        const next = { ...descriptor };
        if ("value" in next) next.value = unsafeHost(next.value);
        if (next.get) next.get = unsafeHost(next.get);
        if (next.set) next.set = unsafeHost(next.set);
        return Reflect.defineProperty(value, property, next);
      },
    });
    cache.set(value, proxy);
    safeToHost.set(proxy, value);
    return proxy;
  }
  if (typeof value !== "function" && Object.isFrozen(value)) {
    const shadow = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      Object.defineProperty(shadow, key, { enumerable: !!descriptor.enumerable, configurable: true,
        writable: true, value: "value" in descriptor ? descriptor.value : Reflect.get(value, key, value) });
    }
    const proxy = safeHost(shadow, safe);
    cache.set(value, proxy);
    safeToHost.set(proxy, value);
    return proxy;
  }
  const proxy = new Proxy(value, {
    get(target, property) {
      const own = Reflect.getOwnPropertyDescriptor(target, property);
      if (own && !own.configurable && "value" in own && !own.writable) {
        if ((typeof own.value === "object" || typeof own.value === "function") && own.value !== null)
          hostOriginals.set(own.value, own.value);
        return own.value;
      }
      if (property === "constructor")
      return Array.isArray(target) ? safe.Array : safe.Object;
      return safeHostResult(() => Reflect.get(target, property, target), safe);
    },
    set(target, property, next) { return Reflect.set(target, property, unsafeHost(next), target); },
    has(target, property) { return Reflect.has(target, property); },
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (!descriptor) return descriptor;
      if (!descriptor.configurable) return descriptor;
      if ("value" in descriptor) descriptor.value = safeHost(descriptor.value, safe);
      if (descriptor.get) descriptor.get = safeHost(descriptor.get, safe);
      if (descriptor.set) descriptor.set = safeHost(descriptor.set, safe);
      return descriptor;
    },
    getPrototypeOf(target) {
      return Array.isArray(target) ? safe.Array.prototype : safe.Object.prototype;
    },
    apply(target, thisArg, args) {
      const originalThis = unsafeHost(thisArg);
      // Keep array iteration on the proxy so elements crossing into the browser realm are wrapped
      // consistently. Unwrapping here gives vm a fresh context wrapper on each pass, defeating
      // browser-side WeakMap identity and making repeated paints look like different DOM nodes.
      const receiver = Array.isArray(originalThis) ? thisArg : originalThis;
      const callArgs = originalThis instanceof Promise ? args.map(unsafeHost) : args.map(arg => fromRealm(arg, safe));
      return safeHostResult(() => Reflect.apply(target, receiver, callArgs), safe);
    },
  });
  cache.set(value, proxy);
  safeToHost.set(proxy, value);
  return proxy;
}

function unsafeHost(value) { return safeToHost.get(value) || value; }

function newState(facade) {
  const raw = {};
  const context = vm.createContext(raw, { codeGeneration: { strings: true, wasm: false } });
  const safe = vm.runInContext("({Object,Function,Array})", context);
  raw.window = raw; raw.self = raw; raw.globalThis = raw;
  const state = {
    facade, raw, context, safe, modules: new Map(), owned: new Set(), mirrors: new Map(),
    synced: new Set(), rawToHost: new WeakMap(), hostToRaw: new WeakMap(), view: null,
    realmUi: null, publicUi: null, directModules: new Map(),
  };
  state.view = new Proxy(raw, {
    get(target, property, receiver) {
      if (BLOCKED.has(property)) return undefined;
      if (property === "window" || property === "self" || property === "globalThis") return receiver;
      if (property === "constructor") return state.safe.Function;
      if (property === "DWFUI" && state.mirrors.has(property)) return state.mirrors.get(property);
      if (Reflect.has(target, property)) return bridge(state, Reflect.get(target, property, target));
      try { return bridge(state, vm.runInContext(String(property), context)); }
      catch (_) { return undefined; }
    },
    set(target, property, value) {
      if (BLOCKED.has(property)) return true;
      target[property] = toRealm(state, value);
      state.owned.add(property);
      facade[property] = value;
      state.mirrors.set(property, value);
      return true;
    },
    has(target, property) {
      if (BLOCKED.has(property)) return false;
      if (Reflect.has(target, property)) return true;
      try { return vm.runInContext(`typeof ${String(property)} !== "undefined"`, context); }
      catch (_) { return false; }
    },
    ownKeys(target) { return Reflect.ownKeys(target).filter((property) => !BLOCKED.has(property)); },
    getOwnPropertyDescriptor(target, property) {
      if (BLOCKED.has(property)) return undefined;
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (!descriptor) return descriptor;
      if ("value" in descriptor) descriptor.value = bridge(state, descriptor.value);
      return descriptor;
    },
  });
  return state;
}

function toRealm(state, value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (state.hostToRaw.has(value)) return state.hostToRaw.get(value);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      const Bytes = vm.runInContext("Uint8Array", state.context);
      const View = vm.runInContext("DataView", state.context);
      const bytes = new Bytes(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
      return new View(bytes.buffer);
    }
    const name = value.constructor.name === "Buffer" ? "Uint8Array" : value.constructor.name;
    const Ctor = vm.runInContext(name, state.context);
    return new Ctor(Array.from(value));
  }
  if (value instanceof ArrayBuffer) {
    const Ctor = vm.runInContext("Uint8Array", state.context);
    return new Ctor(new Uint8Array(value)).buffer;
  }
  return safeHost(value, state.safe);
}

function bridgeResult(state, operation) {
  try { return bridge(state, operation()); }
  catch (error) { throw bridge(state, error); }
}

function bridge(state, value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (safeToHost.has(value)) {
    const original = safeToHost.get(value);
    if (typeof original === "function" || Object.getPrototypeOf(original) === Object.prototype ||
        Object.getPrototypeOf(original) === null || Object.getPrototypeOf(original) === Array.prototype ||
        original instanceof Error || original instanceof Map || original instanceof Set || ArrayBuffer.isView(original)) return original;
    value = original;
  }
  if (state.rawToHost.has(value)) return state.rawToHost.get(value);
  if (typeof value === "function") {
    const fn = new Proxy(function () {}, {
      get(_target, property) {
        if (property === "constructor") return state.safe.Function;
        return bridge(state, Reflect.get(value, property, value));
      },
      apply(_target, thisArg, args) {
        syncFacade(state);
        return bridgeResult(state, () =>
          Reflect.apply(value, toRealm(state, thisArg), args.map((arg) => toRealm(state, arg))));
      },
      construct(_target, args) {
        syncFacade(state);
        return bridgeResult(state, () => Reflect.construct(value, args.map((arg) => toRealm(state, arg))));
      },
      getPrototypeOf() { return Function.prototype; },
    });
    state.rawToHost.set(value, fn); state.hostToRaw.set(fn, value);
    return fn;
  }
  if (typeof value.then === "function" && Object.prototype.toString.call(value) === "[object Promise]") {
    const promise = Promise.resolve(value).then((resolved) => bridge(state, resolved));
    state.rawToHost.set(value, promise); state.hostToRaw.set(promise, value);
    return promise;
  }
  if (Array.isArray(value)) {
    const array = [];
    state.rawToHost.set(value, array); state.hostToRaw.set(array, value);
    for (const item of value) array.push(bridge(state, item));
    if (Object.isFrozen(value)) Object.freeze(array);
    return array;
  }
  if (Object.prototype.toString.call(value) === "[object Map]") {
    const map = new Map();
    state.rawToHost.set(value, map); state.hostToRaw.set(map, value);
    for (const [key, item] of value) map.set(bridge(state, key), bridge(state, item));
    return map;
  }
  if (Object.prototype.toString.call(value) === "[object Set]") {
    const set = new Set();
    state.rawToHost.set(value, set); state.hostToRaw.set(set, value);
    for (const item of value) set.add(bridge(state, item));
    return set;
  }
  if (ArrayBuffer.isView(value)) {
    const name = value.constructor?.name === "Buffer" ? "Uint8Array" : value.constructor?.name;
    if (name === "DataView") {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return new DataView(Uint8Array.from(bytes).buffer);
    }
    const Ctor = globalThis[name] || Uint8Array;
    return new Ctor(Array.from(value));
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]")
    return Uint8Array.from(new Uint8Array(value)).buffer;
  if (Object.prototype.toString.call(value) === "[object Error]") {
    const error = new Error(value.message || "");
    error.name = value.name || "Error";
    if (value.stack) error.stack = value.stack;
    state.rawToHost.set(value, error); state.hostToRaw.set(error, value);
    return error;
  }
  if (!Object.isFrozen(value) && Object.hasOwn(value, "baked") &&
      Object.hasOwn(value, "sparse") && Object.hasOwn(value, "tt")) {
    const shell = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      Object.defineProperty(shell, key, { enumerable: !!descriptor?.enumerable, configurable: true,
        writable: true, value: bridge(state, Reflect.get(value, key, value)) });
    }
    const proxy = new Proxy(shell, {
      get(_target, property) { return bridge(state, Reflect.get(value, property, value)); },
      set(_target, property, next) {
        const changed = Reflect.set(value, property, toRealm(state, next), value);
        if (changed) Reflect.set(shell, property, next);
        return changed;
      },
      has(_target, property) { return Reflect.has(value, property); },
      ownKeys() { return [...new Set([...Reflect.ownKeys(shell), ...Reflect.ownKeys(value)])]; },
      getOwnPropertyDescriptor(_target, property) {
        const local = Reflect.getOwnPropertyDescriptor(shell, property);
        if (local) {
          local.value = bridge(state, Reflect.get(value, property, value));
          Reflect.set(shell, property, local.value);
          return local;
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
        if (!descriptor) return undefined;
        return { enumerable: !!descriptor.enumerable, configurable: true,
          writable: "writable" in descriptor ? !!descriptor.writable : true,
          value: "value" in descriptor ? bridge(state, descriptor.value) : bridge(state, Reflect.get(value, property, value)) };
      },
      deleteProperty(_target, property) { return Reflect.deleteProperty(value, property); },
      getPrototypeOf() { return Object.getPrototypeOf(shell); },
    });
    state.rawToHost.set(value, proxy); state.hostToRaw.set(proxy, value);
    return proxy;
  }
  const object = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  state.rawToHost.set(value, object); state.hostToRaw.set(object, value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ("value" in descriptor) descriptor.value = bridge(state, descriptor.value);
    if (descriptor.get) descriptor.get = bridge(state, descriptor.get);
    if (descriptor.set) descriptor.set = bridge(state, descriptor.set);
    try { Object.defineProperty(object, key, descriptor); } catch (_) { object[key] = descriptor.value; }
  }
  if (Object.isFrozen(value)) Object.freeze(object);
  return object;
}

function syncFacade(state, supplied = null) {
  for (const key of state.synced) {
    if (!Object.hasOwn(state.facade, key) && !state.owned.has(key)) {
      delete state.raw[key];
      state.synced.delete(key);
    }
  }
  const sources = supplied ? [state.facade, supplied] : [state.facade];
  for (const source of sources) {
    if (!source) continue;
    const keys = new Set(Object.keys(source));
    if (source === state.facade)
      HOST_GLOBALS.forEach(key => { if (Object.hasOwn(source, key)) keys.add(key); });
    for (const key of keys) {
      if (BLOCKED.has(key) || key === "window" || key === "self" || key === "globalThis") continue;
      const value = source[key];
      if (state.owned.has(key) && state.mirrors.get(key) === value) continue;
      if (state.owned.has(key) && supplied && Object.hasOwn(supplied, key)) continue;
      state.raw[key] = toRealm(state, value);
      if (source === state.facade && !state.owned.has(key)) state.synced.add(key);
    }
  }
  state.raw.window = state.raw; state.raw.self = state.raw; state.raw.globalThis = state.raw;
  delete state.raw.process; delete state.raw.Buffer; delete state.raw.global; delete state.raw.require;
}

function mirrorWrites(state, before) {
  for (const key of Object.keys(state.raw)) {
    if (BLOCKED.has(key) || key === "window" || key === "self" || key === "globalThis" ||
        key === "module" || key === "exports") continue;
    if (!before.has(key) || before.get(key) !== state.raw[key]) state.owned.add(key);
  }
  for (const key of state.owned) {
    const value = bridge(state, state.raw[key]);
    const descriptor = Object.getOwnPropertyDescriptor(state.facade, key);
    if (!descriptor || descriptor.writable || descriptor.set) state.facade[key] = value;
    state.mirrors.set(key, value);
  }
}

const documentStub = {
  readyState: "loading", addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; },
};

export function createRenderedHarness({ root = ROOT, globals = {}, storyMode = false } = {}) {
  const facade = globals.window || globalThis;
  let state = REALMS.get(facade);
  if (!state) { state = newState(facade); REALMS.set(facade, state); }
  syncFacade(state, globals);
  const browserRoot = path.resolve(root, "web/js") + path.sep;

  function execute(filename) {
    if (state.modules.has(filename)) return state.modules.get(filename);
    syncFacade(state);
    const before = new Map(Object.keys(state.raw).map((key) => [key, state.raw[key]]));
    const localModule = vm.runInContext("({exports:{}})", state.context);
    state.raw.module = localModule; state.raw.exports = localModule.exports; delete state.raw.require;
    try {
      const source = readFileSync(filename, "utf8");
      const wrapper = vm.runInContext(
        `(function(window,self,globalThis,module,exports,require){\n${source}\n})`, state.context,
        { filename });
      wrapper.call(state.raw, state.raw, state.raw, state.raw, localModule, localModule.exports, undefined);
    } catch (error) {
      throw bridge(state, error);
    } finally {
      delete state.raw.module; delete state.raw.exports; delete state.raw.require;
    }
    mirrorWrites(state, before);
    const exported = bridge(state, localModule.exports);
    state.modules.set(filename, exported);
    return exported;
  }

  const utilFile = path.resolve(root, "web/js/dwf-util.js");
  const uiFile = path.resolve(root, "web/js/dwf-ui-components.js");
  const DwfUtil = execute(utilFile);
  if (!state.realmUi) state.realmUi = execute(uiFile);
  const realmDWFUI = state.realmUi;
  if (!state.publicUi) {
    const uiResolved = nodeRequire.resolve(uiFile);
    delete nodeRequire.cache[uiResolved];
    state.publicUi = protectHost(nodeRequire(uiResolved), state.safe);
  }
  const DWFUI = state.publicUi;
  state.raw.DwfUtil = toRealm(state, DwfUtil); state.raw.DwfErr = toRealm(state, DwfUtil.DwfErr);
  state.raw.DWFUI = toRealm(state, realmDWFUI);
  state.owned.add("DwfUtil"); state.owned.add("DwfErr"); state.owned.add("DWFUI");
  state.modules.set(uiFile, DWFUI);
  state.facade.DWFUI = DWFUI;
  state.mirrors.set("DWFUI", DWFUI);
  const beforeDefaults = new Map(Object.keys(state.raw).map((key) => [key, state.raw[key]]));
  const defaults = { addEventListener() {}, document: documentStub,
    dfTokenMatch: (name, query) => String(name || "").toLowerCase().includes(String(query || "").toLowerCase()) };
  if (storyMode) defaults.__DWF_STORY_MODE = true;
  for (const [key, value] of Object.entries(defaults))
    if (!(key in state.raw)) state.raw[key] = safeHost(value, state.safe);
  if (!("escapeHtml" in state.raw)) state.raw.escapeHtml = toRealm(state, DWFUI.esc);
  mirrorWrites(state, beforeDefaults);
  state.modules.set(uiFile, DWFUI);
  state.facade.DWFUI = DWFUI;
  state.mirrors.set("DWFUI", DWFUI);

  const utilSource = readFileSync(path.resolve(root, "web/js/dwf-util.js"), "utf8");
  const uiSource = readFileSync(path.resolve(root, "web/js/dwf-ui-components.js"), "utf8");
  function realmContext(seed) {
    const target = {};
    const context = vm.createContext(target, { codeGeneration: { strings: true, wasm: false } });
    const safe = vm.runInContext("({Object,Function,Array})", context);
    for (const [key, value] of Object.entries({ ...defaults, ...seed }))
      if (!BLOCKED.has(key) && key !== "window" && key !== "self" && key !== "globalThis")
        target[key] = safeHost(value, safe);
    for (const key of ["innerWidth", "innerHeight"]) {
      if (Object.hasOwn(seed, key) && seed[key] === globalThis[key])
        Object.defineProperty(target, key, { enumerable: true, configurable: true,
          get: () => globalThis[key], set: value => { seed[key] = value; } });
    }
    target.window = target; target.self = target; target.globalThis = target;
    const suppliedDwfErr = target.DwfErr;
    if (target.DwfUtil == null) vm.runInContext(utilSource, context, { filename: "web/js/dwf-util.js" });
    if (suppliedDwfErr != null) {
      target.DwfErr = suppliedDwfErr;
      target.DwfUtil = Object.freeze({ ...target.DwfUtil, DwfErr: suppliedDwfErr });
    }
    if (target.DwfErr == null && target.DwfUtil?.DwfErr) target.DwfErr = target.DwfUtil.DwfErr;
    if (target.DWFUI == null) vm.runInContext(uiSource, context, { filename: "web/js/dwf-ui-components.js" });
    if (target.escapeHtml == null) target.escapeHtml = target.DWFUI.esc;
    return context;
  }

  return Object.freeze({
    context(contextGlobals = {}) { return realmContext(contextGlobals); },
    load(file) {
      const filename = path.resolve(root, file);
      if (!filename.startsWith(browserRoot) || path.extname(filename) !== ".js") return nodeRequire(filename);
      if (path.basename(filename) === "dwf-panelframe.js") {
        if (state.directModules.has(filename)) return state.directModules.get(filename);
        execute(filename);
        const resolved = nodeRequire.resolve(filename);
        delete nodeRequire.cache[resolved];
        const exported = protectHost(nodeRequire(resolved), state.safe);
        if (state.facade.DFPanelFrame)
          state.facade.DFPanelFrame = protectHost(state.facade.DFPanelFrame, state.safe);
        state.directModules.set(filename, exported);
        return exported;
      }
      return execute(filename);
    },
    run(file, { context = state.view } = {}) {
      const filename = path.resolve(root, file), source = readFileSync(filename, "utf8");
      if (context === state.view || context === state.raw) {
        syncFacade(state);
        const before = new Map(Object.keys(state.raw).map((key) => [key, state.raw[key]]));
        const wrapper = vm.runInContext(`(function(window,self,globalThis){\n${source}\n})`, state.context, { filename });
        const result = bridgeResult(state, () => wrapper.call(state.raw, state.raw, state.raw, state.raw));
        mirrorWrites(state, before);
        return bridge(state, result);
      }
      if (vm.isContext(context)) return vm.runInContext(source, context, { filename });
      for (const key of BLOCKED) delete context[key];
      for (const key of ["innerWidth", "innerHeight"]) {
        if (Object.hasOwn(context, key) && context[key] === globalThis[key])
          Object.defineProperty(context, key, { enumerable: true, configurable: true,
            get: () => globalThis[key], set: value => { Object.defineProperty(context, key,
              { value, enumerable: true, configurable: true, writable: true }); } });
      }
      if (!Object.hasOwn(context, "window") && context.self === context) context.window = context;
      if (!Object.hasOwn(context, "self")) context.self = context;
      vm.createContext(context, { codeGeneration: { strings: true, wasm: false } });
      return vm.runInContext(source, context, { filename });
    },
    browserGlobal: state.view,
    root,
  });
}
