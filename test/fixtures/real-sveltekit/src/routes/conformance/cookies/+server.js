// SvelteKit's cookies.set() writes Set-Cookie headers via the
// Response — exercising the entry's header-passthrough plumbing.
export async function GET({ cookies, url }) {
  const op = url.searchParams.get("op") ?? "set";
  if (op === "set") {
    cookies.set("creek-test", "from-sveltekit", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    return new Response("cookie-set");
  }
  if (op === "read") {
    return new Response(cookies.get("creek-test") ?? "MISS");
  }
  if (op === "delete") {
    cookies.delete("creek-test", { path: "/" });
    return new Response("cookie-deleted");
  }
  return new Response("bad op", { status: 400 });
}
