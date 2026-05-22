import { redirect } from "@sveltejs/kit";

// `throw redirect(302, ...)` is the SvelteKit idiom for a 30x with
// Location. The entry must propagate both the status code AND the
// Location header.
export async function GET() {
  throw redirect(302, "/about");
}
