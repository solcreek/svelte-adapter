// Use our adapter via a direct relative path. The dist build runs as
// part of the fixture's build step (see vitest setup) so this resolves.
import adapter from "../../../dist/index.js";

export default {
  kit: {
    adapter: adapter({
      runtime: "node",
      port: 3000,
      precompress: false,
    }),
  },
};
