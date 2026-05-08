/**
 * Side-effect module that installs `globalThis.Buffer` if it isn't
 * already defined.
 *
 * Why this exists: `isomorphic-git`'s `FileSystem.read()` calls
 * `Buffer.from(buffer)` on every result. In Node and SSR contexts that
 * works fine because Node provides Buffer globally. In a browser bundle
 * where the `buffer` polyfill hasn't been wired up, the call throws
 * `ReferenceError: Buffer is not defined` — and isomorphic-git silently
 * swallows the error inside its `_readObject` path, surfacing only as
 * a confusing "Could not find OID" further up the stack.
 *
 * We MUST install the polyfill before any isomorphic-git read runs.
 * Importing this module for side effects (or transitively, by importing
 * any other module in spawntree-browser that touches iso-git) is enough
 * to guarantee that.
 *
 * If the consumer's bundler already provides Buffer globally (Vite with
 * `optimizeDeps.exclude: ["buffer"]` + `define`, or webpack with
 * `node-polyfills`) we don't overwrite it.
 */
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (typeof g.Buffer === "undefined") {
  g.Buffer = Buffer;
}
