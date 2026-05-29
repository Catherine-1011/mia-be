const fs = require('fs');
let txt = fs.readFileSync('utils/emailService.js', 'utf8');

// The issue was I wrote `const content = \\\`` and `\\\`;` 
// Let's replace the EXACT occurrences of those malformed string openings
txt = txt.replace('const content = \\`', 'const content = `');
txt = txt.replace('    </div>\r\n  \\`;', '    </div>\r\n  `;');
txt = txt.replace('    </div>\n  \\`;', '    </div>\n  `;');

fs.writeFileSync('utils/emailService.js', txt, 'utf8');
console.log('Fixed backticks!');
