import { json } from "@sveltejs/kit";

export async function GET() {
  return json({ ok: true, at: Date.now() });
}

export async function POST({ request }) {
  const body = await request.text();
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
