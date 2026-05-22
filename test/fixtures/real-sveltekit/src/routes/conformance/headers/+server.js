// event.setHeaders is the SvelteKit-idiomatic way to add response
// headers from load() and +server.js. Verifying it round-trips
// through the entry's Response → ServerResponse bridge.
export async function GET({ setHeaders }) {
  setHeaders({
    "cache-control": "public, max-age=3600",
    "x-custom-via-setheaders": "yes",
  });
  return new Response("with-headers");
}
