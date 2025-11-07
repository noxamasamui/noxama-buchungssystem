// start.js
// Robuster Launcher: sucht rekursiv unter dist nach einem server entry und startet es

const fs = require('fs');
const path = require('path');

function findEntry(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  // Prioritaet: server.js, index.js, app.js
  for (const e of entries) {
    if (e.isFile()) {
      const name = e.name.toLowerCase();
      if (name === 'server.js' || name === 'index.js' || name === 'app.js') {
        return path.join(dir, e.name);
      }
    }
  }
  // rekursiv suchen in Unterverzeichnissen
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findEntry(path.join(dir, e.name));
      if (found) return found;
    }
  }
  return null;
}

const distDir = path.join(__dirname, 'dist');
const entry = findEntry(distDir);

if (entry) {
  console.log('Starting server from', entry);
  require(entry);
} else {
  console.error('No compiled server entry found under dist');
  if (fs.existsSync(distDir)) {
    console.error('Contents of dist (recursive):');
    function listRec(dir, prefix = '') {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const it of items) {
        if (it.isDirectory()) {
          console.error(prefix + it.name + '/');
          listRec(path.join(dir, it.name), prefix + '  ');
        } else {
          console.error(prefix + it.name);
        }
      }
    }
    try { listRec(distDir); } catch (e) { console.error('Failed to list dist:', e && e.message); }
  } else {
    console.error('dist directory does not exist at all');
  }
  console.error('Please run npm run build locally and check the dist/ output.');
  process.exit(1);
}
