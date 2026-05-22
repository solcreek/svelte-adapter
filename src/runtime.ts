// Public runtime entrypoint, consumed via `@solcreek/svelte-adapter/runtime`.
//
// The build-time `default` export of the package is the SvelteKit
// adapter (used in svelte.config.js). At runtime, the generated entry
// (build/index.js) imports from here to instantiate the persistent
// cache and expose it on event.platform.
//
// Keep this surface deliberately small — anything exported here ships
// in the entry's import graph on every cold start.

export { createCache } from "./cache-handler.js";
export type {
  CreekdSvelteCache,
  CreekdSvelteCacheOptions,
  CacheEntry,
  SetOptions,
} from "./cache-handler.js";
