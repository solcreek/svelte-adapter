// Same 50ms work as /bench/slow, but wrapped in platform.cache.cached.
// Only available with @solcreek/svelte-adapter — @sveltejs/adapter-node
// returns 500 here because event.platform is undefined.

const WORK_MS = 50;

export async function GET({ platform }) {
  if (!platform?.cache) {
    return new Response("no platform.cache (adapter-node has no equivalent)", {
      status: 500,
    });
  }
  const v = await platform.cache.cached("bench:cached:v1", { revalidate: 60 }, async () => {
    await new Promise((r) => setTimeout(r, WORK_MS));
    return `cached:${Date.now()}`;
  });
  return new Response(v, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
