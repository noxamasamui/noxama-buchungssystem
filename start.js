// start.js
// Robust launcher: versucht mehrere mögliche build-Entrypoints
const fs = require('fs');
const path = require('path');

const candidates = [
  path.join(__dirname, 'dist', 'server.js'),
  path.join(__dirname, 'dist', 'src', 'server.js'),
  path.join(__dirname, 'dist', 'index.js'),
  path.join(__dirname, 'dist', 'src', 'index.js'),
  path.join(__dirname, 'dist', 'app.js'),
];

for (const c of candidates) {
  if (fs.existsSync(c)) {
    console.log('Starting server from', c);
    require(c);
    return;
  }
}

console.error('No compiled server entry found. Tried:\n' + candidates.join('\n'));
console.error('Please run `npm run build` locally and check the dist/ output.');
process.exit(1);
