import { error } from "@sveltejs/kit";

// `throw error(...)` should produce a SvelteKit-shaped error response,
// not a generic 500. Status code propagation tested here; the rendered
// +error.svelte body is exercised separately for page routes.
export async function GET({ url }) {
  const status = Number(url.searchParams.get("status")) || 418;
  throw error(status, `intentional ${status}`);
}
