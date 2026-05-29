const fs = require('fs');

const fileStr = fs.readFileSync('utils/emailService.js', 'utf8');

const newFn = `// Send Finance Order Invoice Email
const sendFinanceOrderInvoiceEmail = async (orderDetails, pdfBuffer) => {
  if (isDevelopmentMode) {
    console.log('\\n' + '='.repeat(50));
    console.log('📧 DEVELOPMENT MODE - Finance Order Invoice Email');
    console.log('To: ritikkashyap013@gmail.com');
    console.log('=' .repeat(50) + '\\n');
    return { success: true };
  }

  const content = \\\`
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h2 style="color: #5A1E12; font-size: 24px; margin-bottom: 5px;">New Order Finance Copy</h2>
        <p style="color: #666; font-size: 14px; margin-top: 0;">Invoice generated for Order #\${orderDetails.displayId}</p>
      </div>

      <div style="background: #fdf5f3; padding: 20px; border-radius: 8px; border-left: 4px solid #5A1E12; margin-bottom: 25px;">
        <p style="margin: 0 0 10px 0;">Hello <strong>Finance Team</strong>,</p>
        <p style="margin: 0; line-height: 1.5;">
          A new order has been successfully placed by <strong>\${orderDetails.customerName || 'a Customer'}</strong>. 
          Please find the attached PDF invoice for your financial records and reconciliation.
        </p>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <thead>
          <tr>
            <th style="background: #5A1E12; color: #fff; text-align: left; padding: 12px 15px; border-radius: 6px 0 0 0;">Field</th>
            <th style="background: #5A1E12; color: #fff; text-align: left; padding: 12px 15px; border-radius: 0 6px 0 0;">Details</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; border-left: 1px solid #eee;"><strong>Order Number</strong></td>
            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; border-right: 1px solid #eee;">#\${orderDetails.displayId}</td>
          </tr>
          <tr>
            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; border-left: 1px solid #eee;"><strong>Total Amount</strong></td>
            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; border-right: 1px solid #eee;">$\${(orderDetails.totalAmount || 0).toFixed(2)}</td>
          </tr>
          <tr>
            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; border-left: 1px solid #eee;"><strong>Payment Method</strong></td>
            <td style="padding: 12px 15px; border-bottom: 1px solid #eee; border-right: 1px solid #eee;">\${orderDetails.paymentMethod || 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 12px 15px; border-left: 1px solid #eee; border-bottom: 1px solid #eee;"><strong>Customer Email</strong></td>
            <td style="padding: 12px 15px; border-right: 1px solid #eee; border-bottom: 1px solid #eee;">\${orderDetails.customerEmail || 'No Email'}</td>
          </tr>
        </tbody>
      </table>

      <p style="font-size: 13px; color: #777; text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
        This is an automated system email for the Made in Arnhem Land finance team.
      </p>
    </div>
  \\\`;

  const msg = {
    to: 'ritikkashyap013@gmail.com',
    from: { email: senderEmail, name: senderName },
    subject: \`[Finance Copy] Invoice for Order #\${orderDetails.displayId}\`,
    html: generateResponsiveEmailTemplate({
      title: 'Finance Copy - New Order Invoice',
      content: content,
      maxWidth: 650
    }),
    attachments: [{
      content: pdfBuffer.toString('base64'),
      filename: \`invoice-\${orderDetails.displayId}.pdf\`,
      type: 'application/pdf',
      disposition: 'attachment'
    }]
  };

  try {
    await sgMail.send(msg);
    console.log(\`✅ Finance invoice email sent to ritikkashyap013@gmail.com for order \${orderDetails.displayId}\`);
    return { success: true };
  } catch (error) {
    console.error('❌ Finance invoice email sending error:', error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Send Order Confirmation Email`;

const newFileStr = fileStr.replace('// Send Order Confirmation Email', newFn);
fs.writeFileSync('utils/emailService.js', newFileStr);
console.log('Done replacement!');
