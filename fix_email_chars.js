const fs = require('fs');

let text = fs.readFileSync('utils/emailService.js', 'utf8');

text = text.replace('??? <strong>Print Tip:</strong>', '<strong>Print Tip:</strong>');
text = text.replace('Your order has been shipped! ??";', 'Your order has been shipped!";');
text = text.replace('Your order has been delivered! ??";', 'Your order has been delivered!";');
text = text.replace('seller! ??</p>', 'seller!</p>');

// Replacing the corrupted 3-5 days
text = text.replace(/within 3\ufffd5/g, 'within 3-5');

// Fixing anything that looks like "??? " generally
text = text.replace(/\?\?\? /g, '');

fs.writeFileSync('utils/emailService.js', text);
console.log('Fixed email chars');
