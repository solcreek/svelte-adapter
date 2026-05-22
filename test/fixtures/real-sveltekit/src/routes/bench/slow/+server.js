// Simulates an expensive backend dependency (DB query, third-party API).
// 50ms ≈ realistic p50 for a Postgres SELECT over a small JOIN, or a
// cross-region cache miss to an internal service.
//
// Available with both @solcreek/svelte-adapter and @sveltejs/adapter-node,
// so /bench/slow is the apples-to-apples baseline.

const WORK_MS = 50;

export async function GET() {
  await new Promise((r) => setTimeout(r, WORK_MS));
  return new Response(`slow:${Date.now()}`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
