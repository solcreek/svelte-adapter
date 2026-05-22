// SSR page: returns a per-request timestamp so the e2e test can prove
// that two separate requests get different bodies (no caching, real SSR).
export async function load() {
  return { now: Date.now() };
}
