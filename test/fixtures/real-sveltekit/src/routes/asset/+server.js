import { read } from "$app/server";
import asset from "./asset.txt";

// Exercises $app/server's read() — the entry's `supports.read=true`
// claim only stands if this returns 200 with the asset contents.
export async function GET() {
  const file = read(asset);
  const text = await file.text();
  return new Response(text.trim(), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
