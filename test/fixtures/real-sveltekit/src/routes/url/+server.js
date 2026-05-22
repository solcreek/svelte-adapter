// Exposes event.url.origin / event.url.pathname so the e2e suite can
// verify X-Forwarded-* rewriting feeds the right URL through to user code.
export async function GET({ url }) {
  return new Response(`${url.protocol}//${url.host}${url.pathname}`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
