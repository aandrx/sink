import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

// "events" is used by PouchDB internals. We bundle the browser-compatible
// polyfill instead of leaving it as a bare require() that breaks on mobile.
const externals = builtins.filter((m) => m !== "events");

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...externals,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
  define: {
    "process.env.NODE_ENV": production ? '"production"' : '"development"',
  },
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
