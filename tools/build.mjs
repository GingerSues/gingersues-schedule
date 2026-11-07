// Bundles src/ into public/. With --fake, swaps the Firebase SDK for the in-memory test double.
import { build } from "esbuild";
const fake = process.argv.includes("--fake");
const alias = { name: "fake-fbapi", setup(b) {
  if (fake) b.onResolve({ filter: /\/fbapi\.js$/ }, () => ({ path: new URL("../test/fake-fbapi.js", import.meta.url).pathname }));
} };
for (const entry of ["fb", "admin"]) {
  await build({ entryPoints: [`src/${entry}.js`], bundle: true, format: "esm", target: "es2020", minify: !fake,
    outfile: fake ? `test/site/${entry}.js` : `public/${entry}.js`, plugins: [alias], logLevel: "warning" });
}
console.log(fake ? "built test bundle into test/site/" : "built public/fb.js and public/admin.js");
