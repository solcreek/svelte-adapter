// The fixture builds with our adapter by default. The bench script
// (scripts/bench.mjs) sets BENCH_ADAPTER=node to rebuild against
// @sveltejs/adapter-node on the same routes for a head-to-head.

const useNodeAdapter = process.env.BENCH_ADAPTER === "node";

const { default: adapter } = useNodeAdapter
  ? await import("@sveltejs/adapter-node")
  : await import("../../../dist/index.js");

export default {
  kit: {
    adapter: useNodeAdapter
      ? adapter({ out: "build" })
      : adapter({
          runtime: "node",
          port: 3000,
          precompress: false,
        }),
  },
};
