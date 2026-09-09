const fs = require('fs');
let c = fs.readFileSync('public/dashboard.js', 'utf8');
c = c.replace(
  `list.innerHTML = "<p style="color:#888;text-align:center;">No files yet</p>";`,
  `list.innerHTML = \"<p style=\\"color:#888;text-align:center;\\">No files yet</p>\";`
);
fs.writeFileSync('public/dashboard.js', c);
console.log('Fixed quotes');