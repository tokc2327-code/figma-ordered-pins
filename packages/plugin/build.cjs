const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (path) => readFileSync(join(__dirname, path), 'utf8');
const protocol = read('../protocol/index.cjs');
const sandbox = [
  'const pinProtocol = (() => { const module = { exports: {} };',
  protocol,
  'return module.exports; })();',
  read('ordered-pins.js'),
  read('code.js'),
].join('\n');

mkdirSync(join(__dirname, 'dist'), { recursive: true });
writeFileSync(join(__dirname, 'dist/code.js'), sandbox);
