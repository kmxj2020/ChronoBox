const fs = require('fs');
const path = require('path');

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

const root = path.resolve(__dirname, '..');
const rendererSrc = path.join(root, 'src', 'renderer');
const rendererDist = path.join(root, 'dist', 'renderer');

fs.mkdirSync(rendererDist, { recursive: true });
for (const file of ['index.html', 'mini.html']) {
  const srcFile = path.join(rendererSrc, file);
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, path.join(rendererDist, file));
  }
}
copyRecursive(path.join(rendererSrc, 'styles'), path.join(rendererDist, 'styles'));
console.log('[copy-assets] Renderer HTML & CSS assets copied to dist/renderer');
