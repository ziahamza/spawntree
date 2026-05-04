/**
 * File System Access API capability detection.
 *
 * spawntree-browser relies on `showDirectoryPicker` and the
 * `FileSystemDirectoryHandle` family for everything filesystem-side.
 * Those APIs are only available in Chromium-family browsers (Chrome,
 * Edge, Opera, Brave, Arc) over a secure context. Firefox and Safari
 * don't ship them as of writing.
 *
 * Consumers should call `isFsaSupported()` (or read `fsaSupported`) at
 * boot and degrade gracefully when it returns `false` — typically by
 * hiding the picker UI and falling back to spawntree-daemon over HTTP.
 *
 * Both forms are equivalent. `fsaSupported` is computed once at module
 * load for callers who want a stable reference; `isFsaSupported()` is
 * the function form for callers who prefer not to import a constant.
 */

/**
 * `true` if the current global has File System Access APIs available.
 *
 * Computed once at module load. In SSR contexts (no `globalThis.window`)
 * this is `false` — that's correct for any non-browser environment.
 */
export const fsaSupported: boolean = (() => {
  if (typeof globalThis === "undefined") return false;
  // Browser-only check: `showDirectoryPicker` lives on `window` in
  // supported browsers. Treat absence as "not supported" rather than
  // throwing, so server-side bundles that import the package incidentally
  // (e.g. for type-only imports) don't crash at module load.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = (globalThis as any).window;
  if (!w) return false;
  return (
    typeof w.showDirectoryPicker === "function" && typeof w.FileSystemDirectoryHandle === "function"
  );
})();

/**
 * Function form of `fsaSupported`. Returns the same value the constant
 * holds. Provided for callers who prefer a callable check.
 */
export function isFsaSupported(): boolean {
  return fsaSupported;
}
