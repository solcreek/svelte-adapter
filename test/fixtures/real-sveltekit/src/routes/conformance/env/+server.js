// $env/dynamic/private reads runtime env vars (the manifest's `env`
// array + whatever the process inherited). Verifying that env reaches
// server code through the adapter's env wiring.
import { env } from "$env/dynamic/private";

export async function GET() {
  return new Response(env.CONFORMANCE_SECRET ?? "MISS", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
