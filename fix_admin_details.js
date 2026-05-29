const fs = require('fs');

let text = fs.readFileSync('utils/emailService.js', 'utf8');

const regex = /<p style="margin:0 0 10px;color:#5A1E12;font-size:12px;font-weight:700;letter-spacing:1\.5px;text-transform:uppercase;" class="dark-text">Your Details<\/p>\s*<p style="margin:4px 0;color:#333;font-size:14px;" class="dark-text"><strong>\$\{customerName\}<\/strong><\/p>\s*<p style="margin:4px 0;color:#555;font-size:13px;" class="dark-text-secondary">\$\{email\}<\/p>/m;

const newDetailsBlock = `<p style="margin:0 0 10px;color:#5A1E12;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;" class="dark-text">\${orderDetails.isSuperAdminCopy || orderDetails.isSellerCopy ? 'Customer Details' : 'Your Details'}</p>
                <p style="margin:4px 0;color:#333;font-size:14px;" class="dark-text"><strong>\${orderDetails.customerName || customerName}</strong></p>
                <p style="margin:4px 0;color:#555;font-size:13px;" class="dark-text-secondary">\${orderDetails.customerEmail || email}</p>`;

if (regex.test(text)) {
  text = text.replace(regex, newDetailsBlock);
  fs.writeFileSync('utils/emailService.js', text);
  console.log('Fixed Your Details block');
} else {
  console.log('Could not find oldDetailsBlock in emailService.js');
}
