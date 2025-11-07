// start.js
// Robust launcher: versucht mehrere mögliche build-Entrypoints
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const candidates = [
  path.join(__dirname, "dist", "server.js"),
  path.join(__dirname, "dist", "src", "server.js"),
  path.join(__dirname, "dist", "Index.js"),
  path.join(__dirname, "dist", "index.js"),
  path.join(__dirname, "dist", "src", "index.js"),
  path.join(__dirname, "dist", "app.js"),
];

async function attemptStart(filePath) {
  if (!fs.existsSync(filePath)) return false;

  console.log("Starting server from", filePath);

  try {
    // Try CommonJS require first
    require(filePath);
    return true;
  } catch (err) {
    // If it's an ESM module error, fall back to dynamic import
    const isESMError = err && err.code === "ERR_REQUIRE_ESM";
    if (!isESMError) {
      console.error("Error while requiring", filePath);
      console.error(err && (err.stack || err.message || err));
      throw err;
    }

    try {
      // dynamic import expects file:// URL for local files
      const url = pathToFileURL(filePath).href;
      import(url).then(mod => {
        // if module exports a start function, call it (optional)
        if (mod && typeof mod.default === "function") {
          try { mod.default(); } catch(e){ /* ignore */ }
        }
      }).catch(imErr => {
        console.error("Dynamic import failed for", filePath, imErr && (imErr.stack || imErr.message || imErr));
        process.exit(1);
      });
      return true;
    } catch (imerr) {
      console.error("Failed to dynamic import", filePath, imerr && (imerr.stack || imerr.message || imerr));
      throw imerr;
    }
  }
}

(async () => {
  for (const c of candidates) {
    try {
      const ok = await attemptStart(c);
      if (ok) return;
    } catch (e) {
      // If attemptStart throws unexpected error, log and continue to try other candidates
      console.error("Start attempt error for", c, e && (e.stack || e.message || e));
    }
  }

  console.error("No compiled server entry found. Tried:\n" + candidates.join("\n"));
  console.error("Please run `npm run build` locally and check the dist/ output.");
  process.exit(1);
})();
