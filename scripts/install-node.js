const fs = require('fs');
const path = process.argv[2];
const pkg = process.argv[3];
let content = fs.readFileSync(path, 'utf8');

if (content.includes(pkg)) {
  console.log('OK  Plugin already registered');
} else if (/"plugin"\s*:\s*\[/.test(content)) {
  // Find the closing bracket of the plugin array
  const match = content.match(/"plugin"\s*:\s*\[/);
  if (!match) { console.error('ERR Cannot parse plugin array'); process.exit(1); }
  
  let idx = match.index + match[0].length;
  let depth = 1;
  while (depth > 0 && idx < content.length) {
    if (content[idx] === '[') depth++;
    if (content[idx] === ']') depth--;
    idx++;
  }
  idx--; // Position of closing bracket
  
  const before = content.slice(0, idx).trimEnd();
  const after = content.slice(idx);
  
  // Add comma to last entry if needed
  const needsComma = before.endsWith(',') ? '' : ',';
  content = before + needsComma + '\n    "' + pkg + '"\n  ' + after;
  
  fs.writeFileSync(path, content);
  console.log('OK  Plugin added');
} else {
  console.error('ERR No plugin array found. Please add manually:');
  console.error('  "plugin": ["' + pkg + '"]');
  process.exit(1);
}
