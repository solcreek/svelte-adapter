import { fail } from "@sveltejs/kit";

// Form action — the entry must forward POSTed form data through
// SvelteKit's request body parsing (multipart/url-encoded).
export const actions = {
  default: async ({ request }) => {
    const data = await request.formData();
    const who = data.get("who");
    if (!who) return fail(400, { message: "missing who" });
    return { message: `hello ${String(who)}` };
  },
};

export async function load() {
  return {};
}
