// Adapter conformance probe: hooks.server.js should intercept every
// request before SvelteKit routes it. If our entry breaks the
// event.fetch / event.locals plumbing, the x-creek-hook header
// disappears from responses.
export async function handle({ event, resolve }) {
  event.locals.via_hook = true;
  const response = await resolve(event);
  response.headers.set("x-creek-hook", "ok");
  return response;
}
