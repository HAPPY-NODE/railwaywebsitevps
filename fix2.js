const fs = require('fs');
let c = fs.readFileSync('public/dashboard.js', 'utf8');
// Fix all unescaped quotes in innerHTML
c = c.replace(
  `innerHTML = "<p style="color:#f55;">Error loading files</p>";`,
  `innerHTML = \"<p style=\\"color:#f55;\\">Error loading files</p>\";`
);
fs.writeFileSync('public/dashboard.js', c);
console.log('Fixed error quotes');