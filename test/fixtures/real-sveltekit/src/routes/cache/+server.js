// Exercises platform.cache through a real SvelteKit Server.respond.
// The adapter's e2e suite checks that user code receives a working
// cache on event.platform and that L2 persistence survives restart.

export async function GET({ platform, url }) {
  const op = url.searchParams.get("op") ?? "has";
  const key = url.searchParams.get("key") ?? "k";

  if (op === "has") {
    const has = !!platform?.cache && typeof platform.cache.set === "function";
    return new Response(has ? "yes" : "no");
  }
  if (op === "set") {
    const value = url.searchParams.get("value") ?? "v";
    await platform.cache.set(key, value);
    return new Response("set");
  }
  if (op === "get") {
    const hit = await platform.cache.get(key);
    return new Response(hit ? String(hit.value) : "MISS");
  }
  if (op === "cached") {
    const v = await platform.cache.cached(key, { revalidate: 30 }, async () => {
      return "loaded-" + Date.now();
    });
    return new Response(v);
  }
  return new Response("unknown op", { status: 400 });
}
