const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');

/**
 * SENDGRID EMAIL SERVICE (Works on Render.com!)
 * 
 * Setup Instructions:
 * 1. Sign up at https://sendgrid.com (FREE tier: 100 emails/day)
 * 2. Go to Settings > API Keys > Create API Key
 * 3. Add to your .env file:
 *    SENDGRID_API_KEY=your_api_key_here
 *    SENDER_EMAIL=verified@yourdomain.com
 * 5. Install: npm install @sendgrid/mail
 */

// Initialize Duo Circle Nodemailer
let duoCircleConfigured = false;
const duoCircleTransporter = nodemailer.createTransport({
  host: process.env.DUO_CIRCLE_HOST || 'outbound.mailhop.org',
  port: parseInt(process.env.DUO_CIRCLE_PORT) === 587 ? 2525 : (process.env.DUO_CIRCLE_PORT || 2525), // Forcibly circumvent port 587 blocks to prevent hanging
  secure: false, // true for 465, false for other ports
  connectionTimeout: 20000, // 20-second timeout � Render.com SMTP connections can be slow
  greetingTimeout: 20000,
  socketTimeout: 20000,
  auth: {
    user: process.env.DUO_CIRCLE_USER,
    pass: process.env.DUO_CIRCLE_PASS,
  },
  pool: true,
  maxConnections: 5,
  maxMessages: 100,
});

// Separate transporter for bulk/campaign sends � longer timeouts so a slow
// SMTP handshake doesn't kill individual newsletter emails.
const duoCircleCampaignTransporter = nodemailer.createTransport({
  host: process.env.DUO_CIRCLE_HOST || 'outbound.mailhop.org',
  port: parseInt(process.env.DUO_CIRCLE_PORT) === 587 ? 2525 : (process.env.DUO_CIRCLE_PORT || 2525),
  secure: false,
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
  auth: {
    user: process.env.DUO_CIRCLE_USER,
    pass: process.env.DUO_CIRCLE_PASS,
  },
  pool: true,
  maxConnections: 2,  // conservative � 1 connection at a time for bulk
  maxMessages: 500,
});

if (process.env.DUO_CIRCLE_USER && process.env.DUO_CIRCLE_PASS) {
  duoCircleConfigured = true;
  console.log("Duo Circle email service initialized");
}

// Initialize SendGrid
let emailConfigured = false;

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  emailConfigured = true;
  console.log("SendGrid email service initialized");
  console.log("SendGrid senderEmail:", process.env.SENDER_EMAIL);
  console.log("SendGrid API Key present:", !!process.env.SENDGRID_API_KEY);
} else {
  console.log("SendGrid API key not configured. Emails will be logged to console.");
}

const isDevelopmentMode = (!emailConfigured && !duoCircleConfigured);
const senderEmail = process.env.SENDER_EMAIL || process.env.EMAIL_USER || 'noreply@yourapp.com';
const senderName = process.env.SENDER_NAME || 'Made in Arnhem Land';

/**
 * Helper function to handle sending with quota error fallback
 */
const sendWithFallback = async (msg, context = 'Email', extraInfo = {}) => {
  try {
    // If Duo Circle is configured, prioritize it over SendGrid
    if (duoCircleConfigured) {
      const mailOptions = {
        from: `"${msg.from.name || senderName}" <${msg.from.email || msg.from}>`,
        to: msg.to.email || msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      };
      
      if (msg.replyTo) {
        mailOptions.replyTo = msg.replyTo.email || msg.replyTo;
      }
      
      try {
        await duoCircleTransporter.sendMail(mailOptions);
        console.log(`[Duo Circle] ${context} sent successfully to:`, msg.to);
        return { success: true };
      } catch (duoErr) {
        console.error(`[Duo Circle] ${context} failed:`, duoErr.message);
        // Fall through to SendGrid if available
        if (emailConfigured) {
          console.log(`?? Falling back to SendGrid for ${context}...`);
          await sgMail.send(msg);
          console.log(`? [SendGrid fallback] ${context} sent successfully to:`, msg.to);
          return { success: true };
        }
        throw duoErr;
      }
    } 
    
    // Otherwise use SendGrid if configured
    if (emailConfigured) {
      await sgMail.send(msg);
      console.log(`? [SendGrid] ${context} sent successfully to:`, msg.to);
      return { success: true };
    }

    throw new Error('No email service configured');
  } catch (error) {
    console.error(`? SendGrid error for ${context}:`, error.response?.body || error.message);
    
    // Check if it's a quota/credits exceeded error
    const isQuotaExceeded = error.response?.body?.errors?.some(err => 
      err.message?.toLowerCase().includes('maximum credits exceeded') ||
      err.message?.toLowerCase().includes('quota exceeded') ||
      err.message?.toLowerCase().includes('daily limit')
    );
    
    // Fallback for development or quota exceeded
    if (process.env.NODE_ENV === 'development' || isQuotaExceeded) {
      console.log(`? Fallback mode: ${context} sending failed but returning success for development`);
      if (isQuotaExceeded) {
        console.log("? Reason: SendGrid quota/credits exceeded - please upgrade your SendGrid plan");
      }
      if (extraInfo.otp) {
        console.log(`? OTP for testing: ${extraInfo.otp}`);
        console.log(`? Email would have been sent to: ${msg.to}`);
      }
      return { success: true };
    }
    
    return { success: false, error: error.message || "Email service error" };
  }
};

/**
 * Generate print-safe CSS for all email templates
 * This ensures colors appear when printing emails
 */
const getPrintSafeCSS = () => `
  @media screen and (max-width: 640px) {
    .email-container { width: 100% !important; margin: 0 10px !important; max-width: calc(100% - 20px) !important; }
    .email-header { padding: 24px 20px !important; }
    .email-body { padding: 20px !important; }
    .email-footer { padding: 16px 20px !important; }
    .mobile-center { text-align: center !important; }
  }
  
  @media print {
    /* FORCE PRINT COLORS - Maximum Compatibility */
    *, *:before, *:after, 
    html, body, div, table, tr, td, th, p, h1, h2, h3, h4, h5, h6,
    span, strong, em, a {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
      -webkit-filter: none !important;
      filter: none !important;
    }
    
    /* Force body and page backgrounds to print */
    html *, body * {
      background-attachment: local !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      background: none transparent !important;
    }
    
    body, html {
      background-color: #FDF5F3 !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      background: #FDF5F3 !important;
    }
    
    /* === BRAND HEADERS - Multiple selectors for maximum compatibility === */
    .email-header, 
    [style*="background:linear-gradient(135deg,#5A1E12"], 
    [style*="background:linear-gradient(135deg, #5A1E12"],
    [style*="background-color:#5A1E12"],
    
    td[style*="background:linear-gradient(135deg,#5A1E12"] {
      background: #5A1E12 !important; /* Fallback solid color */
      background-color: #5A1E12 !important;
      background-image: linear-gradient(135deg, #5A1E12 0%, #7D2E1E 100%) !important;
      color: #ffffff !important;
      border: 3px solid #5A1E12 !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      box-shadow: inset 0 0 0 1000px #5A1E12 !important; /* Force background fill */
    }
    
    /* === BRAND FOOTERS === */
    .email-footer, 
    [style*="background-color:#3D1009"],
    td[style*="background-color:#3D1009"] {
      background-color: #3D1009 !important;
      background: #3D1009 !important;
      color: #F0D0C8 !important;
      border: 3px solid #3D1009 !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      box-shadow: inset 0 0 0 1000px #3D1009 !important;
    }
    
    /* === INVOICE META SECTIONS === */
    [style*="background-color:#F9EDE9"],
    [style*="background:#F9EDE9"],
    td[style*="background-color:#F9EDE9"],
    table[style*="background-color:#F9EDE9"] {
      background-color: #F9EDE9 !important;
      background: #F9EDE9 !important;
      border: 2px solid #C4603A !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      box-shadow: inset 0 0 0 1000px #F9EDE9 !important;
    }
    
    /* === INVOICE TABLE ROWS === */
    [style*="background-color:#fdf5f3"],
    tr[style*="background-color:#fdf5f3"],
    td[style*="background-color:#fdf5f3"] {
      background-color: #fdf5f3 !important;
      background: #fdf5f3 !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      box-shadow: inset 0 0 0 1000px #fdf5f3 !important;
    }
    
    /* === TABLE HEADERS === */
    thead tr, thead tr *, thead th, thead th *,
    [style*="background-color:#5A1E12"],
    tr[style*="background-color:#5A1E12"] {
      background-color: #5A1E12 !important;
      background: #5A1E12 !important;
      color: #ffffff !important;
      border: 2px solid #5A1E12 !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      box-shadow: inset 0 0 0 1000px #5A1E12 !important;
    }
    
    /* === STATUS BANNERS - All Colors === */
    [style*="background-color:#4CAF50"], [style*="background:#4CAF50"], /* confirmed - green */
    [style*="background-color:#B05E2A"], [style*="background:#B05E2A"], /* processing/packed - brown */
    [style*="background-color:#6B4C9A"], [style*="background:#6B4C9A"], /* shipped - purple */
    [style*="background-color:#C4963A"], [style*="background:#C4963A"], /* delivered - amber */
    [style*="background-color:#A03020"], [style*="background:#A03020"], /* cancelled - red */
    [style*="background-color:#2E7D32"], [style*="background:#2E7D32"], /* refund - green */
    [style*="background-color:#C4603A"], [style*="background:#C4603A"] { /* default - terracotta */
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      border: 3px solid currentColor !important;
      box-shadow: inset 0 0 0 1000px currentColor !important;
    }
    
    /* === BUTTONS & CTAs === */
    .btn, 
    a[style*="background-color:#5A1E12"], 
    a[style*="background-color:#C4603A"],
    a[style*="background:#5A1E12"], 
    a[style*="background:#C4603A"] {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      border: 3px solid currentColor !important;
      box-shadow: inset 0 0 0 1000px currentColor !important;
    }
    
    /* === GMAIL COMPATIBILITY - Force all backgrounds === */
    table, tr, td, th, div, span, p, h1, h2, h3, h4, h5, h6 {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    
    /* === INLINE BACKGROUND OVERRIDES === */
    [style*="background"], 
    [style*="background-color"], 
    [style*="background:"] {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      background-attachment: local !important;
    }
    
    /* === PAGE LAYOUT === */
    .email-container {
      page-break-inside: avoid !important;
    }
    
    /* === GMAIL SPECIFIC HACKS === */
    .ii a[href] { color: inherit !important; }
    .adM { display: none !important; }
    
    /* === FORCE WHITE TEXT ON DARK BACKGROUNDS === */
    [style*="#5A1E12"] *, [style*="#3D1009"] * {
      color: #ffffff !important;
    }
    [style*="#F9EDE9"] * {
      color: #333333 !important;
    }
  }
`;

/**
 * Helper function to create VML gradient background for better email client support
 * This ensures gradients show on Apple Mail, Outlook, and other email clients
 */
const getVMLGradient = (color1, color2, fallback) => {
  return `<!--[if mso]>
    <v:rect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" fill="true" stroke="false" style="width:100%;height:100%;">
      <v:fill type="gradient" color="${color1}" color2="${color2}" />
    </v:rect>
  <![endif]-->`
};

/**
 * Generate responsive email template with dark mode support
 * @param {Object} options - Template configuration options
 * @param {string} options.title - Email title
 * @param {string} options.content - HTML content for the email body
 * @param {number} options.maxWidth - Maximum width for the email container (default: 650)
 * @returns {string} Complete HTML email template
 */
const generateResponsiveEmailTemplate = (options) => {
  const { title = 'Made in Arnhem Land', content = '', maxWidth = 650 } = options;
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="color-scheme" content="light dark">
      <style>
        @media screen and (max-width: 640px) {
          .email-container { width: 100% !important; margin: 0 10px !important; max-width: calc(100% - 20px) !important; }
          .email-header { padding: 24px 20px !important; }
          .email-body { padding: 20px !important; }
          .email-footer { padding: 16px 20px !important; }
          .responsive-table { width: 100% !important; }
          .two-col { display: block !important; width: 100% !important; padding: 0 !important; margin: 0 0 15px !important; }
          .two-col-spacing { display: none !important; }
          .mobile-center { text-align: center !important; }
          .mobile-padding { padding: 10px !important; }
          .btn-table { width: 100% !important; }
          .btn-cell { display: block !important; width: 100% !important; padding: 8px 0 !important; text-align: center !important; }
          .mobile-btn { margin: 8px !important; }
          .otp-box { padding: 20px !important; margin: 0 0 20px !important; }
          .otp-code { font-size: 32px !important; letter-spacing: 8px !important; }
          .mobile-table-stack td { display: block !important; width: 100% !important; }
        }
        
        @media screen and (max-width: 480px) {
          .email-header { padding: 20px 15px !important; }
          .email-body { padding: 15px !important; }
          .email-footer { padding: 15px !important; }
          .otp-code { font-size: 28px !important; letter-spacing: 6px !important; }
        }
        
        @media (prefers-color-scheme: dark) {
          .dark-bg { background-color: #1a1a1a !important; }
          .dark-card { background-color: #2d2d2d !important; border: 1px solid #404040 !important; }
          .dark-text { color: #e0e0e0 !important; }
          .dark-text-secondary { color: #b0b0b0 !important; }
          .dark-table-bg { background-color: #333333 !important; }
          .dark-table-header { background-color: #404040 !important; }
          .dark-table-row { background-color: #2d2d2d !important; border-color: #404040 !important; }
          .dark-alert-bg { background-color: #3a3a2f !important; border-color: #6B4C29 !important; }
          .dark-otp-bg { background: linear-gradient(135deg, #3a3a2f 0%, #2d2d2d 100%) !important; border-color: #6B4C29 !important; }
          .dark-info-bg { background-color: #2d2d3a !important; border-color: #404055 !important; }
        }
        
        /* Comprehensive print CSS for all email templates */
        ${getPrintSafeCSS().replace(/^@media screen[\s\S]*?}\s*/, '').replace(/^@media print \{/, '@media print {')}
      </style>
    </head>
    <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;" class="dark-bg">
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;" class="dark-bg">
        <tr><td align="center">
          <table width="${maxWidth}" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);max-width:95%;" class="email-container dark-card">
            ${content}
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;
};

/**
 * Enhances every outgoing SendGrid message with:
 *  - A plain-text body (required for spam-filter compliance)
 *  - Reply-To / List-Unsubscribe headers (deliverability signals)
 * Call this instead of sgMail.send(msg) directly.
 */
const buildMsg = (msg) => {
  // Strip HTML to produce a plain-text alternative
  const text = (msg.html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(\s*\n\s*){3,}/g, '\n\n')
    .trim();

  const replyToEmail = process.env.REPLY_TO_EMAIL || senderEmail;
  const unsubscribeEmail = process.env.UNSUBSCRIBE_EMAIL || senderEmail;

  return {
    ...msg,
    text,
    // SendGrid requires replyTo as a dedicated field ? NOT inside headers
    replyTo: { email: replyToEmail, name: senderName },
    headers: {
      // List-Unsubscribe is allowed as a custom header
      'List-Unsubscribe': `<mailto:${unsubscribeEmail}?subject=unsubscribe>`,
      ...(msg.headers || {}),
    },
  };
};

// Wrap sgMail.send so every outgoing message automatically gets
// plain-text body + Reply-To + List-Unsubscribe headers,
// AND seamlessly routes to Duo Circle if configured
const _sgMailSend = sgMail.send.bind(sgMail);
sgMail.send = async (rawMsg, ...args) => {
  const msg = buildMsg(rawMsg);
  
  // Intercept and route to Duo Circle if enabled
  if (duoCircleConfigured) {
    const mailOptions = {
      from: `"${msg.from?.name || senderName}" <${msg.from?.email || msg.from || senderEmail}>`,
      to: msg.to?.email || msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    };
    
    // Convert Array of to emails if needed
    if (Array.isArray(msg.to)) {
      mailOptions.to = msg.to.map(t => t.email || t).join(', ');
    }
    
    // Attachments
    if (msg.attachments && Array.isArray(msg.attachments)) {
      mailOptions.attachments = msg.attachments.map(att => ({
        filename: att.filename,
        content: att.content,
        encoding: 'base64', // SendGrid attachments are usually base64 strings
        contentType: att.type
      }));
    }
    
    if (msg.replyTo) {
      mailOptions.replyTo = msg.replyTo.email || msg.replyTo;
    }
    
    try {
      await duoCircleTransporter.sendMail(mailOptions);
      return [{ statusCode: 202, body: '' }]; // Mock SendGrid success response format
    } catch (err) {
      console.error('? Duo Circle sending error (via sgMail interceptor):', err.message);
      // Fall back to SendGrid rather than silently dropping the email
      if (emailConfigured) {
        console.log('?? Falling back to SendGrid for email delivery...');
        return _sgMailSend(msg, ...args);
      }
      throw err;
    }
  }

  // Fallback back to SendGrid if Duo Circle isn't used
  return _sgMailSend(msg, ...args);
};

// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Send OTP email
const sendOTPEmail = async (email, otp, name) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - OTP Email");
    console.log("=".repeat(50));
    console.log(`To: ${email}`);
    console.log(`Name: ${name}`);
    console.log(`OTP: ${otp}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const msg = {
    to: email,
    from: {
      email: senderEmail,
      name: senderName
    },
    subject: "Email Verification - OTP",
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="color-scheme" content="light dark">
        <style>
          @media screen and (max-width: 640px) {
            .email-container { width: 100% !important; margin: 0 10px !important; max-width: calc(100% - 20px) !important; }
            .email-header { padding: 24px 20px !important; }
            .email-body { padding: 20px !important; }
            .email-footer { padding: 16px 20px !important; }
            .otp-box { padding: 20px !important; margin: 0 0 20px !important; }
            .otp-code { font-size: 32px !important; letter-spacing: 8px !important; }
          }
          @media (prefers-color-scheme: dark) {
            .dark-bg { background-color: #1a1a1a !important; }
            .dark-card { background-color: #2d2d2d !important; border: 1px solid #404040 !important; }
            .dark-text { color: #e0e0e0 !important; }
            .dark-text-secondary { color: #b0b0b0 !important; }
            .dark-otp-bg { background: linear-gradient(135deg, #3a3a2f 0%, #2d2d2d 100%) !important; border-color: #6B4C29 !important; }
            .dark-alert-bg { background-color: #3a3a2f !important; border-color: #6B4C29 !important; }
          }
          
          /* Comprehensive print CSS for all email templates */
          ${getPrintSafeCSS().replace(/^@media screen[\s\S]*?}\s*/, '').replace(/^@media print \{/, '@media print {')}
          
          /* Apple Mail specific color fixes */
          .header-gradient { background-color: #5A1E12; }
          .footer-dark { background-color: #3D1009; }
          .alert-box { background-color: #F9EDE9; }
        </style>
      </head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;" bgcolor="#FDF5F3" class="dark-bg">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;" bgcolor="#FDF5F3" class="dark-bg">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);max-width:95%;" bgcolor="#ffffff" class="email-container dark-card">
              <!-- Header -->
              <tr>
                <td bgcolor="#5A1E12" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);background-color:#5A1E12;padding:36px 40px;text-align:center;" class="email-header header-gradient">
                  <p style="margin:0 0 8px 0;font-size:13px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:1px;">Email Verification</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Verify your identity to continue</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:40px 40px 30px;" class="email-body">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 8px;">Hi <strong>${name}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 30px;">Thank you for registering! Use the One-Time Password below to verify your email address.</p>

                  <!-- OTP Box -->
                  <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#F9EDE9 0%,#FDF5F3 100%);background-color:#F9EDE9;border:2px dashed #C4603A;border-radius:10px;padding:28px;text-align:center;margin:0 0 30px;">
                    <tr><td bgcolor="#F9EDE9" style="background-color:#F9EDE9;padding:28px;text-align:center;">
                      <p style="margin:0 0 6px;color:#7D2E1E;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Your OTP Code</p>
                      <div style="font-size:40px;font-weight:800;letter-spacing:12px;color:#5A1E12;">${otp}</div>
                      <p style="margin:10px 0 0;color:#C4603A;font-size:13px;"> Expires in 10 minutes</p>
                    </td></tr>
                  </table>

                  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F9EDE9;background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 6px 6px 0;padding:14px 18px;">
                    <tr><td bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-left:4px solid #C4603A;padding:14px 18px;">
                      <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">If you did not request this OTP, please ignore this email. Your account remains secure.</p>
                    </td></tr>
                  </table>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td bgcolor="#3D1009" style="background-color:#3D1009;padding:22px 40px;text-align:center;" class="email-footer footer-dark">
                  <p style="margin:0;color:#F0D0C8;font-size:12px;">This is an automated email &mdash; please do not reply.</p>
                  <p style="margin:6px 0 0;color:#8B5C54;font-size:11px;">&copy;? 2026 Made in Arnhem Land. All rights reserved.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:support@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">support@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    return await sendWithFallback(msg, 'OTP Email', { otp });
  } catch (error) {
    console.error("? Unexpected error in sendOTPEmail:", error);
    return { success: false, error: error.message || "Email service error" };
  }
};

// Send Finance Order Invoice Email

// Send Finance Order Invoice Email
const sendFinanceOrderInvoiceEmail = async (orderDetails, pdfBuffer) => {
  if (isDevelopmentMode) {
    console.log('\n' + '='.repeat(50));
    console.log('DEVELOPMENT MODE - Finance Order Invoice Email');
    console.log(`To: ${process.env.FINANCE_EMAIL_RECEIVER || 'ritikkashyap013@gmail.com'}`);
    console.log('=' .repeat(50) + '\n');
    return { success: true };
  }

  const content = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h2 style="color: #5A1E12; font-size: 24px; margin-bottom: 5px;">New Order Finance Copy</h2>
        <p style="color: #666; font-size: 14px; margin-top: 0;">Invoice generated for Order #${orderDetails.displayId}</p>
      </div>

      <div style="background: #fdf5f3; padding: 20px; border-radius: 8px; border-left: 4px solid #5A1E12; margin-bottom: 25px;">
        <p style="margin: 0 0 10px 0;">Hello <strong>Finance Team</strong>,</p>
        <p style="margin: 0; line-height: 1.5;">
          A new order has been successfully placed by <strong>${orderDetails.customerName || 'a Customer'}</strong>. 
          Please find the attached PDF invoice for your financial records and reconciliation.
        </p>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <thead>
          <tr>
            <th bgcolor="#5A1E12" style="background: #5A1E12; background-color: #5A1E12; color: #fff; text-align: left; padding: 12px 15px; border-radius: 6px 0 0 0;">Field</th>
            <th bgcolor="#5A1E12" style="background: #5A1E12; background-color: #5A1E12; color: #fff; text-align: left; padding: 12px 15px; border-radius: 0 6px 0 0;">Details</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td bgcolor="#ffffff" style="padding: 12px 15px; border-bottom: 1px solid #eee; border-left: 1px solid #eee; background-color: #ffffff;"><strong>Order Number</strong></td>
            <td bgcolor="#ffffff" style="padding: 12px 15px; border-bottom: 1px solid #eee; border-right: 1px solid #eee; background-color: #ffffff;">#${orderDetails.displayId}</td>
          </tr>
          <tr>
            <td bgcolor="#ffffff" style="padding: 12px 15px; border-bottom: 1px solid #eee; border-left: 1px solid #eee; background-color: #ffffff;"><strong>Total Amount</strong></td>
            <td bgcolor="#ffffff" style="padding: 12px 15px; border-bottom: 1px solid #eee; border-right: 1px solid #eee; background-color: #ffffff;">${(orderDetails.totalAmount || 0).toFixed(2)}</td>
          </tr>
          <tr>
            <td bgcolor="#ffffff" style="padding: 12px 15px; border-bottom: 1px solid #eee; border-left: 1px solid #eee; background-color: #ffffff;"><strong>Payment Method</strong></td>
            <td bgcolor="#ffffff" style="padding: 12px 15px; border-bottom: 1px solid #eee; border-right: 1px solid #eee; background-color: #ffffff;">${orderDetails.paymentMethod || 'N/A'}</td>
          </tr>
          <tr>
            <td bgcolor="#ffffff" style="padding: 12px 15px; border-left: 1px solid #eee; border-bottom: 1px solid #eee; background-color: #ffffff;"><strong>Customer Email</strong></td>
            <td bgcolor="#ffffff" style="padding: 12px 15px; border-right: 1px solid #eee; border-bottom: 1px solid #eee; background-color: #ffffff;">${orderDetails.customerEmail || 'No Email'}</td>
          </tr>
        </tbody>
      </table>

      <p style="font-size: 13px; color: #777; text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
        This is an automated system email for the Made in Arnhem Land finance team.
      </p>
    </div>
  `;

  const msg = {
    to: process.env.FINANCE_EMAIL_RECEIVER || 'ritikkashyap013@gmail.com',
    from: { email: senderEmail, name: senderName },
    subject: `[Finance Copy] Invoice for Order #${orderDetails.displayId}`,
    html: generateResponsiveEmailTemplate({
      title: 'Finance Copy - New Order Invoice',
      content: content,
      maxWidth: 650
    }),
    attachments: [{
      content: pdfBuffer.toString('base64'),
      filename: `invoice-${orderDetails.displayId}.pdf`,
      type: 'application/pdf',
      disposition: 'attachment'
    }]
  };

  try {
    await sgMail.send(msg);
    console.log(`? Finance invoice email sent to ${process.env.FINANCE_EMAIL_RECEIVER || 'ritikkashyap013@gmail.com'} for order ${orderDetails.displayId}`);
    return { success: true };
  } catch (error) {
    console.error('? Finance invoice email sending error:', error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Send Order Confirmation Email
const sendOrderConfirmationEmail = async (email, customerName, orderDetails) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Order Confirmation Email");
    console.log("=".repeat(50));
    console.log(`To: ${email}`);
    console.log(`Customer: ${customerName}`);
    console.log(`Order ID: ${orderDetails.displayId}`);
    console.log(`Total: $${orderDetails.totalAmount.toFixed(2)}`);
    console.log("=".repeat(50) + "\n");
    return { success: true, message: "Email logged to console (dev mode)" };
  }

  const gstPerc = parseFloat(orderDetails.orderSummary?.gstPercentage) || 10;
  const productRows = orderDetails.products.map(product => {
    const pPrice = parseFloat(product.price || 0); // inc GST
    const pQty = parseInt(product.quantity || 0, 10);
    const lineTotal = pPrice * pQty; // Total inc GST
    const gstAmt = lineTotal - (lineTotal / (1 + gstPerc / 100));
    const pPriceExGST = pPrice / (1 + gstPerc / 100); // unit price ex GST
    return `
    <tr style="border-bottom: 1px solid #ddd;">
      <td style="padding: 12px 8px;">${product.title || 'Product'}</td>
      <td style="padding: 12px 8px; text-align: center;">${product.quantity}</td>
      <td style="padding: 12px 8px; text-align: right;">$${pPriceExGST.toFixed(2)}</td>
      <td style="padding: 12px 8px; text-align: right; color: #888;">$${gstAmt.toFixed(2)} (${gstPerc}%)</td>
      <td style="padding: 12px 8px; text-align: right; font-weight: bold;">$${lineTotal.toFixed(2)}</td>
    </tr>
  `}).join('');

  // Normalise: shippingAddress may be a plain string (legacy) or an object
  const shippingAddrObj = typeof orderDetails.shippingAddress === 'string'
    ? { addressLine: orderDetails.shippingAddress }
    : (orderDetails.shippingAddress || {});

  const shippingLine  = shippingAddrObj.addressLine || shippingAddrObj.address || shippingAddrObj.street || '';
  const shippingCity  = shippingAddrObj.city  || '';
  const shippingState = shippingAddrObj.state || '';
  const shippingZip   = shippingAddrObj.pincode || shippingAddrObj.zipCode || shippingAddrObj.postalCode || '';
  const shippingName  = shippingAddrObj.name || orderDetails.customerName || customerName;
  const addressParts  = [shippingLine, shippingCity, shippingState, shippingZip].filter(Boolean).join(', ');

  // For seller & super admin copies, use the actual customer's email for API validations
  const targetEmail = orderDetails.customerEmail || email;
  const targetOrderId = (orderDetails.isSellerCopy && orderDetails.subOrderId) ? orderDetails.subOrderId : orderDetails.displayId;

  // Build guest-aware tracking URL
  const baseUrl = process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au';
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au';
  const backendBaseUrl = process.env.BACKEND_URL || process.env.API_URL || 'https://alpa-be.onrender.com';
  
  // Track goes to frontend. For sellers/admins, we just link to dashboard
  const trackingUrl = (orderDetails.isSellerCopy || orderDetails.isSuperAdminCopy)
    ? `${dashboardUrl}`
    : orderDetails.isGuest
      ? `${baseUrl}/guest/track-order?orderId=${orderDetails.displayId}&email=${encodeURIComponent(targetEmail)}`
      : `${dashboardUrl}/customerdashboard/orders`;

  // Authenticated users get the dedicated public email-download endpoint (no bearer token needed in links).
  // Guests use their email-verified endpoint for extra security.
  const invoiceUrl = orderDetails.isGuest
    ? `${backendBaseUrl}/api/orders/guest/invoice?orderId=${targetOrderId}&customerEmail=${encodeURIComponent(targetEmail)}`
    : `${backendBaseUrl}/api/orders/invoice/public/${targetOrderId}`;

  const content = `
    <!-- Header -->
    <tr>
      <td bgcolor="#5A1E12" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);background-color:#5A1E12;padding:36px 40px;text-align:center;" class="email-header">
        <p style="margin:0 0 8px 0;font-size:13px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
        <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;">Order Confirmed!</h1>
        <p style="margin:10px 0 0;color:#F0D0C8;font-size:15px;">
          ${orderDetails.isSellerCopy 
            ? `Seller Copy - Order placed by ${orderDetails.customerName || customerName}`
            : `Thank you for your purchase, ${customerName}!`
          }
        </p>
      </td>
    </tr>
    <!-- Invoice Meta -->
    <tr>
      <td style="padding:0;">
        <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-bottom:3px solid #C4603A;" class="dark-table-header">
          <tr>
            <td bgcolor="#F9EDE9" style="padding:16px 40px;background-color:#F9EDE9;" class="mobile-padding">
              <table width="100%" cellpadding="0" cellspacing="0" class="responsive-table mobile-table-stack">
                <tr>
                  <td style="padding:6px 0;color:#7D2E1E;font-size:14px;" class="dark-text"><strong>Invoice #</strong></td>
                  <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;" class="dark-text mobile-center">${orderDetails.displayId}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#7D2E1E;font-size:14px;" class="dark-text"><strong>Order Date</strong></td>
                  <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;" class="dark-text mobile-center">${new Date().toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Australia/Sydney' })}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#7D2E1E;font-size:14px;" class="dark-text"><strong>Payment Method</strong></td>
                  <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;" class="dark-text mobile-center">${orderDetails.paymentMethod || 'Credit/Debit Card'}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <!-- Shipping Info -->
    <tr>
      <td style="padding:28px 40px 10px;" class="email-body">
        <table width="100%" cellpadding="0" cellspacing="0" class="responsive-table">
          <tr>
            <td width="48%" valign="top" style="padding-right:10px;" class="two-col mobile-padding">
              <div style="background:#F9EDE9;border-radius:8px;padding:16px;border-top:3px solid #5A1E12;" class="dark-table-bg">
                <p style="margin:0 0 10px;color:#5A1E12;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;" class="dark-text">${orderDetails.isSuperAdminCopy || orderDetails.isSellerCopy ? 'Customer Details' : 'Your Details'}</p>
                <p style="margin:4px 0;color:#333;font-size:14px;" class="dark-text"><strong>${orderDetails.customerName || customerName}</strong></p>
                <p style="margin:4px 0;color:#555;font-size:13px;" class="dark-text-secondary">${orderDetails.customerEmail || email}</p>
                ${orderDetails.customerPhone ? `<p style="margin:4px 0;color:#555;font-size:13px;" class="dark-text-secondary">${orderDetails.customerPhone}</p>` : ''}
              </div>
            </td>
            <td width="4%" class="two-col-spacing"></td>
            <td width="48%" valign="top" style="padding-left:10px;" class="two-col mobile-padding">
              <div style="background:#F9EDE9;border-radius:8px;padding:16px;border-top:3px solid #C4603A;" class="dark-table-bg">
                <p style="margin:0 0 10px;color:#5A1E12;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;" class="dark-text">Shipping Address</p>
                <p style="margin:4px 0;color:#333;font-size:14px;" class="dark-text"><strong>${shippingName}</strong></p>
                <p style="margin:4px 0;color:#555;font-size:13px;line-height:1.6;" class="dark-text-secondary">${addressParts || 'Address not provided'}</p>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <!-- Items Table -->
    <tr>
      <td style="padding:10px 40px 28px;" class="email-body">
        <p style="color:#5A1E12;font-size:16px;font-weight:700;margin:0 0 12px;" class="dark-text">Order Items</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(90,30,18,0.1);" class="responsive-table dark-table-bg">
          <thead>
            <tr bgcolor="#5A1E12" style="background-color:#5A1E12;">
              <th bgcolor="#5A1E12" style="padding:13px 12px;text-align:left;color:#fff;font-size:13px;background-color:#5A1E12;">Product</th>
              <th bgcolor="#5A1E12" style="padding:13px 12px;text-align:center;color:#fff;font-size:13px;background-color:#5A1E12;">Qty</th>
              <th bgcolor="#5A1E12" style="padding:13px 12px;text-align:right;color:#fff;font-size:13px;background-color:#5A1E12;">Unit Price</th>
              <th bgcolor="#5A1E12" style="padding:13px 12px;text-align:right;color:#fff;font-size:13px;background-color:#5A1E12;">GST</th>
              <th bgcolor="#5A1E12" style="padding:13px 12px;text-align:right;color:#fff;font-size:13px;background-color:#5A1E12;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${productRows}
          </tbody>
          <tfoot>
            <!-- Subtotal row -->
            <tr bgcolor="#fdf5f3" style="background-color:#fdf5f3;">
              <td colspan="4" bgcolor="#fdf5f3" style="padding:10px 12px;text-align:right;color:#555;font-size:14px;background-color:#fdf5f3;">Subtotal (inc. GST)</td>
              <td bgcolor="#fdf5f3" style="padding:10px 12px;text-align:right;color:#333;font-size:14px;background-color:#fdf5f3;">$${
                orderDetails.orderSummary
                  ? parseFloat(orderDetails.orderSummary.subtotal || 0).toFixed(2)
                  : orderDetails.totalAmount.toFixed(2)
              }</td>
            </tr>
            <!-- Shipping row -->
            <tr bgcolor="#fdf5f3" style="background-color:#fdf5f3;">
              <td colspan="4" bgcolor="#fdf5f3" style="padding:6px 12px;text-align:right;color:#555;font-size:14px;background-color:#fdf5f3;">
                Shipping${orderDetails.orderSummary?.shippingMethod?.name ? ` &mdash; ${orderDetails.orderSummary.shippingMethod.name}` : ''}${orderDetails.orderSummary?.shippingMethod?.estimatedDays ? ` (${orderDetails.orderSummary.shippingMethod.estimatedDays})` : ''}
              </td>
              <td bgcolor="#fdf5f3" style="padding:6px 12px;text-align:right;color:#333;font-size:14px;background-color:#fdf5f3;">${
                orderDetails.orderSummary && parseFloat(orderDetails.orderSummary.shippingCost || 0) > 0
                  ? `$${parseFloat(orderDetails.orderSummary.shippingCost).toFixed(2)}`
                  : '<span style="color:#2e7d32;font-weight:600;">FREE</span>'
              }</td>
            </tr>
            <!-- Coupon Discount row (only shown when a coupon was applied) -->
            ${orderDetails.orderSummary?.discountAmount && parseFloat(orderDetails.orderSummary.discountAmount) > 0 ? `
            <tr bgcolor="#fdf5f3" style="background-color:#fdf5f3;">
              <td colspan="4" bgcolor="#fdf5f3" style="padding:6px 12px;text-align:right;color:#2e7d32;font-size:14px;background-color:#fdf5f3;">Coupon Discount${orderDetails.orderSummary.couponCode ? ` (${orderDetails.orderSummary.couponCode})` : ''}</td>
              <td bgcolor="#fdf5f3" style="padding:6px 12px;text-align:right;color:#2e7d32;font-size:14px;font-weight:600;background-color:#fdf5f3;">-$${parseFloat(orderDetails.orderSummary.discountAmount).toFixed(2)}</td>
            </tr>` : ''}
            <!-- GST extracted row -->
            <tr bgcolor="#fdf5f3" style="background-color:#fdf5f3;">
              <td colspan="4" bgcolor="#fdf5f3" style="border-top:1px dashed #ddd;padding:6px 12px;text-align:right;font-size:13px;color:#555;background-color:#fdf5f3">
                GST included${orderDetails.orderSummary?.gstPercentage ? ` (${parseFloat(orderDetails.orderSummary.gstPercentage).toFixed(0)}%)` : ''}
              </td>
              <td bgcolor="#fdf5f3" style="border-top:1px dashed #ddd;padding:6px 12px;text-align:right;color:#888;font-size:13px;font-style:italic;background-color:#fdf5f3;">$${
                orderDetails.orderSummary
                  ? parseFloat(orderDetails.orderSummary.gstAmount || 0).toFixed(2)
                  : '0.00'
              }</td>
            </tr>
            <!-- Net ex-GST row -->
            <tr bgcolor="#fdf5f3" style="background-color:#fdf5f3;">
              <td colspan="4" bgcolor="#fdf5f3" style="padding:6px 12px;text-align:right;font-size:13px;color:#555;background-color:#fdf5f3">Net amount (ex. GST)</td>
              <td bgcolor="#fdf5f3" style="padding:6px 12px;text-align:right;color:#888;font-size:13px;font-style:italic;background-color:#fdf5f3;">$${
                orderDetails.orderSummary
                  ? parseFloat(orderDetails.orderSummary.subtotalExGST || 0).toFixed(2)
                  : '0.00'
              }</td>
            </tr>
            <!-- Grand Total row -->
            <tr bgcolor="#F9EDE9" style="background-color:#F9EDE9;">
              <td colspan="4" bgcolor="#F9EDE9" style="border-top:2px solid #C4603A;padding:16px 12px;text-align:right;color:#5A1E12;font-size:16px;font-weight:700;background-color:#F9EDE9;">Grand Total</td>
              <td bgcolor="#F9EDE9" style="border-top:2px solid #C4603A;padding:16px 12px;text-align:right;color:#5A1E12;font-size:20px;font-weight:800;background-color:#F9EDE9;">$${orderDetails.totalAmount.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </td>
    </tr>
    <!-- Next Steps -->
    <tr>
      <td style="padding:0 40px 28px;">
        <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
          <p style="margin:0 0 8px;color:#5A1E12;font-weight:700;font-size:14px;">What happens next?</p>
          <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> Your order is being processed by our seller</p>
          <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> You'll receive a shipping confirmation when dispatched</p>
          <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> Track your order anytime from your account</p>
          <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> If you have any issues with the orders, please <a href="https://madeinarnhemland.com.au/contact-us" style="color:#C4603A;text-decoration:underline;">contact</a> us</p>
        </div>
      </td>
    </tr>
    <!-- CTA -->
    <tr>
      <td style="padding:0 40px 36px;text-align:center;" class="email-body">
        <table width="100%" cellpadding="0" cellspacing="0" class="btn-table"><tr>
          <td style="padding-right:8px;text-align:right;" class="btn-cell">
            <a href="${trackingUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.5px;margin:5px;" class="mobile-btn">Track Order</a>
          </td>
          <td style="padding-left:8px;text-align:left;" class="btn-cell">
            <a href="${invoiceUrl}" style="display:inline-block;background-color:#C4603A;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.5px;margin:5px;" class="mobile-btn">Download Invoice</a>
          </td>
        </tr></table>
      </td>
    </tr>
    <!-- Footer -->
    <tr>
      <td bgcolor="#3D1009" style="background-color:#3D1009;padding:22px 40px;text-align:center;" class="email-footer">
        <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Thank you for the order</p>
        <p style="margin:0 0 8px;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
        <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:support@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">support@madeinarnhemland.com.au</a></p>
      </td>
    </tr>
  `;

  const msg = {
    to: email,
    from: {
      email: senderEmail,
      name: senderName
    },
    subject: `Order Confirmation - Invoice #${orderDetails.displayId}`,
    html: generateResponsiveEmailTemplate({
      title: `Order Confirmation - Made in Arnhem Land`,
      content: content,
      maxWidth: 650
    }),
  };

  try {
    // Attach invoice PDF if provided
    if (orderDetails.invoicePDFBuffer) {
      msg.attachments = [{
        content: orderDetails.invoicePDFBuffer.toString('base64'),
        filename: `invoice-${orderDetails.displayId}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment'
      }];
    }
    await sgMail.send(msg);
    console.log(`Order confirmation email sent to ${email}`);
    return { success: true, message: "Email sent successfully" };
  } catch (error) {
    console.error("Email sending error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};


// Send Order Status Update Email
const sendOrderStatusEmail = async (email, customerName, orderDetails) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Order Status Update");
    console.log("=".repeat(50));
    console.log(`To: ${email}`);
    console.log(`Status: ${orderDetails.status}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  let statusMessage = "";
  let statusColor = "#C4603A";      // default: terracotta (brand accent)
  let statusTextColor = "#ffffff";

  switch (orderDetails.status?.toLowerCase()) {
    case "confirmed":
      statusMessage = "Your order has been confirmed! We are now preparing it for you. ";
      statusColor = "#4CAF50";
      break;
    case "processing":
      statusMessage = "Your order is now being processed and prepared for shipping. ";
      statusColor = "#B05E2A";
      break;
    case "packed":
      statusMessage = "Your order has been packed and is ready for shipping! ";
      statusColor = "#B05E2A";
      break;
    case "shipped":
      statusMessage = "Great news! Your order has been shipped!";
      statusColor = "#6B4C9A";
      break;
    case "delivered":
      statusMessage = "Your order has been delivered!";
      statusColor = "#C4963A";      // warm amber/cream-gold ? replaces green
      break;
    case "cancelled":
      statusMessage = "Your order has been cancelled. If you paid online, a refund will be processed within 3-5 business days.";
      statusColor = "#A03020";
      break;
    case "refund":
      statusMessage = "Your order has been fully refunded. The amount will reflect in your account as per your payment provider timeline.";
      statusColor = "#2E7D32";
      break;
    case "partial_refund":
      statusMessage = "A partial refund has been issued for your order. Please check your account for the credited amount.";
      statusColor = "#6B4C9A";
      break;
    default:
      statusMessage = `Your order status has been updated to: <strong>${orderDetails.status}</strong>`;
  }

  // Build products rows if available
  const gstPerc = parseFloat(orderDetails.orderSummary?.gstPercentage) || 10;
  const productRows = (orderDetails.products || []).map(p => {
    const pPrice = parseFloat(p.price || 0);
    const pQty = parseInt(p.quantity || 0, 10);
    const lineTotal = pPrice * pQty;
    const gstAmt = lineTotal - (lineTotal / (1 + gstPerc / 100));
    const pPriceExGST = pPrice / (1 + gstPerc / 100);
    return `
    <tr style="border-bottom:1px solid #EDD8CC;">
      <td style="padding:10px 12px;color:#333;font-size:14px;">${p.title || 'Product'}</td>
      <td style="padding:10px 12px;text-align:center;color:#555;font-size:14px;">${p.quantity}</td>
      <td style="padding:10px 12px;text-align:right;color:#555;font-size:14px;">$${pPriceExGST.toFixed(2)}</td>
      <td style="padding:10px 12px;text-align:right;color:#888;font-size:14px;">$${gstAmt.toFixed(2)} (${gstPerc}%)</td>
      <td style="padding:10px 12px;text-align:right;color:#5A1E12;font-size:14px;font-weight:700;">$${lineTotal.toFixed(2)}</td>
    </tr>
  `}).join('');

  // Build shipping address
  const shippingParts = [
    orderDetails.shippingAddress,
    orderDetails.shippingCity,
    orderDetails.shippingState,
    orderDetails.shippingZipCode,
    orderDetails.shippingCountry
  ].filter(Boolean).join(', ');

  // Build guest-aware tracking URL
  const baseUrl = process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au';
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au';
  const backendBaseUrl = process.env.BACKEND_URL || process.env.API_URL || 'https://alpa-be.onrender.com';
  const trackingUrl = orderDetails.isGuest
    ? `${baseUrl}/guest/track-order?orderId=${orderDetails.displayId}&email=${encodeURIComponent(email)}`
    : `${dashboardUrl}/customerdashboard/orders`;
  // Authenticated users get the dedicated public email-download endpoint.
  // Guests use their email-verified endpoint for extra security.
  const invoiceUrl = orderDetails.isGuest
    ? `${backendBaseUrl}/api/orders/guest/invoice?orderId=${orderDetails.displayId}&customerEmail=${encodeURIComponent(email)}`
    : `${backendBaseUrl}/api/orders/invoice/public/${orderDetails.displayId}`;

  const msg = {
    to: email,
    from: {
      name: senderName,
      email: senderEmail
    },
        subject: `Order Update: #${orderDetails.displayId} - Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="color-scheme" content="light dark">
        <style>
          @media screen and (max-width: 640px) {
            .email-container { width: 100% !important; margin: 0 10px !important; max-width: calc(100% - 20px) !important; }
            .email-header { padding: 24px 20px !important; }
            .email-body { padding: 20px !important; }
            .email-footer { padding: 16px 20px !important; }
            .responsive-table { width: 100% !important; }
            .mobile-center { text-align: center !important; }
            .btn-table { width: 100% !important; }
            .btn-cell { display: block !important; width: 100% !important; padding: 5px 0 !important; text-align: center !important; }
          }
          @media (prefers-color-scheme: dark) {
            .dark-bg { background-color: #1a1a1a !important; }
            .dark-card { background-color: #2d2d2d !important; border: 1px solid #404040 !important; }
            .dark-text { color: #e0e0e0 !important; }
            .dark-text-secondary { color: #b0b0b0 !important; }
            .dark-table-bg { background-color: #333333 !important; }
          }
          
          /* Comprehensive print CSS for all email templates */
          ${getPrintSafeCSS().replace(/^@media screen[\s\S]*?}\s*/, '').replace(/^@media print \{/, '@media print {')}
        </style>
      </head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;" class="dark-bg">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;" class="dark-bg">
          <tr><td align="center">
            <table width="620" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);max-width:95%;" class="email-container dark-card">

              <!-- Brand Header -->
              <tr>
                <td bgcolor="#5A1E12" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);background-color:#5A1E12;padding:30px 40px;text-align:center;">
                  <p style="margin:0 0 6px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">  Order Update</h1>
                </td>
              </tr>

              <!-- Status Banner -->
              <tr>
                <td bgcolor="${statusColor}" style="background-color:${statusColor};padding:18px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:16px;font-weight:600;line-height:1.5;">${statusMessage}</p>
                </td>
              </tr>

              <!-- Greeting -->
              <tr>
                <td style="padding:32px 40px 0;">
                  <p style="color:#3D1009;font-size:16px;margin:0 0 6px;">Hi <strong>${customerName}</strong>,</p>
                  <p style="color:#666;font-size:14px;line-height:1.7;margin:0 0 28px;">Here is a full summary of your order for your reference.</p>
                </td>
              </tr>

              <!-- Order Meta -->
              <tr>
                <td style="padding:0 40px 20px;">
                  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-radius:8px;border-top:3px solid #5A1E12;"><tr><td bgcolor="#F9EDE9" style="padding:20px;background-color:#F9EDE9;">
                    <p style="margin:0 0 14px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Order Details</p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order ID</strong></td>
                        <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">#${orderDetails.displayId}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order Date</strong></td>
                        <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${orderDetails.orderDate ? new Date(orderDetails.orderDate).toLocaleDateString('en-AU',{year:'numeric',month:'long',day:'numeric',timeZone:'Australia/Sydney'}) : new Date().toLocaleDateString('en-AU',{year:'numeric',month:'long',day:'numeric',timeZone:'Australia/Sydney'})}</td>
                      </tr>
                      ${orderDetails.paymentMethod ? `<tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Payment Method</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${orderDetails.paymentMethod}</td></tr>` : ''}
                      <tr>
                        <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Status</strong></td>
                        <td style="padding:6px 0;text-align:right;"><table cellpadding="0" cellspacing="0" align="right"><tr><td bgcolor="${statusColor}" style="background-color:${statusColor};color:#ffffff;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap;-webkit-text-fill-color:#ffffff;">${(orderDetails.status || '').toUpperCase()}</td></tr></table></td>
                      </tr>
                      ${orderDetails.trackingNumber && orderDetails.status?.toLowerCase() !== 'delivered' ? `<tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Your Tracking Number</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">${orderDetails.trackingNumber}</td></tr>` : ''}
                      ${orderDetails.estimatedDelivery && orderDetails.status?.toLowerCase() !== 'delivered' ? `<tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Your Est. Delivery</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${new Date(orderDetails.estimatedDelivery).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</td></tr>` : ''}
                    </table>
                  </td></tr></table>
                </td>
              </tr>

              <!-- Shipping Address -->
              ${shippingParts ? `
              <tr>
                <td style="padding:0 40px 20px;">
                  <div style="background:#F9EDE9;border-radius:8px;padding:20px;border-top:3px solid #C4603A;">
                    <p style="margin:0 0 10px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Shipping Address</p>
                    <p style="margin:0;color:#333;font-size:14px;line-height:1.8;">
                      <strong>${orderDetails.shippingName || customerName}</strong><br/>
                      ${shippingParts}
                      ${orderDetails.shippingPhone ? `<br/>${orderDetails.shippingPhone}` : ''}
                    </p>
                  </div>
                </td>
              </tr>` : ''}

              <!-- Products Table -->
              ${productRows ? `
              <tr>
                <td style="padding:0 40px 20px;">
                  <p style="color:#5A1E12;font-size:15px;font-weight:700;margin:0 0 10px;">Items Ordered</p>
                  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(90,30,18,0.08);">
                    <thead>
                      <tr style="background-color:#5A1E12;">
                        <th style="padding:11px 12px;text-align:left;color:#fff;font-size:13px;">Product</th>
                        <th style="padding:11px 12px;text-align:center;color:#fff;font-size:13px;">Qty</th>
                        <th style="padding:11px 12px;text-align:right;color:#fff;font-size:13px;">Unit Price</th>
                        <th style="padding:11px 12px;text-align:right;color:#fff;font-size:13px;">GST</th>
                      <th style="padding:11px 12px;text-align:right;color:#fff;font-size:13px;">Total</th>
                      </tr>
                    </thead>
                    <tbody>${productRows}</tbody>
                    <tfoot>
                      <!-- Grand Total row -->
                      <tr style="background-color:#F9EDE9;">
                        <td colspan="4" style="border-top:2px solid #C4603A;padding:16px 12px;text-align:right;color:#5A1E12;font-size:16px;font-weight:700;">Grand Total</td>
                        <td style="border-top:2px solid #C4603A;padding:16px 12px;text-align:right;color:#5A1E12;font-size:20px;font-weight:800;">$${parseFloat(orderDetails.totalAmount || 0).toFixed(2)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </td>
              </tr>` : ''}

              <!-- CTA -->
              <tr>
                <td style="padding:10px 40px 36px;text-align:center;">
                  ${orderDetails.status?.toLowerCase() === 'delivered' ? `
                    <!-- Delivered: Download Invoice + Issue with order (guests only) -->
                    <table width="100%" cellpadding="0" cellspacing="0"><tr>
                      <td style="text-align:center;padding-bottom:12px;" colspan="2">
                        <a href="${invoiceUrl}" style="display:inline-block;background-color:#C4603A;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Download Invoice</a>
                      </td>
                    </tr>${orderDetails.isGuest ? `
                    <tr>
                      <td style="text-align:center;padding-top:4px;" colspan="2">
                        <a href="https://madeinarnhemland.com.au/guest/refund" style="display:inline-block;background-color:#ffffff;color:#7D2E1E;padding:11px 24px;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;border:2px solid #C4603A;">Issue with your order? Request a refund</a>
                      </td>
                    </tr>` : ''}</table>
                  ` : `
                    <!-- Other statuses: Show both buttons -->
                    <table width="100%" cellpadding="0" cellspacing="0"><tr>
                      <td style="padding-right:8px;text-align:right;">
                        <a href="${trackingUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Track Order</a>
                      </td>
                      <td style="padding-left:8px;text-align:left;">
                        <a href="${invoiceUrl}" style="display:inline-block;background-color:#C4603A;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Download Invoice</a>
                      </td>
                    </tr></table>
                  `}
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td bgcolor="#3D1009" style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Thank you for shopping with us!   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:support@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">support@madeinarnhemland.com.au</a></p>
                </td>
              </tr>

            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    // Attach invoice PDF if provided
    if (orderDetails.invoicePDFBuffer) {
      msg.attachments = [{
        content: orderDetails.invoicePDFBuffer.toString('base64'),
        filename: `invoice-${orderDetails.displayId}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment'
      }];
    }
    await sgMail.send(msg);
    return { success: true };
  } catch (error) {
    console.error("? Email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Send Seller Order Notification Email
const sendSellerOrderNotificationEmail = async (email, sellerName, orderDetails) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Notification");
    console.log("=".repeat(50));
    console.log(`To: ${email}`);
    console.log(`Seller: ${sellerName}`);
    console.log(`Order: ${orderDetails.displayId}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const productRows = orderDetails.products ? orderDetails.products.map(product => `
    <tr style="border-bottom: 1px solid #ddd;">
      <td style="padding: 12px 8px;">${product.title || 'Product'}</td>
      <td style="padding: 12px 8px; text-align: center;">${product.quantity}</td>
      <td style="padding: 12px 8px; text-align: right;">$${(product.price || 0).toFixed(2)}</td>
    </tr>
  `).join('') : '';

  const msg = {
    to: email,
    from: {
      email: senderEmail,
      name: senderName
    },
    subject: `New Order Received: #${orderDetails.displayId} - Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;" bgcolor="#FDF5F3">
          <tr><td align="center">
            <table width="650" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);" bgcolor="#ffffff">
              <!-- Header -->
              <tr>
                <td bgcolor="#5A1E12" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);background-color:#5A1E12;padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Seller Dashboard</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">New Order Received!</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">You have a new order to process</p>
                </td>
              </tr>
              <!-- Alert banner -->
              <tr>
                <td bgcolor="#C4603A" style="background-color:#C4603A;padding:12px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:14px;font-weight:600;">Action Required &mdash; please process this order promptly</p>
                </td>
              </tr>
              <!-- Seller greeting -->
              <tr>
                <td style="padding:28px 40px 16px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 6px;">Hi <strong>${sellerName}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0;">Great news! A customer has placed an order for your product(s). Check the details below and update the status in your seller dashboard.</p>
                </td>
              </tr>
              <!-- Order summary -->
              <tr>
                <td style="padding:0 40px 20px;">
                  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-radius:8px;padding:20px;border-top:3px solid #5A1E12;">
                    <tr><td bgcolor="#F9EDE9" style="padding:20px;background-color:#F9EDE9;">
                      <p style="margin:0 0 14px;color:#5A1E12;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Order Summary</p>
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order ID</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">#${orderDetails.displayId}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order Date</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${new Date().toLocaleDateString('en-AU',{year:'numeric',month:'long',day:'numeric',timeZone:'Australia/Sydney'})}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Your Earnings</strong></td>
                          <td style="padding:6px 0;color:#5A1E12;font-size:18px;font-weight:800;text-align:right;">$${orderDetails.totalAmount.toFixed(2)}</td>
                        </tr>
                      </table>
                    </td></tr>
                  </table>
                </td>
              </tr>
              <!-- Products -->
              ${productRows ? `
              <tr>
                <td style="padding:0 40px 20px;">
                  <p style="color:#5A1E12;font-size:15px;font-weight:700;margin:0 0 10px;">Products Ordered</p>
                  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:8px;overflow:hidden;">
                    <thead><tr bgcolor="#5A1E12" style="background-color:#5A1E12;"><th bgcolor="#5A1E12" style="padding:11px 12px;text-align:left;color:#fff;font-size:13px;background-color:#5A1E12;">Product</th><th bgcolor="#5A1E12" style="padding:11px 12px;text-align:center;color:#fff;font-size:13px;background-color:#5A1E12;">Qty</th><th bgcolor="#5A1E12" style="padding:11px 12px;text-align:right;color:#fff;font-size:13px;background-color:#5A1E12;">Price</th></tr></thead>
                    <tbody>${productRows}</tbody>
                  </table>
                </td>
              </tr>` : ''}
              <!-- Action Required ?-->
              <tr>
                <td style="padding:0 40px 20px;">
                  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <tr><td bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-left:4px solid #C4603A;padding:16px 20px;">
                      <p style="margin:0 0 8px;color:#5A1E12;font-weight:700;font-size:14px;">Checklist</p>
                      <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> Log into your seller dashboard</p>
                      <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> Confirm the order and verify stock</p>
                      <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> Pack and ship within 2?3 business days</p>
                      <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> Add tracking information once dispatched</p>
                    </td></tr>
                  </table>
                </td>
              </tr>
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <table width="100%" cellpadding="0" cellspacing="0"><tr>
                    <td style="padding-right:8px;text-align:right;">
                      <a href="${process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/seller/orders/${orderDetails.displayId}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">View in Dashboard</a>
                    </td>
                    <td style="padding-left:8px;text-align:left;">
                      <a href="${process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/seller/orders/${orderDetails.displayId}" style="display:inline-block;background-color:#C4603A;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Download Invoice</a>
                    </td>
                  </tr></table>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td bgcolor="#3D1009" style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Thank you for being a valued Made in Arnhem Land seller!</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    return { success: true };
  } catch (error) {
    console.error("? Email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Send Contact Form Email
const sendContactFormEmail = async (email, name, subject, message) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Contact Form");
    console.log("=".repeat(50));
    console.log(`To: ${email}`);
    console.log(`Subject: ${subject}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const msg = {
    to: email,
    from: {
      email: senderEmail,
      name: senderName
    },
    subject: `Contact Form Received - ${subject}`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);" bgcolor="#ffffff">
              <!-- Header -->
              <tr>
                <td bgcolor="#5A1E12" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);background-color:#5A1E12;padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">Message Received</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">We'll be in touch soon!</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${name}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Thank you for reaching out! We've received your message and our support team will review it shortly.</p>

                  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #5A1E12;margin-bottom:22px;">
                    <tr><td bgcolor="#F9EDE9" style="padding:22px;background-color:#F9EDE9;">
                      <p style="margin:0 0 14px;color:#5A1E12;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Your Message</p>
                      <p style="margin:0 0 8px;color:#7D2E1E;font-size:14px;"><strong>Subject:</strong> <span style="color:#3D1009;">${subject}</span></p>
                      <p style="margin:0 0 6px;color:#7D2E1E;font-size:14px;"><strong>Message:</strong></p>
                      <p style="margin:0;color:#555;font-size:14px;line-height:1.7;">${message}</p>
                    </td></tr>
                  </table>

                  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <tr><td bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-left:4px solid #C4603A;padding:16px 20px;">
                      <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;">? Response Time</p>
                      <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">Our support team typically responds within 24?48 business hours. You'll receive a reply at this email address.</p>
                    </td></tr>
                  </table>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td bgcolor="#3D1009" style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Customer Support</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated confirmation &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    return { success: true };
  } catch (error) {
    console.error("? Email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Send SLA Warning Email
const sendSLAWarningEmail = async (sellerId, orderId, notificationType, slaStatus) => {
  try {
    const prisma = require('../config/prisma');
    
    const seller = await prisma.user.findUnique({
      where: { id: sellerId },
      select: { email: true, name: true }
    });

    if (!seller?.email) {
      return { success: false, error: "Seller email not found" };
    }

    if (isDevelopmentMode) {
      console.log("\n SLA WARNING:", seller.email, orderId, notificationType);
      return { success: true };
    }

    const urgencyColor = slaStatus.status === 'BREACHED' ? '#e74c3c' : '#f39c12';

    const msg = {
      to: seller.email,
      from: {
        email: senderEmail,
        name: senderName
      },
      subject: `Action Required: ${notificationType} - Order #${orderId} - Made in Arnhem Land`,
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
        <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.15);">
                <!-- Brand Header -->
                <tr>
                  <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:20px 40px;text-align:center;">
                    <p style="margin:0;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  </td>
                </tr>
                <!-- Urgency Banner -->
                <tr>
                  <td style="background-color:${urgencyColor};padding:28px 40px;text-align:center;">
                    <h1 style="margin:0 0 6px;color:#ffffff;font-size:26px;font-weight:800;">SLA ${slaStatus.status === 'BREACHED' ? 'BREACHED' : 'WARNING'}</h1>
                    <p style="margin:0;color:rgba(255,255,255,0.9);font-size:14px;">Immediate action required</p>
                  </td>
                </tr>
                <!-- Body -->
                <tr>
                  <td style="padding:32px 40px;">
                    <p style="color:#3D1009;font-size:16px;margin:0 0 24px;">
                      ${slaStatus.status === 'BREACHED' ? 'This order is <strong>OVERDUE</strong> and requires immediate attention.' : 'This order is approaching its SLA deadline and needs your attention soon.'}
                    </p>

                    <!-- Order Details -->
                    <div style="background:#F9EDE9;border-radius:8px;padding:20px;border-top:3px solid #5A1E12;margin-bottom:20px;">
                      <p style="margin:0 0 14px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Order Details</p>
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order ID</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">#${orderId || 'N/A'}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Action Required</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${notificationType.replace(/_/g, ' ')}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>SLA Status</strong></td>
                          <td style="padding:6px 0;text-align:right;"><span style="background-color:${urgencyColor};color:#fff;padding:3px 12px;border-radius:20px;font-size:13px;font-weight:600;">${slaStatus.status}</span></td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Time</strong></td>
                          <td style="padding:6px 0;color:${urgencyColor};font-size:14px;font-weight:700;text-align:right;">${slaStatus.isOverdue ? `OVERDUE by ${Math.abs(slaStatus.timeRemaining).toFixed(1)} hrs` : `${slaStatus.timeRemaining.toFixed(1)} hrs remaining`}</td>
                        </tr>
                      </table>
                    </div>

                    <!-- Steps -->
                    <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:28px;">
                      <p style="margin:0 0 8px;color:#5A1E12;font-weight:700;font-size:14px;">Next Steps</p>
                      <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> Log into your seller dashboard immediately</p>
                      <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> Update the order status</p>
                      <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> Add tracking information if shipping</p>
                      <p style="margin:4px 0;color:#7D2E1E;font-size:13px;"> Contact the customer if required</p>
                    </div>

                    <!-- CTA -->
                    <div style="text-align:center;">
                      <a href="${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au/'}/sellerdashboard/orders" style="display:inline-block;background-color:${urgencyColor};color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Take Action Now</a>
                    </div>
                  </td>
                </tr>
                <!-- Footer -->
                <tr>
                  <td style="background-color:#3D1009;padding:20px 40px;text-align:center;">
                    <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Automated SLA Monitor</p>
                    <p style="margin:0;color:#8B5C54;font-size:11px;">Please do not reply to this email. &copy; 2026 Made in Arnhem Land.</p>
                    <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `,
    };

    await sgMail.send(msg);
    return { success: true };
  } catch (error) {
    console.error("? SLA email error:", error);
    return { success: false, error: error.message };
  }
};

// Send Seller Application Submitted Email
const sendSellerApplicationSubmittedEmail = async (email, name, applicationId) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Application Submitted");
    console.log("=".repeat(50));
    console.log(`To: ${email}`);
    console.log(`Name: ${name}`);
    console.log(`Application ID: ${applicationId}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const msg = {
    to: email,
    from: { email: senderEmail, name: senderName },
        subject: "Your Seller Application Has Been Submitted ? Made in Arnhem Land",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="color-scheme" content="light dark">
        <style>
          @media screen and (max-width: 640px) {
            .email-container { width: 100% !important; margin: 0 10px !important; max-width: calc(100% - 20px) !important; }
            .email-header { padding: 24px 20px !important; }
            .email-body { padding: 20px !important; }
            .email-footer { padding: 16px 20px !important; }
            .responsive-table { width: 100% !important; }
            .mobile-center { text-align: center !important; }
            .mobile-padding { padding: 10px !important; }
          }
          
          @media (prefers-color-scheme: dark) {
            .dark-bg { background-color: #1a1a1a !important; }
            .dark-card { background-color: #2d2d2d !important; border: 1px solid #404040 !important; }
            .dark-text { color: #e0e0e0 !important; }
            .dark-text-secondary { color: #b0b0b0 !important; }
            .dark-table-bg { background-color: #333333 !important; }
          }
          
          @media print {
            /* GLOBAL PRINT COLOR FORCING - Works for ALL email templates */
            * {
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
              color-adjust: exact !important;
            }
            
            /* Force body and page backgrounds to print */
            body, html {
              background-color: #FDF5F3 !important;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            
            /* === BRAND HEADER STYLING === */
            .email-header, [style*="background:linear-gradient(135deg,#5A1E12"], [style*="background:linear-gradient(135deg, #5A1E12"] {
              background: linear-gradient(135deg, #5A1E12 0%, #7D2E1E 100%) !important;
              color: #ffffff !important;
              border: 2px solid #5A1E12 !important;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            
            /* === BRAND FOOTER STYLING === */
            .email-footer, [style*="background-color:#3D1009"] {
              background-color: #3D1009 !important;
              color: #F0D0C8 !important;
              border: 2px solid #3D1009 !important;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            
            /* === INFO BOXES & ALERTS === */
            .info-box, [style*="background:#F9EDE9"], [style*="background-color:#F9EDE9"] {
              background-color: #F9EDE9 !important;
              border: 2px solid #C4603A !important;
              border-left: 4px solid #C4603A !important;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            
            /* === NUMBERED STEPS === */
            [style*="background:#5A1E12"] {
              background-color: #5A1E12 !important;
              color: #ffffff !important;
              border: 1px solid #5A1E12 !important;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            
            /* === FORCE ALL INLINE BACKGROUNDS === */
            [style*="background"], [style*="background-color"], [style*="background:"] {
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            
            /* === TABLE STYLING === */
            table {
              background-color: #ffffff !important;
              border-collapse: collapse !important;
            }
            
            /* === PAGE LAYOUT === */
            .email-container {
              page-break-inside: avoid !important;
            }
          }
        </style>
      </head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;" class="dark-bg">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;" class="dark-bg">>
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Application Submitted!</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">We've received your seller application</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${name}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Thank you for completing your seller application on Made in Arnhem Land! Your application has been received and is now under review by our team.</p>

                  <!-- Status box -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #5A1E12;margin-bottom:24px;">
                    <p style="margin:0 0 14px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">What Happens Next?</p>
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:8px 0;vertical-align:top;">
                          <span style="display:inline-block;background:#5A1E12;color:#fff;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-size:12px;font-weight:700;margin-right:12px;">1</span>
                        </td>
                        <td style="padding:8px 0;color:#555;font-size:14px;line-height:1.6;">Our admin team will review your submitted details and KYC documents.</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;vertical-align:top;">
                          <span style="display:inline-block;background:#5A1E12;color:#fff;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-size:12px;font-weight:700;margin-right:12px;">2</span>
                        </td>
                        <td style="padding:8px 0;color:#555;font-size:14px;line-height:1.6;">You will receive an email once your application has been approved or if any additional information is needed.</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;vertical-align:top;">
                          <span style="display:inline-block;background:#5A1E12;color:#fff;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-size:12px;font-weight:700;margin-right:12px;">3</span>
                        </td>
                        <td style="padding:8px 0;color:#555;font-size:14px;line-height:1.6;">Once approved, you can start listing your Aboriginal artworks and selling to customers across Australia.</td>
                      </tr>
                    </table>
                  </div>

                  <!-- Application Reference Number -->
                  ${applicationId ? `
                  <div style="background:#F9EDE9;border-radius:8px;padding:18px 22px;border-top:3px solid #C4603A;margin-bottom:24px;text-align:center;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Your Application Reference Number</p>
                    <p style="margin:0;font-size:22px;font-weight:800;color:#5A1E12;font-family:monospace;letter-spacing:2px;">${applicationId}</p>
                    <p style="margin:8px 0 0;color:#7D2E1E;font-size:12px;">Please quote this number when contacting our support team about your application.</p>
                  </div>` : ''}

                  <!-- Review time note -->
                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;">Review Timeline</p>
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">Applications are typically reviewed within <strong>2?3 business days</strong>. If you have any questions in the meantime, please contact our support team.</p>
                  </div>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Thank you for joining Made in Arnhem Land!   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Application submitted email sent to ${email}`);
    return { success: true };
  } catch (error) {
    console.error("? Email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Send Seller Registration / Account Created Email (sent right after OTP is verified)
const sendSellerRegistrationEmail = async (email, name, applicationNumber) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Registration Confirmation");
    console.log("=".repeat(50));
    console.log(`To: ${email}`);
    console.log(`Name: ${name}`);
    console.log(`Application Number: ${applicationNumber}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const msg = {
    to: email,
    from: { email: senderEmail, name: senderName },
    subject: "Your Seller Account Has Been Created ? Made in Arnhem Land",
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;"> Account Created!</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your seller account is ready ? let's get started</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${name}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Welcome to Made in Arnhem Land! Your email has been verified and your seller account has been successfully created. Please keep your application number safe ? you'll need it when contacting our support team.</p>

                  <!-- Application Number Box -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #5A1E12;margin-bottom:24px;text-align:center;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Your Application Number</p>
                    <p style="margin:0;font-size:22px;font-weight:800;color:#5A1E12;font-family:monospace;letter-spacing:2px;">${applicationNumber}</p>
                    <p style="margin:8px 0 0;color:#7D2E1E;font-size:12px;">Please save this number. Quote it when contacting support about your application.</p>
                  </div>

                  <!-- Next steps -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #C4603A;margin-bottom:24px;">
                    <p style="margin:0 0 14px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Complete Your Application</p>
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:8px 0;vertical-align:top;">
                          <span style="display:inline-block;background:#5A1E12;color:#fff;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-size:12px;font-weight:700;margin-right:12px;">1</span>
                        </td>
                        <td style="padding:8px 0;color:#555;font-size:14px;line-height:1.6;">Fill in your <strong>Business Details</strong> (ABN, address, business type).</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;vertical-align:top;">
                          <span style="display:inline-block;background:#5A1E12;color:#fff;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-size:12px;font-weight:700;margin-right:12px;">2</span>
                        </td>
                        <td style="padding:8px 0;color:#555;font-size:14px;line-height:1.6;">Set up your <strong>Store Profile</strong> with a store name, description and logo.</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;vertical-align:top;">
                          <span style="display:inline-block;background:#5A1E12;color:#fff;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-size:12px;font-weight:700;margin-right:12px;">3</span>
                        </td>
                        <td style="padding:8px 0;color:#555;font-size:14px;line-height:1.6;">Upload your <strong>KYC documents</strong> and submit for review.</td>
                      </tr>
                    </table>
                  </div>

                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;"> Tip</p>
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">Applications are typically reviewed within <strong>2?3 business days</strong> after submission. Make sure all your details are complete before submitting.</p>
                  </div>
                </td>
              </tr>
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${process.env.SELLER_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/seller/onboarding" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Continue Your Application</a>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Thank you for joining Made in Arnhem Land!   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Registration confirmation email sent to ${email}`);
    return { success: true };
  } catch (error) {
    console.error("? Email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Send Seller Approved Email
const sendSellerApprovedEmail = async (email, name) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Approved");
    console.log("=".repeat(50));
    console.log(`To: ${email}`);
    console.log(`Name: ${name}`);
    console.log(`Application ID: ${applicationId}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const msg = {
    to: email,
    from: { email: senderEmail, name: senderName },
    subject: "Your Seller Account Has Been Approved ? Made in Arnhem Land",
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;"> You're Approved!</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Welcome to the Made in Arnhem Land seller community</p>
                </td>
              </tr>
              <!-- Approved banner -->
              <tr>
                <td style="background-color:#4CAF50;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Seller Account Approved &amp; Active</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${name}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">We're thrilled to let you know that your seller application has been <strong style="color:#5A1E12;">approved</strong>! You can now log in to your seller dashboard, upload your artworks, and start selling to customers across Australia.</p>

                  <!-- What you can do -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #5A1E12;margin-bottom:24px;">
                    <p style="margin:0 0 16px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Get Started</p>
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#C4603A;font-size:16px;margin-right:10px;"> </span>
                          <span style="color:#555;font-size:14px;">Upload your first artwork listing from the seller dashboard</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#C4603A;font-size:16px;margin-right:10px;"></span>
                          <span style="color:#555;font-size:14px;">Add high-quality photos and detailed descriptions for best results</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#C4603A;font-size:16px;margin-right:10px;"></span>
                          <span style="color:#555;font-size:14px;">Ensure your bank details are saved to receive payments promptly</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#C4603A;font-size:16px;margin-right:10px;"></span>
                          <span style="color:#555;font-size:14px;">Once you have products uploaded, contact us to go fully live</span>
                        </td>
                      </tr>
                    </table>
                  </div>

                  <!-- Important note -->
                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;"> Important</p>
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">Your products will be reviewed by our team before going live to customers. Upload your artworks and our admin will activate your store once everything is in order.</p>
                  </div>
                </td>
              </tr>
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${process.env.SELLER_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/seller/dashboard" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Go to Seller Dashboard</a>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Welcome to the Made in Arnhem Land family!   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Seller approved email sent to ${email}`);
    return { success: true };
  } catch (error) {
    console.error("? Email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Send Seller Low Stock Alert Email
const sendSellerLowStockEmail = async (email, sellerName, productTitle, currentStock, productId) => {
  console.log(`\n[Low Stock Email] Preparing to send to: ${email} | Product: "${productTitle}" | Stock: ${currentStock} | isDevelopmentMode: ${isDevelopmentMode}`);

  if (!email) {
    console.warn(' [Low Stock Email] No email address provided ? skipping send.');
    return { success: false, error: 'No email address' };
  }

  if (isDevelopmentMode) {
    console.log("=".repeat(50));
    console.log("[Low Stock Email] DEVELOPMENT MODE ? Email not sent (SENDGRID_API_KEY missing).");
    console.log(`   To: ${email} | Seller: ${sellerName} | Product: ${productTitle} | Stock: ${currentStock}`);
    console.log("=".repeat(50) + "\n");
    return { success: false, error: 'Development mode ? SendGrid not configured' };
  }

  const stockColor = currentStock === 0 ? "#D32F2F" : "#E65100";
  const stockLabel = currentStock === 0 ? "OUT OF STOCK" : `ONLY ${currentStock} LEFT`;
  const urgencyText = currentStock === 0
    ? "Your product has sold out and has been automatically hidden from the marketplace."
    : `Your product is critically low on stock (${currentStock} remaining) and has been automatically hidden from the marketplace to avoid overselling.`;

  const msg = {
    to: email,
    from: { email: senderEmail, name: senderName },
        subject: `Low Stock Alert: "${productTitle}" ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Stock Alert</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Action Required ?for one of your products</p>
                </td>
              </tr>
              <!-- Alert banner -->
              <tr>
                <td style="background-color:${stockColor};padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:700;letter-spacing:1px;">${stockLabel}</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">${urgencyText}</p>

                  <!-- Product Box -->
                  <div style="background:#FFF3E0;border-radius:8px;padding:22px;border-top:3px solid ${stockColor};margin-bottom:24px;">
                    <p style="margin:0 0 14px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Product Details</p>
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="padding:6px 0;color:#777;font-size:13px;width:140px;">Product Name</td>
                        <td style="padding:6px 0;color:#3D1009;font-size:14px;font-weight:700;">${productTitle}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#777;font-size:13px;">Current Stock</td>
                        <td style="padding:6px 0;font-size:14px;font-weight:700;color:${stockColor};">${currentStock} unit${currentStock === 1 ? '' : 's'}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#777;font-size:13px;">Status</td>
                        <td style="padding:6px 0;font-size:14px;font-weight:700;color:#D32F2F;">Inactive (hidden from marketplace)</td>
                      </tr>
                    </table>
                  </div>

                  <!-- What to do -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #5A1E12;margin-bottom:24px;">
                    <p style="margin:0 0 14px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">What to do next</p>
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:8px 0;vertical-align:top;">
                          <span style="display:inline-block;background:#5A1E12;color:#fff;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-size:12px;font-weight:700;margin-right:12px;">1</span>
                        </td>
                        <td style="padding:8px 0;color:#555;font-size:14px;line-height:1.6;">Log in to your seller dashboard and go to <strong>My Products</strong>.</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;vertical-align:top;">
                          <span style="display:inline-block;background:#5A1E12;color:#fff;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-size:12px;font-weight:700;margin-right:12px;">2</span>
                        </td>
                        <td style="padding:8px 0;color:#555;font-size:14px;line-height:1.6;">Edit the product <strong>"${productTitle}"</strong> and update the stock quantity.</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;vertical-align:top;">
                          <span style="display:inline-block;background:#5A1E12;color:#fff;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-size:12px;font-weight:700;margin-right:12px;">3</span>
                        </td>
                        <td style="padding:8px 0;color:#555;font-size:14px;line-height:1.6;">Your product will be submitted for <strong>admin review</strong> and re-listed once approved.</td>
                      </tr>
                    </table>
                  </div>

                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;">Tip</p>
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">We recommend keeping a stock level of <strong>10 or more units</strong> to avoid interruptions to your sales.</p>
                  </div>
                </td>
              </tr>
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${process.env.SELLER_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/seller/products" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Update Stock Now</a>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Supporting Aboriginal Artists   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Low stock alert email sent to ${email} for product: ${productTitle}`);
    return { success: true };
  } catch (error) {
    console.error("? Low stock email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Send Admin Product Pending Review Email
const sendAdminProductPendingEmail = async (adminEmail, adminName, { productTitle, sellerName, productId } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Admin Product Pending");
    console.log("=".repeat(50));
    console.log(`To: ${adminEmail} | Admin: ${adminName} | Product: ${productTitle} | Seller: ${sellerName}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const dashboardUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/admindashboard/products/${productId || ''}`;

  const msg = {
    to: adminEmail,
    from: { email: senderEmail, name: senderName },
        subject: `Product Pending Review: "${productTitle}" - Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land - Admin</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;"> Product Pending Review</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">A seller has updated a product that requires your approval</p>
                </td>
              </tr>
              <!-- Status banner -->
              <tr>
                <td style="background-color:#E65100;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Awaiting Admin Approval</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${adminName || 'Admin'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">A seller has submitted an updated product that is now <strong style="color:#5A1E12;">pending your review</strong>. Please log in to the admin dashboard to approve or reject the listing.</p>

                  <!-- Product details box -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #5A1E12;margin-bottom:24px;">
                    <p style="margin:0 0 16px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Product Details</p>
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #ECD5CF;">
                          <span style="color:#7D2E1E;font-size:13px;font-weight:700;display:inline-block;width:120px;">Product Title</span>
                          <span style="color:#333;font-size:14px;">${productTitle || 'Untitled'}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#7D2E1E;font-size:13px;font-weight:700;display:inline-block;width:120px;">Seller Name</span>
                          <span style="color:#333;font-size:14px;">${sellerName || 'Unknown'}</span>
                        </td>
                      </tr>
                    </table>
                  </div>

                  <!-- Action note -->
                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;"> Action Required</p>
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">Visit the admin dashboard to review the product images, description, and details ? then approve or reject the listing.</p>
                  </div>
                </td>
              </tr>
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${dashboardUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Review Product</a>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Supporting Aboriginal Artists   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Admin product pending email sent to ${adminEmail} for product: "${productTitle}"`);
    return { success: true };
  } catch (error) {
    console.error("? Admin product pending email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Send Seller Product Approved Email
const sendSellerProductApprovedEmail = async (sellerEmail, sellerName, { productTitle, productId } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Product Approved");
    console.log("=".repeat(50));
    console.log(`To: ${sellerEmail} | Seller: ${sellerName} | Product: ${productTitle}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const productUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/sellerdashboard/products`;

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
        subject: `Product Approved: "${productTitle}" is Now Live - Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;"> Product Approved!</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your artwork is now live on the marketplace</p>
                </td>
              </tr>
              <!-- Approved banner -->
              <tr>
                <td style="background-color:#4CAF50;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Product Approved &amp; Active</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName || 'Seller'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Great news! Your product has been reviewed and <strong style="color:#4CAF50;">approved</strong> by our team. It is now visible to customers on the Made in Arnhem Land.</p>

                  <!-- Product box -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #4CAF50;margin-bottom:24px;">
                    <p style="margin:0 0 12px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Approved Product</p>
                    <p style="margin:0;color:#333;font-size:16px;font-weight:600;">  ${productTitle || 'Your Product'}</p>
                  </div>

                  <!-- What's next -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #5A1E12;margin-bottom:24px;">
                    <p style="margin:0 0 16px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">What's Next?</p>
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#C4603A;font-size:16px;margin-right:10px;"></span>
                          <span style="color:#555;font-size:14px;">Customers can now browse and purchase your artwork</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#C4603A;font-size:16px;margin-right:10px;"></span>
                          <span style="color:#555;font-size:14px;">You'll be notified when an order is placed</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#C4603A;font-size:16px;margin-right:10px;"></span>
                          <span style="color:#555;font-size:14px;">Earnings will be credited after the order is fulfilled</span>
                        </td>
                      </tr>
                    </table>
                  </div>

                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">Keep your stock levels updated so the listing stays active. Products with zero stock are automatically hidden from the marketplace.</p>
                  </div>
                </td>
              </tr>
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${productUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">View My Product</a>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land - Supporting Aboriginal Artists   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`Seller product approved email sent to ${sellerEmail} for product: "${productTitle}"`);
    return { success: true };
  } catch (error) {
    const detail = error.response?.body?.errors?.[0]?.message || error.response?.body || error.message;
    console.error("Seller product approved email error:", detail);
    return { success: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) };
  }
};

// Send Seller Product Rejected Email
const sendSellerProductRejectedEmail = async (sellerEmail, sellerName, { productTitle, reason, productId } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Product Rejected");
    console.log("=".repeat(50));
    console.log(`To: ${sellerEmail} | Seller: ${sellerName} | Product: ${productTitle} | Reason: ${reason}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const dashboardUrl = `${process.env.SELLER_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/seller/products`;

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
        subject: `Product Review: "${productTitle}" Requires Changes - Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Product Review Update</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your product listing requires some changes</p>
                </td>
              </tr>
              <!-- Rejected banner -->
              <tr>
                <td style="background-color:#C62828;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Product Not Approved - Action Required</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName || 'Seller'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Thank you for submitting your product. After reviewing your listing, our team has requested some changes before it can go live on the marketplace. Please review the feedback below and update your listing accordingly.</p>

                  <!-- Product box -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #C62828;margin-bottom:24px;">
                    <p style="margin:0 0 12px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Product Under Review</p>
                    <p style="margin:0;color:#333;font-size:16px;font-weight:600;">  ${productTitle || 'Your Product'}</p>
                  </div>

                  <!-- Reason box -->
                  <div style="background:#FFF3F0;border-radius:8px;padding:22px;border-left:4px solid #C62828;margin-bottom:24px;">
                    <p style="margin:0 0 10px;color:#C62828;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;"> Feedback from Admin</p>
                    <p style="margin:0;color:#333;font-size:15px;line-height:1.7;">${reason || 'No specific reason was provided. Please contact support if you need clarification.'}</p>
                  </div>

                  <!-- What to do next -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #5A1E12;margin-bottom:24px;">
                    <p style="margin:0 0 16px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">How to Resubmit</p>
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#C4603A;font-size:16px;margin-right:10px;">1</span>
                          <span style="color:#555;font-size:14px;">Log in to your seller dashboard</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#C4603A;font-size:16px;margin-right:10px;">2</span>
                          <span style="color:#555;font-size:14px;">Find this product and edit the listing based on the feedback above</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;">
                          <span style="color:#C4603A;font-size:16px;margin-right:10px;">3</span>
                          <span style="color:#555;font-size:14px;">Save your changes ? the product will be resubmitted for review automatically</span>
                        </td>
                      </tr>
                    </table>
                  </div>

                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;"> Need Help?</p>
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">If you have any questions about the feedback or need assistance, please contact our support team. We're here to help you get your artwork listed successfully.</p>
                  </div>
                </td>
              </tr>
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${dashboardUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Edit My Products</a>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Supporting Aboriginal Artists   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Seller product rejected email sent to ${sellerEmail} for product: "${productTitle}"`);
    return { success: true };
  } catch (error) {
    console.error("? Seller product rejected email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Send Seller Category Approved Email --------------------------------------
const sendSellerCategoryApprovedEmail = async (sellerEmail, sellerName, { categoryName, approvalMessage, categoryId } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Category Approved");
    console.log("=".repeat(50));
    console.log(`To: ${sellerEmail} | Seller: ${sellerName} | Category: ${categoryName}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const dashboardUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/sellerdashboard/products`;

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
    subject: `Category Approved: "${categoryName}" - Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;"> Category Approved!</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your category request has been approved</p>
                </td>
              </tr>
              <!-- Approved banner -->
              <tr>
                <td style="background-color:#4CAF50;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Category Approved &amp; Available</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName || 'Seller'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Great news! Your category request has been reviewed and <strong style="color:#4CAF50;">approved</strong> by our team. You can now use this category when listing your products.</p>

                  <!-- Category box -->
                  <div style="background:#E8F5E8;border-radius:8px;padding:22px;border-top:3px solid #4CAF50;margin-bottom:24px;">
                    <p style="margin:0 0 12px;color:#2E7D32;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Approved Category</p>
                    <p style="margin:0;color:#333;font-size:16px;font-weight:600;">${categoryName || 'Your Category'}</p>
                  </div>

                  ${approvalMessage ? `
                  <!-- Admin message -->
                  <div style="background:#F0F7FF;border-radius:8px;padding:22px;border-left:4px solid #1976D2;margin-bottom:24px;">
                    <p style="margin:0 0 10px;color:#1565C0;font-size:13px;font-weight:600;">Admin Message:</p>
                    <p style="margin:0;color:#333;font-size:15px;line-height:1.6;">${approvalMessage}</p>
                  </div>` : ''}

                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">You can now start creating products in this new category. Visit your dashboard to begin listing your items.</p>

                  <p style="text-align:center;margin:32px 0;">
                    <a href="${dashboardUrl}" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;box-shadow:0 4px 15px rgba(90,30,18,0.3);">Go to Dashboard</a>
                  </p>

                  <p style="color:#777;font-size:13px;line-height:1.6;margin:28px 0 0;text-align:center;">? Thank you for being part of the Made in Arnhem Land community! ?</p>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Supporting Aboriginal Artists</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Seller category approved email sent to ${sellerEmail} for category: "${categoryName}"`);
    return { success: true };
  } catch (error) {
    console.error("? Seller category approved email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Send Seller Category Rejected Email --------------------------------------
const sendSellerCategoryRejectedEmail = async (sellerEmail, sellerName, { categoryName, rejectionMessage, categoryId } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Category Rejected");
    console.log("=".repeat(50));
    console.log(`To: ${sellerEmail} | Seller: ${sellerName} | Category: ${categoryName}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const dashboardUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/sellerdashboard`;

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
    subject: `Category Request Update: "${categoryName}" ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Category Request Update</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your category request requires review</p>
                </td>
              </tr>
              <!-- Rejected banner -->
              <tr>
                <td style="background-color:#C62828;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Category Request Not Approved</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName || 'Seller'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Thank you for submitting your category request. After reviewing your submission, our team has provided feedback that needs to be addressed before this category can be approved.</p>

                  <!-- Category box -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #C62828;margin-bottom:24px;">
                    <p style="margin:0 0 12px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Category Under Review</p>
                    <p style="margin:0;color:#333;font-size:16px;font-weight:600;">${categoryName || 'Your Category'}</p>
                  </div>

                  <!-- Reason box -->
                  <div style="background:#FFF3F0;border-radius:8px;padding:22px;border-left:4px solid #C62828;margin-bottom:24px;">
                    <p style="margin:0 0 10px;color:#C62828;font-size:13px;font-weight:600;">Feedback from Admin Team:</p>
                    <p style="margin:0;color:#333;font-size:15px;line-height:1.6;">${rejectionMessage || 'Please review the category requirements and resubmit.'}</p>
                  </div>

                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Based on the feedback above, please review and consider resubmitting your category request with the necessary adjustments. Our goal is to maintain quality and consistency across all categories.</p>

                  <p style="text-align:center;margin:32px 0;">
                    <a href="${dashboardUrl}" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;box-shadow:0 4px 15px rgba(90,30,18,0.3);">Go to Dashboard</a>
                  </p>

                  <p style="color:#777;font-size:13px;line-height:1.6;margin:28px 0 0;text-align:center;">If you have questions about this feedback, please don't hesitate to contact our support team.</p>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Supporting Aboriginal Artists</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Seller category rejected email sent to ${sellerEmail} for category: "${categoryName}"`);
    return { success: true };
  } catch (error) {
    console.error("? Seller category rejected email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Send Super Admin Category Request Email ----------------------------------
const sendSuperAdminCategoryRequestEmail = async (adminEmail, adminName, { categoryName, description, sellerName, categoryId } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Super Admin Category Request");
    console.log("=".repeat(50));
    console.log(`To: ${adminEmail} | Seller: ${sellerName} | Category: ${categoryName}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const adminDashboardUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/admindashboard/categories`;

  const msg = {
    to: adminEmail,
    from: { email: senderEmail, name: senderName },
    subject: `New Category Request: "${categoryName}" ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land Admin</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">New Category Request</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Action required: Review category request</p>
                </td>
              </tr>
              <!-- Alert banner -->
              <tr>
                <td style="background-color:#FF9800;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;">Category Approval Required</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${adminName || 'Admin'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">A seller has submitted a new category request that requires your review and approval.</p>

                  <!-- Request details box -->
                  <div style="background:#F0F7FF;border-radius:8px;padding:22px;border-left:4px solid #1976D2;margin-bottom:24px;">
                    <p style="margin:0 0 16px;color:#1565C0;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Request Details</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Category Name:</strong> ${categoryName || 'Not specified'}</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Requested by:</strong> ${sellerName || 'Unknown Seller'}</p>
                    ${description ? `<p style="margin:0;color:#333;font-size:15px;"><strong>Description:</strong> ${description}</p>` : ''}
                  </div>

                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Please review this request and determine whether to approve or reject it. You can provide feedback to help the seller improve future submissions.</p>

                  <p style="text-align:center;margin:32px 0;">
                    <a href="${adminDashboardUrl}" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;box-shadow:0 4px 15px rgba(90,30,18,0.3);">Review in Admin Dashboard</a>
                  </p>

                  <p style="color:#777;font-size:13px;line-height:1.6;margin:28px 0 0;text-align:center;">Please review this request promptly to maintain our seller satisfaction standards.</p>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land Admin Panel ? Administrative Notifications</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated admin notification. &copy; 2026 Made in Arnhem Land.</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Super admin category request email sent to ${adminEmail} for category: "${categoryName}"`);
    return { success: true };
  } catch (error) {
    console.error("? Super admin category request email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Super Admin New Seller Email ----------------------------------------------------
// Sent to super admins when a new seller submits their application
const sendSuperAdminNewSellerEmail = async (adminEmail, adminName, { sellerName, email, businessName, applicationId } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Super Admin New Seller");
    console.log("=".repeat(50));
    console.log(`To: ${adminEmail} | Seller: ${sellerName} | Business: ${businessName}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const adminDashboardUrl = `${process.env.ADMIN_DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/admindashboard/sellers`;

  const msg = {
    to: adminEmail,
    from: { email: senderEmail, name: senderName },
    subject: `New Seller Application: "${businessName || sellerName}" ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land Admin</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">New Seller Application</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Action required: Review seller application</p>
                </td>
              </tr>
              <!-- Alert banner -->
              <tr>
                <td style="background-color:#FF9800;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;">Seller Application Approval Required</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${adminName || 'Admin'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">A new seller has completed their application and is ready for review and approval.</p>

                  <!-- Application details box -->
                  <div style="background:#F0F7FF;border-radius:8px;padding:22px;border-left:4px solid #1976D2;margin-bottom:24px;">
                    <p style="margin:0 0 16px;color:#1565C0;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Application Details</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Applicant:</strong> ${sellerName || 'Not specified'}</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Email:</strong> ${email || 'Not specified'}</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Application ID:</strong> ${applicationId || 'Not specified'}</p>
                    ${businessName ? `<p style="margin:0;color:#333;font-size:15px;"><strong>Business Name:</strong> ${businessName}</p>` : ''}
                  </div>

                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Please review the application details, including business information, KYC documents, and cultural background to determine approval status. You can provide feedback to help sellers improve future applications.</p>

                  <p style="text-align:center;margin:32px 0;">
                    <a href="${adminDashboardUrl}" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;box-shadow:0 4px 15px rgba(90,30,18,0.3);">Review Application</a>
                  </p>

                  <p style="color:#777;font-size:13px;line-height:1.6;margin:28px 0 0;text-align:center;">Please review this application promptly to maintain our seller onboarding standards.</p>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land Admin Panel ? Administrative Notifications</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated admin notification. &copy; 2026 Made in Arnhem Land.</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Super admin new seller email sent to ${adminEmail} for seller: "${sellerName}"`);
    return { success: true };
  } catch (error) {
    console.error("? Super admin new seller email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Admin New Order Email ----------------------------------------------------
// Sent to every admin when a new order is placed.
// orderDetails: { orderId, customerName, customerEmail, customerPhone?,
//                 sellerNames (string), totalAmount, paymentMethod, items[] }
const sendAdminNewOrderEmail = async (adminEmail, adminName, orderDetails) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Admin New Order Email");
    console.log("=".repeat(50));
    console.log(`To: ${adminEmail}`);
    console.log(`Order: ${orderDetails.displayId}`);
    console.log(`Customer: ${orderDetails.customerName}`);
    console.log(`Sellers: ${orderDetails.sellerNames}`);
    console.log(`Total: $${parseFloat(orderDetails.totalAmount).toFixed(2)}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const productRows = (orderDetails.items || []).map(item => `
    <tr style="border-bottom:1px solid #EDD8CC;">
      <td style="padding:10px 12px;color:#333;font-size:14px;">${item.title || item.product?.title || 'Product'}</td>
      <td style="padding:10px 12px;text-align:center;color:#555;font-size:14px;">${item.quantity}</td>
      <td style="padding:10px 12px;text-align:right;color:#5A1E12;font-size:14px;font-weight:700;">$${(parseFloat(item.price || 0) * (item.quantity || 0)).toFixed(2)}</td>
    </tr>
  `).join('');

  const msg = {
    to: adminEmail,
    from: { email: senderEmail, name: senderName },
    subject: `New Order Placed: #${orderDetails.displayId} ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="650" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Admin Dashboard</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;"> New Order Received</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">A customer has just placed an order</p>
                </td>
              </tr>
              <!-- Greeting -->
              <tr>
                <td style="padding:28px 40px 16px;">
                  <p style="color:#3D1009;font-size:16px;margin:0 0 6px;">Hi <strong>${adminName}</strong>,</p>
                  <p style="color:#555;font-size:14px;line-height:1.7;margin:0;">A new order has been placed on the marketplace. Here are the full details.</p>
                </td>
              </tr>
              <!-- Order meta -->
              <tr>
                <td style="padding:0 40px 20px;">
                  <div style="background:#F9EDE9;border-radius:8px;padding:20px;border-top:3px solid #5A1E12;">
                    <p style="margin:0 0 14px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Order Details</p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order ID</strong></td>
                        <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">#${orderDetails.displayId}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Date</strong></td>
                        <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${new Date().toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' })}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Payment</strong></td>
                        <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${orderDetails.paymentMethod || 'N/A'}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#7D2E1E;font-size:16px;"><strong>Order Total</strong></td>
                        <td style="padding:6px 0;color:#5A1E12;font-size:20px;font-weight:800;text-align:right;">$${parseFloat(orderDetails.totalAmount).toFixed(2)}</td>
                      </tr>
                    </table>
                  </div>
                </td>
              </tr>
              <!-- Customer + Seller info -->
              <tr>
                <td style="padding:0 40px 20px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td width="48%" valign="top" style="padding-right:8px;">
                        <div style="background:#F9EDE9;border-radius:8px;padding:16px;border-top:3px solid #C4603A;">
                          <p style="margin:0 0 10px;color:#5A1E12;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Customer</p>
                          <p style="margin:4px 0;color:#333;font-size:14px;"><strong>${orderDetails.customerName || 'N/A'}</strong></p>
                          <p style="margin:4px 0;color:#555;font-size:13px;">${orderDetails.customerEmail || 'N/A'}</p>
                          ${orderDetails.customerPhone ? `<p style="margin:4px 0;color:#555;font-size:13px;">${orderDetails.customerPhone}</p>` : ''}
                        </div>
                      </td>
                      <td width="4%"></td>
                      <td width="48%" valign="top" style="padding-left:8px;">
                        <div style="background:#F9EDE9;border-radius:8px;padding:16px;border-top:3px solid #5A1E12;">
                          <p style="margin:0 0 10px;color:#5A1E12;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Seller(s)</p>
                          <p style="margin:4px 0;color:#333;font-size:14px;"><strong>${orderDetails.sellerNames || 'N/A'}</strong></p>
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <!-- Items -->
              ${productRows ? `
              <tr>
                <td style="padding:0 40px 20px;">
                  <p style="color:#5A1E12;font-size:15px;font-weight:700;margin:0 0 10px;">Items Ordered</p>
                  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:8px;overflow:hidden;">
                    <thead>
                      <tr style="background-color:#5A1E12;">
                        <th style="padding:11px 12px;text-align:left;color:#fff;font-size:13px;">Product</th>
                        <th style="padding:11px 12px;text-align:center;color:#fff;font-size:13px;">Qty</th>
                        <th style="padding:11px 12px;text-align:right;color:#fff;font-size:13px;">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody>${productRows}</tbody>
                    <tfoot>
                      <tr style="background:#F9EDE9;">
                        <td colspan="2" style="padding:12px;text-align:right;color:#5A1E12;font-size:15px;font-weight:700;">Total:</td>
                        <td style="padding:12px;text-align:right;color:#5A1E12;font-size:18px;font-weight:800;">$${parseFloat(orderDetails.totalAmount).toFixed(2)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </td>
              </tr>` : ''}
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <table width="100%" cellpadding="0" cellspacing="0"><tr>
                    <td style="padding-right:8px;text-align:right;">
                      <a href="${process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/admin/orders/${orderDetails.displayId}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;"> View in Admin Panel</a>
                    </td>
                    <td style="padding-left:8px;text-align:left;">
                      <a href="${process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/admin/orders/${orderDetails.displayId}" style="display:inline-block;background-color:#C4603A;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Download Invoice</a>
                    </td>
                  </tr></table>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Admin Notification</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Admin new order email sent to ${adminEmail} for order ${orderDetails.displayId}`);
    return { success: true };
  } catch (error) {
    console.error("? Admin new order email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Seller Order Status Update Email -----------------------------------------
// Sent to the seller when an admin (or system) updates the status of their order.
// orderDetails: { orderId, status, customerName, totalAmount, reason?, trackingNumber?, estimatedDelivery? }
const sendSellerOrderStatusEmail = async (email, sellerName, orderDetails) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Order Status Update");
    console.log(`To: ${email} | Seller: ${sellerName} | Order: ${orderDetails.displayId} | Status: ${orderDetails.status}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const statusColors = {
    confirmed: '#4CAF50', processing: '#B05E2A', shipped: '#6B4C9A',
    delivered: '#C4963A', cancelled: '#A03020', refund: '#2E7D32', partial_refund: '#6B4C9A'
  };
  const statusLabels = {
    confirmed: 'Confirmed', processing: 'Processing', shipped: 'Shipped',
    delivered: 'Delivered', cancelled: 'Cancelled', refund: 'Refunded', partial_refund: 'Partially Refunded'
  };

  const st = (orderDetails.status || '').toLowerCase();
  const statusColor = statusColors[st] || '#C4603A';
  const statusLabel = statusLabels[st] || (orderDetails.status || '').toUpperCase();
  const baseUrl = process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au';

  const msg = {
    to: email,
    from: { name: senderName, email: senderEmail },
    subject: `Order Status Updated: #${orderDetails.displayId || ''} ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="color-scheme" content="light dark">
        <style>
          ${getPrintSafeCSS()}
        </style>
      </head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;" class="dark-bg">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="620" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <tr><td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:30px 40px;text-align:center;">
                <p style="margin:0 0 6px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Seller Dashboard</p>
                <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Order Status Updated</h1>
              </td></tr>
              <tr><td bgcolor="${statusColor}" style="background-color:${statusColor};padding:14px 40px;text-align:center;">
                <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;">Order #${orderDetails.displayId || ''} is now <strong>${statusLabel}</strong></p>
              </td></tr>
              <tr><td style="padding:28px 40px 20px;">
                <p style="color:#3D1009;font-size:16px;margin:0 0 8px;">Hi <strong>${sellerName}</strong>,</p>
                <p style="color:#666;font-size:14px;line-height:1.7;margin:0;">Admin has updated the status of one of your orders. Please review the details below.</p>
              </td></tr>
              <tr><td style="padding:0 40px 20px;">
                <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-radius:8px;border-top:3px solid #5A1E12;"><tr><td style="padding:20px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order ID</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">#${orderDetails.displayId}</td></tr>
                    <tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Customer</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${orderDetails.customerName || 'N/A'}</td></tr>
                    <tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>New Status</strong></td><td style="padding:6px 0;text-align:right;"><table cellpadding="0" cellspacing="0" align="right"><tr><td bgcolor="${statusColor}" style="background-color:${statusColor};color:#ffffff;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap;-webkit-text-fill-color:#ffffff;">${statusLabel.toUpperCase()}</td></tr></table></td></tr>
                    ${orderDetails.totalAmount ? `<tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order Total</strong></td><td style="padding:6px 0;color:#5A1E12;font-size:14px;font-weight:700;text-align:right;">$${parseFloat(orderDetails.totalAmount).toFixed(2)}</td></tr>` : ''}
                    ${orderDetails.reason ? `<tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Reason</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${orderDetails.reason}</td></tr>` : ''}
                    ${orderDetails.trackingNumber ? `<tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Tracking #</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">${orderDetails.trackingNumber}</td></tr>` : ''}
                  </table>
                </td></tr></table>
              </td></tr>
              <tr><td style="padding:0 40px 36px;text-align:center;">
                <a href="${baseUrl}/seller/orders/${orderDetails.displayId}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">View Order</a>
              </td></tr>
              <tr><td bgcolor="#3D1009" style="background-color:#3D1009;padding:20px 40px;text-align:center;">
                <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body></html>
    `
  };

  try {
    await sgMail.send(msg);
    console.log(`? Seller order status email sent to ${email} for order ${orderDetails.displayId}`);
    return { success: true };
  } catch (error) {
    console.error("? Seller order status email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Admin Order Status Update Email ------------------------------------------
// Sent to all admins when a seller or customer updates an order status.
// orderDetails: { orderId, status, sellerName?, customerName, totalAmount, updatedBy, reason?, trackingNumber? }
const sendAdminOrderStatusEmail = async (adminEmail, adminName, orderDetails) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Admin Order Status Update");
    console.log(`To: ${adminEmail} | Order: ${orderDetails.displayId} | Status: ${orderDetails.status} | By: ${orderDetails.updatedBy}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const statusColors = {
    confirmed: '#4CAF50', processing: '#B05E2A', shipped: '#6B4C9A',
    delivered: '#C4963A', cancelled: '#A03020', refund: '#2E7D32', partial_refund: '#6B4C9A'
  };

  const st = (orderDetails.status || '').toLowerCase();
  const statusColor = statusColors[st] || '#C4603A';
  const updatedBy = orderDetails.updatedBy || 'Seller';
  const baseUrl = process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au';

  const msg = {
    to: adminEmail,
    from: { name: senderName, email: senderEmail },
    subject: `Order Status Updated by ${updatedBy}: #${orderDetails.displayId || ''} ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="color-scheme" content="light dark">
        <style>
          ${getPrintSafeCSS()}
        </style>
      </head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;" class="dark-bg">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="620" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <tr><td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:30px 40px;text-align:center;">
                <p style="margin:0 0 6px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Admin Panel</p>
                <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Order Status Updated</h1>
              </td></tr>
              <tr><td bgcolor="${statusColor}" style="background-color:${statusColor};padding:14px 40px;text-align:center;">
                <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;">Order #${orderDetails.displayId || ''} &rarr; <strong>${st.toUpperCase()}</strong></p>
              </td></tr>
              <tr><td style="padding:28px 40px 20px;">
                <p style="color:#3D1009;font-size:16px;margin:0 0 8px;">Hi <strong>${adminName || 'Admin'}</strong>,</p>
                <p style="color:#666;font-size:14px;line-height:1.7;margin:0;">An order status has been updated by <strong>${updatedBy}${orderDetails.sellerName ? ` (${orderDetails.sellerName})` : ''}</strong>.</p>
              </td></tr>
              <tr><td style="padding:0 40px 20px;">
                <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-radius:8px;border-top:3px solid #5A1E12;"><tr><td style="padding:20px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order ID</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">#${orderDetails.displayId}</td></tr>
                    <tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Updated By</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${updatedBy}${orderDetails.sellerName ? ` &bull; ${orderDetails.sellerName}` : ''}</td></tr>
                    <tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Customer</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${orderDetails.customerName || 'N/A'}</td></tr>
                    <tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>New Status</strong></td><td style="padding:6px 0;text-align:right;"><table cellpadding="0" cellspacing="0" align="right"><tr><td bgcolor="${statusColor}" style="background-color:${statusColor};color:#ffffff;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap;-webkit-text-fill-color:#ffffff;">${st.toUpperCase()}</td></tr></table></td></tr>
                    ${orderDetails.totalAmount ? `<tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order Total</strong></td><td style="padding:6px 0;color:#5A1E12;font-size:14px;font-weight:700;text-align:right;">$${parseFloat(orderDetails.totalAmount).toFixed(2)}</td></tr>` : ''}
                    ${orderDetails.reason ? `<tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Reason</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${orderDetails.reason}</td></tr>` : ''}
                    ${orderDetails.trackingNumber ? `<tr><td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Tracking #</strong></td><td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">${orderDetails.trackingNumber}</td></tr>` : ''}
                  </table>
                </td></tr></table>
              </td></tr>
              <tr><td style="padding:0 40px 36px;text-align:center;">
                <a href="${baseUrl}/admindashboard/orders" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">View Order in Admin Panel</a>
              </td></tr>
              <tr><td bgcolor="#3D1009" style="background-color:#3D1009;padding:20px 40px;text-align:center;">
                <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body></html>
    `
  };

  try {
    await sgMail.send(msg);
    console.log(`? Admin order status email sent to ${adminEmail} for order ${orderDetails.displayId}`);
    return { success: true };
  } catch (error) {
    console.error("? Admin order status email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Seller Product Activated Email ------------------------------------------
// Sent to seller when an admin manually activates their product.
// productDetails: { productTitle, productId }
const sendSellerProductActivatedEmail = async (sellerEmail, sellerName, { productTitle, productId } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Product Activated");
    console.log("=".repeat(50));
    console.log(`To: ${sellerEmail} | Seller: ${sellerName} | Product: ${productTitle}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const productUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/sellerdashboard/products`;

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
    subject: `Great News! Your Product "${productTitle}" Is Now Live ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#F3F8F5;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3F8F5;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(18,90,40,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Product Activated</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your listing is now live on the marketplace</p>
                </td>
              </tr>
              <!-- Activated banner -->
              <tr>
                <td style="background-color:#2E7D32;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Product Activated ? Now Visible to Buyers</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName || 'Seller'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Great news! An admin has manually activated your product listing. It is now live and visible to buyers on the Made in Arnhem Land.</p>
                  <!-- Product box -->
                  <div style="background:#F0FBF2;border-radius:8px;padding:22px;border-top:3px solid #2E7D32;margin-bottom:24px;">
                    <p style="margin:0 0 12px;color:#1B5E20;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Activated Product</p>
                    <p style="margin:0;color:#333;font-size:16px;font-weight:600;">  ${productTitle || 'Your Product'}</p>
                  </div>
                  <div style="background:#F3F8F5;border-left:4px solid #2E7D32;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#1B5E20;font-weight:700;font-size:14px;"> What Happens Now?</p>
                    <p style="margin:0;color:#555;font-size:13px;line-height:1.6;">Your product is now visible to all buyers. Keep your stock levels up to date to avoid automatic deactivation. You can manage your listing from your seller dashboard at any time.</p>
                  </div>
                </td>
              </tr>
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${productUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">View My Product</a>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Supporting Aboriginal Artists   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Seller product activated email sent to ${sellerEmail} for product: "${productTitle}"`);
    return { success: true };
  } catch (error) {
    console.error("? Seller product activated email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Seller Product Deactivated Email ----------------------------------------
// Sent to seller when an admin manually deactivates their product.
// productDetails: { productTitle, reason, productId }
const sendSellerProductDeactivatedEmail = async (sellerEmail, sellerName, { productTitle, reason, productId } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Product Deactivated");
    console.log("=".repeat(50));
    console.log(`To: ${sellerEmail} | Seller: ${sellerName} | Product: ${productTitle} | Reason: ${reason}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const productUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/sellerdashboard/products`;

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
    subject: `Product Deactivated: "${productTitle}" ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Product Deactivated</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your listing has been taken offline by an admin</p>
                </td>
              </tr>
              <!-- Deactivated banner -->
              <tr>
                <td style="background-color:#B71C1C;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;">? Product Deactivated ? No Longer Visible to Buyers</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName || 'Seller'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">We're letting you know that an admin has deactivated your product listing. It is no longer visible to buyers on the marketplace. Please review the information below.</p>
                  <!-- Product box -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #B71C1C;margin-bottom:24px;">
                    <p style="margin:0 0 12px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Deactivated Product</p>
                    <p style="margin:0;color:#333;font-size:16px;font-weight:600;">  ${productTitle || 'Your Product'}</p>
                  </div>
                  ${reason ? `
                  <!-- Reason box -->
                  <div style="background:#FFF3F0;border-radius:8px;padding:22px;border-left:4px solid #B71C1C;margin-bottom:24px;">
                    <p style="margin:0 0 10px;color:#B71C1C;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;"> Reason</p>
                    <p style="margin:0;color:#333;font-size:15px;line-height:1.7;">${reason}</p>
                  </div>
                  ` : ''}
                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;"> What Can You Do?</p>
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">If you believe this was done in error or would like further clarification, please contact our support team. To have your product reinstated, make any required changes and contact support or wait for admin review.</p>
                  </div>
                </td>
              </tr>
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${productUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">View My Products</a>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Supporting Aboriginal Artists   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Seller product deactivated email sent to ${sellerEmail} for product: "${productTitle}"`);
    return { success: true };
  } catch (error) {
    console.error("? Seller product deactivated email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Admin Low-Stock Deactivation Email --------------------------------------
// Sent to every admin when a product is auto-deactivated due to low/zero stock.
// productDetails: { productTitle, sellerName, stock, productId }
const sendAdminLowStockDeactivationEmail = async (adminEmail, adminName, { productTitle, sellerName, stock, productId } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Admin Low Stock Deactivation");
    console.log("=".repeat(50));
    console.log(`To: ${adminEmail} | Admin: ${adminName} | Product: ${productTitle} | Seller: ${sellerName} | Stock: ${stock}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const productUrl = `${process.env.ADMIN_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/admin/products/${productId}`;

  const msg = {
    to: adminEmail,
    from: { email: senderEmail, name: senderName },
    subject: `[Low Stock] Product Auto-Deactivated: "${productTitle}" ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FFF8F0;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FFF8F0;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(180,80,0,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land ? Admin Alert</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Low Stock Auto-Deactivation</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">A product has been automatically taken offline</p>
                </td>
              </tr>
              <!-- Warning banner -->
              <tr>
                <td style="background-color:#E65100;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Auto-Deactivated Due to Low / Zero Stock</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${adminName || 'Admin'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">The automated stock scanner has deactivated a product because its stock has dropped to or below the low-stock threshold. Please review the details below.</p>
                  <!-- Product details box -->
                  <div style="background:#FFF3E0;border-radius:8px;padding:22px;border-top:3px solid #E65100;margin-bottom:24px;">
                    <p style="margin:0 0 16px;color:#BF360C;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Product Details</p>
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="padding:6px 0;color:#777;font-size:13px;width:120px;">Product</td>
                        <td style="padding:6px 0;color:#333;font-size:14px;font-weight:600;">${productTitle || 'N/A'}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#777;font-size:13px;">Seller</td>
                        <td style="padding:6px 0;color:#333;font-size:14px;">${sellerName || 'Unknown'}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#777;font-size:13px;">Stock Left</td>
                        <td style="padding:6px 0;color:#B71C1C;font-size:14px;font-weight:700;">${stock ?? 0} unit(s)</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;color:#777;font-size:13px;">Status</td>
                        <td style="padding:6px 0;color:#B71C1C;font-size:14px;font-weight:600;">INACTIVE (auto-deactivated)</td>
                      </tr>
                    </table>
                  </div>
                  <div style="background:#FFF8F0;border-left:4px solid #E65100;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#BF360C;font-weight:700;font-size:14px;"> Recommended Action</p>
                    <p style="margin:0;color:#555;font-size:13px;line-height:1.6;">Contact the seller to request a stock top-up. Once restocked, you can manually reactivate the product from the admin dashboard, or it will be reactivated automatically when the seller updates their stock.</p>
                  </div>
                </td>
              </tr>
              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${productUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">View Product</a>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Admin Notifications   </p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Admin low-stock deactivation email sent to ${adminEmail} for product: "${productTitle}"`);
    return { success: true };
  } catch (error) {
    console.error("? Admin low-stock deactivation email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Admin: Product Deactivated by Seller ----------------------------------
// Sent to all admins when a seller deactivates their own product.
// details: { productTitle, productId, sellerName, inactiveReason }
const sendAdminProductSellerDeactivatedEmail = async (adminEmail, adminName, { productTitle, productId, sellerName, inactiveReason } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Admin: Seller Deactivated Product");
    console.log("=".repeat(50));
    console.log(`To: ${adminEmail} | Product: ${productTitle} | Seller: ${sellerName} | Reason: ${inactiveReason}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const adminDashboardUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/admindashboard/products`;

  const msg = {
    to: adminEmail,
    from: { email: senderEmail, name: senderName },
    subject: `Product Deactivated by Seller: "${productTitle}" ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land ? Admin</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Product Deactivated by Seller</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">A seller has taken their product offline</p>
                </td>
              </tr>
              <tr>
                <td style="background-color:#B71C1C;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Product Is Now Inactive ? No Longer Visible to Buyers</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${adminName || 'Admin'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Seller <strong>${sellerName || 'Unknown'}</strong> has deactivated one of their product listings. The product is no longer visible to buyers on the marketplace.</p>
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #B71C1C;margin-bottom:24px;">
                    <p style="margin:0 0 12px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Deactivated Product</p>
                    <p style="margin:0 0 6px;color:#333;font-size:16px;font-weight:600;"> ${productTitle || 'Untitled Product'}</p>
                    <p style="margin:0;color:#777;font-size:13px;">Seller: <strong>${sellerName || 'Unknown'}</strong></p>
                  </div>
                  ${inactiveReason ? `
                  <div style="background:#FFF3F0;border-radius:8px;padding:22px;border-left:4px solid #B71C1C;margin-bottom:24px;">
                    <p style="margin:0 0 10px;color:#B71C1C;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;"> Seller's Reason</p>
                    <p style="margin:0;color:#333;font-size:15px;line-height:1.7;">${inactiveReason}</p>
                  </div>
                  ` : ''}
                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">No action is required from you. The seller may submit their product for review when they are ready to reactivate it. You will be notified when that happens.</p>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${adminDashboardUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">View in Admin Dashboard</a>
                </td>
              </tr>
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0;color:#8B5C54;font-size:11px;">&copy; 2026 Made in Arnhem Land. All rights reserved.</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Admin seller-deactivated email sent to ${adminEmail} for product: "${productTitle}"`);
    return { success: true };
  } catch (error) {
    console.error("? Admin seller-deactivated email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Admin: Product Submitted for Review by Seller ---------------------------
// Sent to all admins when a seller submits an inactive/rejected product for review.
// details: { productTitle, productId, sellerName, reviewNote }
const sendAdminProductSubmitReviewEmail = async (adminEmail, adminName, { productTitle, productId, sellerName, reviewNote } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Admin: Product Submit for Review");
    console.log("=".repeat(50));
    console.log(`To: ${adminEmail} | Product: ${productTitle} | Seller: ${sellerName} | Note: ${reviewNote}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const adminDashboardUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/admindashboard/products`;

  const msg = {
    to: adminEmail,
    from: { email: senderEmail, name: senderName },
    subject: `Product Submitted for Review: "${productTitle}" ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land ? Admin</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Product Submitted for Review</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">A seller has requested product re-activation</p>
                </td>
              </tr>
              <tr>
                <td style="background-color:#E65100;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Action Required &mdash; Review &amp; Approve or Reject</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${adminName || 'Admin'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Seller <strong>${sellerName || 'Unknown'}</strong> has submitted a product for admin review. It is currently in <strong>Pending</strong> state and awaiting your approval or rejection.</p>
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #E65100;margin-bottom:24px;">
                    <p style="margin:0 0 12px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Product Details</p>
                    <p style="margin:0 0 6px;color:#333;font-size:16px;font-weight:600;"> ${productTitle || 'Untitled Product'}</p>
                    <p style="margin:0;color:#777;font-size:13px;">Seller: ${sellerName || 'Unknown'}</p>
                  </div>
                  ${reviewNote ? `
                  <div style="background:#FFF8F0;border-radius:8px;padding:22px;border-left:4px solid #E65100;margin-bottom:24px;">
                    <p style="margin:0 0 10px;color:#E65100;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;"> Seller's Note</p>
                    <p style="margin:0;color:#333;font-size:15px;line-height:1.7;">${reviewNote}</p>
                  </div>
                  ` : ''}
                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">Please review this product and either <strong>Approve</strong> it to make it live, or <strong>Reject</strong> it with a reason.</p>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${adminDashboardUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Review in Admin Dashboard</a>
                </td>
              </tr>
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0;color:#8B5C54;font-size:11px;">&copy; 2026 Made in Arnhem Land. All rights reserved.</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Admin product-submit-review email sent to ${adminEmail} for product: "${productTitle}"`);
    return { success: true };
  } catch (error) {
    console.error("? Admin product-submit-review email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Seller: Product Deactivated by Seller ? Confirmation --------------------
// Sent to seller confirming they deactivated their own product.
// details: { productTitle, productId, inactiveReason }
const sendSellerProductSelfDeactivatedEmail = async (sellerEmail, sellerName, { productTitle, productId, inactiveReason } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Self-Deactivated Product");
    console.log("=".repeat(50));
    console.log(`To: ${sellerEmail} | Product: ${productTitle} | Reason: ${inactiveReason}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const dashboardUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/sellerdashboard/products`;

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
    subject: `Your Product Has Been Deactivated: "${productTitle}" ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Product Deactivated</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your product is no longer visible to buyers</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName || 'Seller'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Your product has been deactivated as requested. It is no longer visible to buyers on the marketplace.</p>
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #C4603A;margin-bottom:24px;">
                    <p style="margin:0 0 8px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Deactivated Product</p>
                    <p style="margin:0;color:#333;font-size:16px;font-weight:600;"> ${productTitle || 'Your Product'}</p>
                  </div>
                  ${inactiveReason ? `
                  <div style="background:#FFF8F0;border-radius:8px;padding:22px;border-left:4px solid #C4603A;margin-bottom:24px;">
                    <p style="margin:0 0 8px;color:#C4603A;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Your Reason</p>
                    <p style="margin:0;color:#555;font-size:15px;line-height:1.7;">${inactiveReason}</p>
                  </div>
                  ` : ''}
                  <div style="background:#F9EDE9;border-left:4px solid #5A1E12;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;"> Want to reactivate?</p>
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">When you're ready, go to your product dashboard and click <strong>"Submit for Review"</strong>. An admin will review and activate your product.</p>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${dashboardUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Go to My Products</a>
                </td>
              </tr>
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0;color:#8B5C54;font-size:11px;">&copy; 2026 Made in Arnhem Land. All rights reserved.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Seller self-deactivation email sent to ${sellerEmail} for product: "${productTitle}"`);
    return { success: true };
  } catch (error) {
    console.error("? Seller self-deactivation email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Seller: Submit for Review ? Confirmation ---------------------------------
// Sent to seller confirming their product has been submitted for admin review.
// details: { productTitle, productId, reviewNote }
const sendSellerProductSubmitReviewConfirmEmail = async (sellerEmail, sellerName, { productTitle, productId, reviewNote } = {}) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Product Submit Review Confirmation");
    console.log("=".repeat(50));
    console.log(`To: ${sellerEmail} | Product: ${productTitle}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const dashboardUrl = `${process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/sellerdashboard/products`;
  
  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
    subject: `Product Submitted for Review: "${productTitle}" ? Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Submitted for Review</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your product is awaiting admin approval</p>
                </td>
              </tr>
              <tr>
                <td style="background-color:#2E7D32;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Review Request Submitted Successfully</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName || 'Seller'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Your product has been submitted for admin review. Once approved, it will be live and visible to buyers.</p>
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #5A1E12;margin-bottom:24px;">
                    <p style="margin:0 0 8px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Product Under Review</p>
                    <p style="margin:0;color:#333;font-size:16px;font-weight:600;"> ${productTitle || 'Untitled Product'}</p>
                    <p style="margin:6px 0 0;color:#777;font-size:13px;">Status: <strong>Pending Review</strong></p>
                  </div>
                  ${reviewNote ? `
                  <div style="background:#FFF8F0;border-radius:8px;padding:22px;border-left:4px solid #C4603A;margin-bottom:24px;">
                    <p style="margin:0 0 8px;color:#C4603A;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Your Note to Admin</p>
                    <p style="margin:0;color:#555;font-size:15px;line-height:1.7;">${reviewNote}</p>
                  </div>
                  ` : ''}
                  <div style="background:#F9EDE9;border-left:4px solid #5A1E12;border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">An admin will review your product shortly. You will receive another email once a decision is made.</p>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${dashboardUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Go to My Products</a>
                </td>
              </tr>
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0;color:#8B5C54;font-size:11px;">&copy; 2026 Made in Arnhem Land. All rights reserved.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`? Seller submit-review confirmation email sent to ${sellerEmail} for product: "${productTitle}"`);
    return { success: true };
  } catch (error) {
    console.error("? Seller submit-review confirmation email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Test email configuration
const testEmailConfig = async () => {
  if (!emailConfigured) {
    console.log(" Email not configured");
    return false;
  }
  
  console.log("? SendGrid email service is ready");
  return true;
};

// -- Bank Details Change Request Emails ---------------------------------------

// Sent to SUPER_ADMIN users when a seller submits a bank change request.
// details: { sellerName, storeName, requestId, newBankDetails: { bankName, accountName, bsb, accountNumber } }
const sendSuperAdminBankChangeRequestEmail = async (adminEmail, adminName, details = {}) => {
  const { sellerName, storeName, requestId, newBankDetails = {} } = details;

  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Super Admin Bank Change Request");
    console.log("=".repeat(50));
    console.log(`To: ${adminEmail} | Seller: ${sellerName} | Request: ${requestId}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const adminDashboardUrl = `${process.env.ADMIN_DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au'}/admindashboard/bank-change-requests`;

  const msg = {
    to: adminEmail,
    from: { email: senderEmail, name: senderName },
    subject: `Bank Details Change Request \u2014 ${sellerName || 'A Seller'} \u2014 Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land Admin</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;"> Bank Details Change Request</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Action required: Review and approve or reject</p>
                </td>
              </tr>
              <tr>
                <td style="background-color:#FF9800;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Seller Bank Details Change &mdash; Pending Your Review</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${adminName || 'Admin'}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">A seller has submitted a request to update their bank details. Please review and approve or reject this change.</p>
                  <div style="background:#F0F7FF;border-radius:8px;padding:22px;border-left:4px solid #1976D2;margin-bottom:24px;">
                    <p style="margin:0 0 16px;color:#1565C0;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Request Details</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Seller:</strong> ${sellerName || 'Not specified'}</p>
                    ${storeName ? `<p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Store:</strong> ${storeName}</p>` : ''}
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Request ID:</strong> ${requestId || 'N/A'}</p>
                  </div>
                  <div style="background:#FFF8E1;border-radius:8px;padding:22px;border-left:4px solid #F9A825;margin-bottom:28px;">
                    <p style="margin:0 0 16px;color:#E65100;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Requested New Bank Details</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Bank Name:</strong> ${newBankDetails.bankName || 'N/A'}</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Account Name:</strong> ${newBankDetails.accountName || 'N/A'}</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>BSB:</strong> ${newBankDetails.bsb || 'N/A'}</p>
                    <p style="margin:0;color:#333;font-size:15px;"><strong>Account Number:</strong> ${newBankDetails.accountNumber || 'N/A'}</p>
                  </div>
                  <p style="text-align:center;margin:32px 0;">
                    <a href="${adminDashboardUrl}" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;box-shadow:0 4px 15px rgba(90,30,18,0.3);">Review in Admin Dashboard</a>
                  </p>
                  <p style="color:#777;font-size:13px;line-height:1.6;margin:28px 0 0;text-align:center;">The seller's existing bank details remain unchanged until approved.</p>
                </td>
              </tr>
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land Admin Panel ? Administrative Notifications</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated admin notification. &copy; 2026 Made in Arnhem Land.</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(buildMsg(msg));
    console.log(`? Super admin bank change request email sent to ${adminEmail}`);
    return { success: true };
  } catch (error) {
    console.error("? Super admin bank change request email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Sent to the seller when their bank change request is APPROVED.
// details: { requestId, newBankDetails: { bankName, accountName, bsb, accountNumber } }
const sendSellerBankChangeApprovedEmail = async (sellerEmail, sellerName, details = {}) => {
  const { requestId, newBankDetails = {} } = details;

  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Bank Change Approved");
    console.log("=".repeat(50));
    console.log(`To: ${sellerEmail} | Seller: ${sellerName} | Request: ${requestId}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const dashboardUrl = `${process.env.SELLER_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/seller/settings/bank-details`;

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
    subject: "Your Bank Details Have Been Updated \u2014 Made in Arnhem Land",
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;"> Bank Details Approved</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your bank details have been successfully updated</p>
                </td>
              </tr>
              <tr>
                <td style="background-color:#4CAF50;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Change Request Approved &amp; Applied</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Your bank details change request has been <strong style="color:#2E7D32;">approved</strong> by our admin team. Your account has been updated with the new bank details immediately.</p>
                  <div style="background:#E8F5E9;border-radius:8px;padding:22px;border-left:4px solid #4CAF50;margin-bottom:24px;">
                    <p style="margin:0 0 16px;color:#1B5E20;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Updated Bank Details</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Bank Name:</strong> ${newBankDetails.bankName || 'N/A'}</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>Account Name:</strong> ${newBankDetails.accountName || 'N/A'}</p>
                    <p style="margin:0 0 8px;color:#333;font-size:15px;"><strong>BSB:</strong> ${newBankDetails.bsb || 'N/A'}</p>
                    <p style="margin:0;color:#333;font-size:15px;"><strong>Account Number:</strong> ${newBankDetails.accountNumber || 'N/A'}</p>
                  </div>
                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:28px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;"> What this means</p>
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">All future payouts will be made to your new bank account. If you did not request this change, please contact us immediately.</p>
                  </div>
                  <p style="text-align:center;margin:32px 0;">
                    <a href="${dashboardUrl}" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">View Bank Details</a>
                  </p>
                </td>
              </tr>
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Seller Notifications</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(buildMsg(msg));
    console.log(`? Seller bank change approved email sent to ${sellerEmail}`);
    return { success: true };
  } catch (error) {
    console.error("? Seller bank change approved email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// Sent to the seller when their bank change request is REJECTED.
// details: { requestId, reviewNote }
const sendSellerBankChangeRejectedEmail = async (sellerEmail, sellerName, details = {}) => {
  const { requestId, reviewNote } = details;

  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Bank Change Rejected");
    console.log("=".repeat(50));
    console.log(`To: ${sellerEmail} | Seller: ${sellerName} | Request: ${requestId}`);
    console.log(`Reason: ${reviewNote || 'No reason provided'}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const dashboardUrl = `${process.env.SELLER_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au'}/seller/settings/bank-details`;

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
    subject: "Your Bank Details Change Request Was Not Approved \u2014 Made in Arnhem Land",
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;"> Bank Details Request Not Approved</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Your change request has been reviewed</p>
                </td>
              </tr>
              <tr>
                <td style="background-color:#D32F2F;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;"> Change Request Rejected ? Existing Details Unchanged</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Your bank details change request has been reviewed by our admin team and was <strong style="color:#C62828;">not approved</strong> at this time. Your existing bank details remain unchanged.</p>
                  ${reviewNote ? `
                  <div style="background:#FFF3E0;border-radius:8px;padding:22px;border-left:4px solid #E65100;margin-bottom:24px;">
                    <p style="margin:0 0 10px;color:#BF360C;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Admin Note</p>
                    <p style="margin:0;color:#4E342E;font-size:15px;line-height:1.7;">${reviewNote}</p>
                  </div>` : ''}
                  <div style="background:#F9EDE9;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:28px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-weight:700;font-size:14px;"> What to do next</p>
                    <p style="margin:0;color:#7D2E1E;font-size:13px;line-height:1.6;">Please review the feedback above, correct any issues, and resubmit your bank details change request from your seller dashboard.</p>
                  </div>
                  <p style="text-align:center;margin:32px 0;">
                    <a href="${dashboardUrl}" style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">Go to Bank Details</a>
                  </p>
                </td>
              </tr>
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Made in Arnhem Land ? Seller Notifications</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sgMail.send(buildMsg(msg));
    console.log(`? Seller bank change rejected email sent to ${sellerEmail}`);
    return { success: true };
  } catch (error) {
    console.error("? Seller bank change rejected email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// --- Refund Request Confirmation Email ---------------------------------------
const sendRefundRequestConfirmationEmail = async (email, customerName, refundDetails) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Refund Request Confirmation");
    console.log("=".repeat(50));
    console.log(`To: ${email}`);
    console.log(`Order: ${refundDetails.displayId}`);
    console.log(`Type: ${refundDetails.requestType}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const isFullRefund = refundDetails.requestType === 'REFUND';
  const requestLabel = isFullRefund ? 'Full Refund' : 'Partial Refund';
  const accentColor  = isFullRefund ? '#6B4C9A' : '#C4603A';
  const baseUrl      = process.env.FRONTEND_URL || 'https://madeinarnhemland.com.au';
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au';

  const trackUrl = refundDetails.isGuest
    ? `${baseUrl}/guest/track-order?orderId=${refundDetails.displayId}&email=${encodeURIComponent(email)}`
    : `${dashboardUrl}/customerdashboard/orders`;

  const refundTrackUrl = refundDetails.isGuest
    ? `${baseUrl}/guest/refund`
    : `${dashboardUrl}/customerdashboard/orders`;

  const itemRows = (refundDetails.items || []).map(item => `
    <tr style="border-bottom:1px solid #EDD8CC;">
      <td style="padding:9px 12px;color:#333;font-size:14px;">${item.title || 'Product'}</td>
      <td style="padding:9px 12px;text-align:center;color:#555;font-size:14px;">${item.quantity || 1}</td>
    </tr>
  `).join('');

  const msg = {
    to: email,
    from: { name: senderName, email: senderEmail },
    subject: `${requestLabel} Request Received ? Order #${refundDetails.displayId} | Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          @media screen and (max-width: 640px) {
            .email-container { width: 100% !important; max-width: calc(100% - 20px) !important; }
            .email-body { padding: 20px !important; }
          }
        </style>
      </head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="620" cellpadding="0" cellspacing="0" class="email-container" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);max-width:95%;">

              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:30px 40px;text-align:center;">
                  <p style="margin:0 0 6px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">${requestLabel} Request Received</h1>
                </td>
              </tr>

              <!-- Status banner -->
              <tr>
                <td bgcolor="${accentColor}" style="background-color:${accentColor};padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:14px;font-weight:600;">We have received your request and our team is reviewing it.</p>
                </td>
              </tr>

              <!-- Greeting -->
              <tr>
                <td class="email-body" style="padding:30px 40px 0;">
                  <p style="color:#3D1009;font-size:16px;margin:0 0 6px;">Hi <strong>${customerName}</strong>,</p>
                  <p style="color:#666;font-size:14px;line-height:1.7;margin:0 0 24px;">
                    Thank you for reaching out. Your <strong>${requestLabel.toLowerCase()}</strong> request for order 
                    <strong>#${refundDetails.displayId}</strong> has been successfully submitted and is currently 
                    <strong>under review</strong> by our team.
                  </p>
                </td>
              </tr>

              <!-- Request Summary -->
              <tr>
                <td style="padding:0 40px 24px;">
                  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-radius:8px;border-top:3px solid #5A1E12;">
                    <tr><td style="padding:20px;">
                      <p style="margin:0 0 14px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Request Details</p>
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Request ID</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">${refundDetails.ticketId || '?'}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order ID</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">#${refundDetails.displayId}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Request Type</strong></td>
                          <td style="padding:6px 0;text-align:right;">
                            <table cellpadding="0" cellspacing="0" align="right"><tr>
                              <td bgcolor="${accentColor}" style="background-color:${accentColor};color:#ffffff;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;">${requestLabel.toUpperCase()}</td>
                            </tr></table>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Status</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">Under Review</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Date Submitted</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${new Date().toLocaleDateString('en-AU',{year:'numeric',month:'long',day:'numeric',timeZone:'Australia/Sydney'})}</td>
                        </tr>
                        ${refundDetails.totalAmount ? `
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order Total</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">$${parseFloat(refundDetails.totalAmount).toFixed(2)}</td>
                        </tr>` : ''}
                      </table>
                    </td></tr>
                  </table>
                </td>
              </tr>

              <!-- Reason -->
              <tr>
                <td style="padding:0 40px 24px;">
                  <div style="background:#FFF8F6;border-left:4px solid ${accentColor};border-radius:0 8px 8px 0;padding:16px 20px;">
                    <p style="margin:0 0 6px;color:#5A1E12;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Reason Provided</p>
                    <p style="margin:0;color:#444;font-size:14px;line-height:1.7;">${refundDetails.reason}</p>
                  </div>
                </td>
              </tr>

              ${itemRows ? `
              <!-- Items requested -->
              <tr>
                <td style="padding:0 40px 24px;">
                  <p style="color:#5A1E12;font-size:15px;font-weight:700;margin:0 0 10px;">Items in Request</p>
                  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(90,30,18,0.08);">
                    <thead>
                      <tr style="background-color:#5A1E12;">
                        <th style="padding:10px 12px;text-align:left;color:#fff;font-size:13px;">Product</th>
                        <th style="padding:10px 12px;text-align:center;color:#fff;font-size:13px;">Qty</th>
                      </tr>
                    </thead>
                    <tbody>${itemRows}</tbody>
                  </table>
                </td>
              </tr>` : ''}

              <!-- What happens next -->
              <tr>
                <td style="padding:0 40px 28px;">
                  <div style="background:#F9EDE9;border-radius:8px;padding:20px;border-top:3px solid #C4603A;">
                    <p style="margin:0 0 12px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">What Happens Next?</p>
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="padding:5px 0;color:#555;font-size:14px;line-height:1.6;">
                          <span style="color:${accentColor};font-weight:700;">1.</span>&nbsp; Our team will review your request within <strong>1?3 business days</strong>.
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:5px 0;color:#555;font-size:14px;line-height:1.6;">
                          <span style="color:${accentColor};font-weight:700;">2.</span>&nbsp; You will receive an email update once a decision has been made.
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:5px 0;color:#555;font-size:14px;line-height:1.6;">
                          <span style="color:${accentColor};font-weight:700;">3.</span>&nbsp; If approved, refunds are typically processed within <strong>3?5 business days</strong> to your original payment method.
                        </td>
                      </tr>
                    </table>
                  </div>
                </td>
              </tr>

              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <table width="100%" cellpadding="0" cellspacing="0"><tr>
                    <td style="padding-right:8px;text-align:right;">
                      <a href="${trackUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">View Order</a>
                    </td>
                    <td style="padding-left:8px;text-align:left;">
                      <a href="${refundTrackUrl}" style="display:inline-block;background-color:${accentColor};color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Track Request</a>
                    </td>
                  </tr></table>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">We appreciate your patience and will resolve this as quickly as possible.</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:support@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">support@madeinarnhemland.com.au</a></p>
                </td>
              </tr>

            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `
  };

  try {
    await sgMail.send(buildMsg(msg));
    return { success: true };
  } catch (error) {
    console.error("? Refund request confirmation email error:", error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Refund Status Update Email (Customer) ------------------------------------
// Sent when admin changes refund request status to APPROVED, REJECTED, or COMPLETED.
// refundDetails: { displayId, status, adminMessage?, requestType, totalAmount?, requestedItems?, isGuest? }
const sendRefundStatusUpdateEmail = async (email, customerName, refundDetails) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Refund Status Update (Customer)");
    console.log(`To: ${email} | Order: ${refundDetails.displayId} | Status: ${refundDetails.status}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const st = (refundDetails.status || '').toUpperCase();
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au';
  const baseUrl      = process.env.FRONTEND_URL  || 'https://madeinarnhemland.com.au';
  const trackUrl     = refundDetails.isGuest
    ? `${baseUrl}/guest/track-order?orderId=${refundDetails.displayId}&email=${encodeURIComponent(email)}`
    : `${dashboardUrl}/customerdashboard/orders`;

  const config = {
    APPROVED: {
      icon: '?', color: '#2E7D32', label: 'Approved',
      headline: 'Your Refund Has Been Approved',
      banner: 'Great news ? your refund request has been reviewed and approved.',
      body: `We are pleased to let you know that your refund request for order <strong>#${refundDetails.displayId}</strong> has been <strong>approved</strong> by our team.<br><br>
             Please allow <strong>5?6 business days</strong> for the refunded amount to reflect in your original payment method. Processing times may vary depending on your bank or payment provider.`,
      note: null
    },
    REJECTED: {
      icon: '?', color: '#A03020', label: 'Rejected',
      headline: 'Refund Request Outcome',
      banner: 'Your refund request has been reviewed.',
      body: `We regret to inform you that your refund request for order <strong>#${refundDetails.displayId}</strong> has not been approved at this time.<br><br>
             If you believe this decision was made in error or would like further clarification, please contact our support team.`,
      note: 'If you have questions, please reach out to our customer support team.'
    },
    COMPLETED: {
      icon: '', color: '#1565C0', label: 'Completed',
      headline: 'Refund Payment Completed',
      banner: 'Your refund has been processed and payment issued.',
      body: `Your refund for order <strong>#${refundDetails.displayId}</strong> has been <strong>fully processed</strong> and the payment has been issued.<br><br>
             The refunded amount should appear in your account within <strong>1?3 business days</strong> depending on your bank. If you have not received it after 5 business days, please contact your bank or reach out to us.`,
      note: null
    }
  }[st] || {
    icon: '', color: '#C4603A', label: st,
    headline: 'Refund Request Updated',
    banner: `Your refund request status has been updated to ${st}.`,
    body: `Your refund request for order <strong>#${refundDetails.displayId}</strong> has been updated.`,
    note: null
  };

  const items = refundDetails.requestedItems || refundDetails.items || [];
  const itemRows = items.map(item => `
    <tr style="border-bottom:1px solid #EDD8CC;">
      <td style="padding:9px 12px;color:#333;font-size:14px;">${item.title || 'Product'}</td>
      <td style="padding:9px 12px;text-align:center;color:#555;font-size:14px;">${item.quantity || 1}</td>
    </tr>
  `).join('');

  const requestLabel = refundDetails.requestType === 'REFUND' ? 'Full Refund'
    : refundDetails.requestType === 'PARTIAL_REFUND' ? 'Partial Refund'
    : 'Refund';

  const msg = {
    to: email,
    from: { name: senderName, email: senderEmail },
    subject: `${config.icon} Refund ${config.label} ? Order #${refundDetails.displayId} | Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          ${getPrintSafeCSS()}
          @media screen and (max-width: 640px) {
            .email-container { width: 100% !important; max-width: calc(100% - 20px) !important; }
            .email-body { padding: 20px !important; }
          }
        </style>
      </head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="620" cellpadding="0" cellspacing="0" class="email-container" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);max-width:95%;">

              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:30px 40px;text-align:center;">
                  <p style="margin:0 0 6px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">${config.icon} ${config.headline}</h1>
                </td>
              </tr>

              <tr>
                <td bgcolor="${config.color}" style="background-color:${config.color};padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:14px;font-weight:600;">${config.banner}</p>
                </td>
              </tr>

              <tr>
                <td class="email-body" style="padding:30px 40px 20px;">
                  <p style="color:#3D1009;font-size:16px;margin:0 0 12px;">Hi <strong>${customerName}</strong>,</p>
                  <p style="color:#555;font-size:14px;line-height:1.8;margin:0;">${config.body}</p>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 24px;">
                  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-radius:8px;border-top:3px solid #5A1E12;">
                    <tr><td style="padding:20px;">
                      <p style="margin:0 0 14px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Refund Summary</p>
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order ID</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">#${refundDetails.displayId}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Refund Type</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${requestLabel}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Status</strong></td>
                          <td style="padding:6px 0;text-align:right;">
                            <table cellpadding="0" cellspacing="0" align="right"><tr>
                              <td bgcolor="${config.color}" style="background-color:${config.color};color:#ffffff;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap;">${config.label.toUpperCase()}</td>
                            </tr></table>
                          </td>
                        </tr>
                        ${refundDetails.totalAmount ? `
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order Total</strong></td>
                          <td style="padding:6px 0;color:#5A1E12;font-size:14px;font-weight:700;text-align:right;">$${parseFloat(refundDetails.totalAmount).toFixed(2)}</td>
                        </tr>` : ''}
                        ${refundDetails.adminMessage ? `
                        <tr><td colspan="2" style="padding:10px 0 0;border-top:1px solid #EDD8CC;"></td></tr>
                        <tr>
                          <td colspan="2">
                            <div style="background:#FFF8F6;border-left:4px solid ${config.color};border-radius:0 6px 6px 0;padding:12px 14px;margin-top:4px;">
                              <p style="margin:0 0 4px;color:#5A1E12;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Message from our team</p>
                              <p style="margin:0;color:#444;font-size:14px;line-height:1.7;">${refundDetails.adminMessage}</p>
                            </div>
                          </td>
                        </tr>` : ''}
                      </table>
                    </td></tr>
                  </table>
                </td>
              </tr>

              ${itemRows ? `
              <tr>
                <td style="padding:0 40px 24px;">
                  <p style="color:#5A1E12;font-size:15px;font-weight:700;margin:0 0 10px;">Items in This Refund</p>
                  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(90,30,18,0.08);">
                    <thead>
                      <tr style="background-color:#5A1E12;">
                        <th style="padding:10px 12px;text-align:left;color:#fff;font-size:13px;">Product</th>
                        <th style="padding:10px 12px;text-align:center;color:#fff;font-size:13px;">Qty</th>
                      </tr>
                    </thead>
                    <tbody>${itemRows}</tbody>
                  </table>
                </td>
              </tr>` : ''}

              ${config.note ? `
              <tr>
                <td style="padding:0 40px 24px;">
                  <div style="background:#FFF8F6;border-left:4px solid #C4603A;border-radius:0 8px 8px 0;padding:14px 16px;">
                    <p style="margin:0;color:#555;font-size:14px;line-height:1.7;">${config.note}</p>
                  </div>
                </td>
              </tr>` : ''}

              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${trackUrl}" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:13px 32px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">View My Orders</a>
                </td>
              </tr>

              <tr>
                <td bgcolor="#3D1009" style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Thank you for shopping with Made in Arnhem Land.</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email ? please do not reply. ? 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:support@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">support@madeinarnhemland.com.au</a></p>
                </td>
              </tr>

            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `
  };

  try {
    await sgMail.send(buildMsg(msg));
    return { success: true };
  } catch (error) {
    console.error('? Refund status update (customer) email error:', error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

// -- Refund Status Update Email (Seller) --------------------------------------
// Sent to each seller involved when admin acts on a refund request.
// refundDetails: { displayId, status, adminMessage?, requestType, customerName, totalAmount?, requestedItems? }
const sendSellerRefundStatusEmail = async (email, sellerName, refundDetails) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Refund Status Update (Seller)");
    console.log(`To: ${email} | Seller: ${sellerName} | Order: ${refundDetails.displayId} | Status: ${refundDetails.status}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const st           = (refundDetails.status || '').toUpperCase();
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au';

  const config = {
    APPROVED: {
      icon: '?', color: '#2E7D32', label: 'Approved',
      banner: 'A refund request for one of your orders has been approved.',
      body: `A refund request from customer <strong>${refundDetails.customerName || 'Customer'}</strong> for order <strong>#${refundDetails.displayId}</strong> has been <strong>approved</strong> by admin.<br><br>
             The refund will be processed to the customer's original payment method. This will be reflected in your revenue and commission records.`
    },
    REJECTED: {
      icon: '?', color: '#A03020', label: 'Rejected',
      banner: 'A refund request for one of your orders has been reviewed.',
      body: `The refund request from customer <strong>${refundDetails.customerName || 'Customer'}</strong> for order <strong>#${refundDetails.displayId}</strong> has been <strong>rejected</strong> by admin. No changes will be made to the order or your revenue.`
    },
    COMPLETED: {
      icon: '', color: '#1565C0', label: 'Completed',
      banner: 'A refund payment has been completed for one of your orders.',
      body: `The refund for order <strong>#${refundDetails.displayId}</strong> (customer: <strong>${refundDetails.customerName || 'Customer'}</strong>) has been <strong>fully processed</strong> and payment has been issued.<br><br>
             Your commission and revenue records for this order have been updated accordingly.`
    }
  }[st] || {
    icon: '', color: '#C4603A', label: st,
    banner: `A refund request status has been updated to ${st}.`,
    body: `Refund request status for order <strong>#${refundDetails.displayId}</strong> has been updated to ${st}.`
  };

  const items = refundDetails.requestedItems || refundDetails.items || [];
  const itemNames = items.map(i => i.title || 'Product').filter(Boolean);
  const itemRows = items.map(item => `
    <tr style="border-bottom:1px solid #EDD8CC;">
      <td style="padding:9px 12px;color:#333;font-size:14px;">${item.title || 'Product'}</td>
      <td style="padding:9px 12px;text-align:center;color:#555;font-size:14px;">${item.quantity || 1}</td>
    </tr>
  `).join('');

  const requestLabel = refundDetails.requestType === 'REFUND' ? 'Full Refund'
    : refundDetails.requestType === 'PARTIAL_REFUND' ? 'Partial Refund'
    : 'Refund';

  const subjectItems = itemNames.length
    ? ` (${itemNames.slice(0, 2).join(', ')}${itemNames.length > 2 ? ` +${itemNames.length - 2} more` : ''})`
    : '';

  const msg = {
    to: email,
    from: { name: senderName, email: senderEmail },
    subject: `${config.icon} Refund ${config.label} ? Order #${refundDetails.displayId}${subjectItems} | Made in Arnhem Land`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${getPrintSafeCSS()}</style>
      </head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="620" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);max-width:95%;">

              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:30px 40px;text-align:center;">
                  <p style="margin:0 0 6px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Seller Dashboard</p>
                  <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">${config.icon} Refund Request ${config.label}</h1>
                </td>
              </tr>

              <tr>
                <td bgcolor="${config.color}" style="background-color:${config.color};padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:14px;font-weight:600;">${config.banner}</p>
                </td>
              </tr>

              <tr>
                <td style="padding:30px 40px 20px;">
                  <p style="color:#3D1009;font-size:16px;margin:0 0 12px;">Hi <strong>${sellerName}</strong>,</p>
                  <p style="color:#555;font-size:14px;line-height:1.8;margin:0;">${config.body}</p>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 24px;">
                  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#F9EDE9" style="background-color:#F9EDE9;border-radius:8px;border-top:3px solid #5A1E12;">
                    <tr><td style="padding:20px;">
                      <p style="margin:0 0 14px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Refund Details</p>
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order ID</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;font-family:monospace;">#${refundDetails.displayId}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Customer</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${refundDetails.customerName || 'Customer'}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Refund Type</strong></td>
                          <td style="padding:6px 0;color:#3D1009;font-size:14px;text-align:right;">${requestLabel}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Status</strong></td>
                          <td style="padding:6px 0;text-align:right;">
                            <table cellpadding="0" cellspacing="0" align="right"><tr>
                              <td bgcolor="${config.color}" style="background-color:${config.color};color:#ffffff;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap;">${config.label.toUpperCase()}</td>
                            </tr></table>
                          </td>
                        </tr>
                        ${refundDetails.totalAmount ? `
                        <tr>
                          <td style="padding:6px 0;color:#7D2E1E;font-size:14px;"><strong>Order Total</strong></td>
                          <td style="padding:6px 0;color:#5A1E12;font-size:14px;font-weight:700;text-align:right;">$${parseFloat(refundDetails.totalAmount).toFixed(2)}</td>
                        </tr>` : ''}
                        ${refundDetails.adminMessage ? `
                        <tr><td colspan="2" style="padding:10px 0 0;"></td></tr>
                        <tr>
                          <td colspan="2">
                            <div style="background:#FFF8F6;border-left:4px solid ${config.color};border-radius:0 6px 6px 0;padding:12px 14px;margin-top:4px;">
                              <p style="margin:0 0 4px;color:#5A1E12;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Admin Note</p>
                              <p style="margin:0;color:#444;font-size:14px;line-height:1.7;">${refundDetails.adminMessage}</p>
                            </div>
                          </td>
                        </tr>` : ''}
                      </table>
                    </td></tr>
                  </table>
                </td>
              </tr>

              ${itemRows ? `
              <tr>
                <td style="padding:0 40px 24px;">
                  <p style="color:#5A1E12;font-size:15px;font-weight:700;margin:0 0 10px;">Products in This Refund</p>
                  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(90,30,18,0.08);">
                    <thead>
                      <tr style="background-color:#5A1E12;">
                        <th style="padding:10px 12px;text-align:left;color:#fff;font-size:13px;">Product</th>
                        <th style="padding:10px 12px;text-align:center;color:#fff;font-size:13px;">Qty</th>
                      </tr>
                    </thead>
                    <tbody>${itemRows}</tbody>
                  </table>
                </td>
              </tr>` : ''}

              <tr>
                <td style="padding:0 40px 36px;text-align:center;">
                  <a href="${dashboardUrl}/seller/orders" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:13px 32px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">View in Seller Dashboard</a>
                </td>
              </tr>

              <tr>
                <td bgcolor="#3D1009" style="background-color:#3D1009;padding:22px 40px;text-align:center;">
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email ? please do not reply. ? 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>

            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `
  };

  try {
    await sgMail.send(buildMsg(msg));
    return { success: true };
  } catch (error) {
    console.error('? Refund status update (seller) email error:', error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

const sendMonthlyGstReportEmail = async (email, reportData, csvBase64String) => {
  const { period, executiveSummary, gstBreakdown, topSellers } = reportData;
  const monthName = new Date(period.year, period.month - 1, 1).toLocaleString('default', { month: 'long' });

  const formatCurrency = (val) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(val);

  let htmlContent = `
  <div style="font-family: Arial, sans-sizing; padding: 20px; color: #333; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px;">
    <h2 style="color: #1a56db; text-align: center; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px;">Monthly GST Summary Report</h2>
    <p style="font-size: 16px;"><strong>Period:</strong> ${monthName} ${period.year}</p>
    
    <div style="background-color: #f9fafb; padding: 15px; border-radius: 6px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; color: #374151;">Executive Summary</h3>
      <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
        <tr>
          <td style="padding: 5px 0;"><strong>Total Orders:</strong></td>
          <td style="text-align: right;">${executiveSummary.totalOrders}</td>
        </tr>
        <tr>
          <td style="padding: 5px 0;"><strong>Gross Revenue:</strong></td>
          <td style="text-align: right;">${formatCurrency(executiveSummary.grossRevenue)}</td>
        </tr>
        <tr>
          <td style="padding: 5px 0;"><strong>Net Revenue:</strong></td>
          <td style="text-align: right;">${formatCurrency(executiveSummary.netRevenue)}</td>
        </tr>
        <tr>
          <td style="padding: 5px 0; color: #d32f2f;"><strong>Total GST Collected:</strong></td>
          <td style="text-align: right; color: #d32f2f; font-weight: bold;">${formatCurrency(executiveSummary.gstCollected)}</td>
        </tr>
      </table>
    </div>

    <div style="margin-bottom: 20px;">
      <h3 style="color: #374151;">GST Breakdown</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <thead>
          <tr style="background-color: #f3f4f6; border-bottom: 1px solid #e5e7eb;">
            <th style="padding: 8px; text-align: left;">Rate</th>
            <th style="padding: 8px; text-align: right;">Gross</th>
            <th style="padding: 8px; text-align: right;">Net</th>
            <th style="padding: 8px; text-align: right;">GST</th>
          </tr>
        </thead>
        <tbody>
          ${gstBreakdown.map(b => `
          <tr style="border-bottom: 1px solid #f3f4f6;">
            <td style="padding: 8px;">${b.rate}%</td>
            <td style="padding: 8px; text-align: right;">${formatCurrency(b.grossAmount)}</td>
            <td style="padding: 8px; text-align: right;">${formatCurrency(b.netAmount)}</td>
            <td style="padding: 8px; text-align: right; font-weight: bold; color: #d32f2f;">${formatCurrency(b.gstAmount)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div style="margin-bottom: 20px;">
      <h3 style="color: #374151;">Top 5 Sellers (By GST Collected)</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <thead>
          <tr style="background-color: #f3f4f6; border-bottom: 1px solid #e5e7eb;">
            <th style="padding: 8px; text-align: left;">Seller</th>
            <th style="padding: 8px; text-align: center;">Orders</th>
            <th style="padding: 8px; text-align: right;">GST Collected</th>
          </tr>
        </thead>
        <tbody>
          ${topSellers.slice(0, 5).map(s => `
          <tr style="border-bottom: 1px solid #f3f4f6;">
            <td style="padding: 8px;">${s.sellerName}</td>
            <td style="padding: 8px; text-align: center;">${s.orders}</td>
            <td style="padding: 8px; text-align: right;">${formatCurrency(s.gstCollected)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <p style="font-size: 12px; color: #6b7280; text-align: center; margin-top: 30px;">
      This is an automated report generated by the Alpa Marketplace system on the last day of the month.<br/>
      Please retain this for your GST reconciliation procedures.<br/>
      <strong>Note: A detailed CSV containing all transactions has been attached to this email.</strong>
    </p>
  </div>`;

  const msg = {
    to: email,
    from: `"Alpa Finance" <${process.env.SENDGRID_FROM_EMAIL}>`,
    subject: `Alpa GST Reconciliation Report - ${monthName} ${period.year}`,
    html: htmlContent,
    attachments: [
      {
        content: csvBase64String,
        filename: `Alpa_GST_Report_${monthName}_${period.year}.csv`,
        type: 'text/csv',
        disposition: 'attachment'
      }
    ]
  };

  try {
    if (process.env.NODE_ENV !== 'test') {
      await sgMail.send(msg);
      console.log(`? Monthly GST Report email sent to ${email}`);
    } else {
      console.log(`[TEST] Simulating Monthly GST Report email to ${email}`);
    }
    return { success: true };
  } catch (error) {
    console.error('? GST Report Email error:', error.response?.body || error.message);
    return { success: false, error: error.message };
  }
};

const sendNewsletterCampaignEmail = async ({ toEmail, subject, content, bannerImage, buttonText, buttonLink }) => {
  if (isDevelopmentMode) {
    console.log('\n' + '='.repeat(50));
    console.log('DEVELOPMENT MODE - Newsletter Campaign Email');
    console.log(`To: ${toEmail}`);
    console.log(`Subject: ${subject}`);
    console.log('='.repeat(50) + '\n');
    return { success: true };
  }

  const bannerHtml = bannerImage
    ? `<img src="${bannerImage}" alt="Campaign Banner" style="width:100%;max-width:600px;display:block;margin:0 auto 24px;" />`
    : '';

  const buttonHtml = buttonText && buttonLink
    ? `<div style="text-align:center;margin:24px 0;">
        <a href="${buttonLink}" style="background-color:#5A1E12;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;font-size:15px;display:inline-block;">${buttonText}</a>
       </div>`
    : '';

  const unsubscribeNote = `
    <p style="font-size:12px;color:#999;text-align:center;margin-top:32px;">
      You are receiving this email because you subscribed to our newsletter.<br/>
      If you no longer wish to receive these emails, you can unsubscribe by contacting us.<br/>
      Questions? Email us at <a href="mailto:support@madeinarnhemland.com.au" style="color:#C4603A;">support@madeinarnhemland.com.au</a>
    </p>`;

  const html = `
    <div style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;line-height:1.6;">
      ${bannerHtml}
      <div style="padding:0 16px;">
        <div style="font-size:15px;">${content}</div>
        ${buttonHtml}
        ${unsubscribeNote}
      </div>
    </div>
  `;

  // For bulk campaign sends, prefer SendGrid (HTTP API) over Duo Circle (SMTP).
  // Duo Circle has a hard 5-second socketTimeout that causes failures under background load.
  if (emailConfigured) {
    try {
      await sgMail.send({
        to: toEmail,
        from: { email: senderEmail, name: senderName },
        subject,
        html
      });
      console.log(`? [SendGrid] Newsletter Campaign Email sent to: ${toEmail}`);
      return { success: true };
    } catch (error) {
      console.error(`? [SendGrid] Newsletter Campaign Email failed for ${toEmail}:`, error.response?.body || error.message);
      return { success: false, error: error.response?.body?.errors?.[0]?.message || error.message };
    }
  }

  // Fallback: Duo Circle (use the campaign transporter with longer timeouts)
  if (duoCircleConfigured) {
    try {
      await duoCircleCampaignTransporter.sendMail({
        from: `"${senderName}" <${senderEmail}>`,
        to: toEmail,
        subject,
        html
      });
      console.log(`? [Duo Circle] Newsletter Campaign Email sent to: ${toEmail}`);
      return { success: true };
    } catch (error) {
      console.error(`? [Duo Circle] Newsletter Campaign Email failed for ${toEmail}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'No email service configured' };
};

const sendNewsletterSubscriptionAlertEmail = async ({ subscribedEmail, subscribedAt }) => {
  const adminEmail = process.env.NEWSLETTER_ADMIN_EMAIL || process.env.SUPPORT_EMAIL || senderEmail;

  if (!adminEmail) {
    return { success: false, error: 'No admin email configured for newsletter alerts.' };
  }

  if (isDevelopmentMode) {
    console.log('\n' + '='.repeat(50));
    console.log('DEVELOPMENT MODE - Newsletter Admin Alert');
    console.log(`To: ${adminEmail}`);
    console.log(`Subscriber: ${subscribedEmail}`);
    console.log('='.repeat(50) + '\n');
    return { success: true };
  }

  const subscribedAtText = subscribedAt ? new Date(subscribedAt).toISOString() : new Date().toISOString();
  const msg = {
    to: adminEmail,
    from: {
      email: senderEmail,
      name: senderName
    },
    subject: 'New Newsletter Subscription',
    html: `
      <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
        <h2 style="margin: 0 0 12px; color: #5A1E12;">New Newsletter Subscription</h2>
        <p style="margin: 0 0 8px;">A user subscribed to the newsletter.</p>
        <p style="margin: 0;"><strong>Email:</strong> ${subscribedEmail}</p>
        <p style="margin: 4px 0 0;"><strong>Subscribed At:</strong> ${subscribedAtText}</p>
      </div>
    `
  };

  return sendWithFallback(msg, 'Newsletter Admin Alert');
};

// ─── Seller: Stripe payout transfer sent notification ────────────────────────
// Sent when a Stripe transfer is successfully created for the seller after
// a customer order is paid.
const sendSellerPayoutTransferEmail = async (sellerEmail, sellerName, { orderId, orderDisplayId, amount, currency = 'AUD' } = {}) => {
  if (isDevelopmentMode) {
    console.log('\n' + '='.repeat(50));
    console.log('DEVELOPMENT MODE - Seller Payout Transfer');
    console.log(`To: ${sellerEmail} | Order: ${orderDisplayId} | Amount: ${currency} ${amount}`);
    console.log('='.repeat(50) + '\n');
    return { success: true };
  }

  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au';
  const amountFormatted = `${currency} ${parseFloat(amount).toFixed(2)}`;

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
    subject: `💸 Payment Transferred — Order #${orderDisplayId}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin:0;padding:0;background-color:#F5EDE8;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="center" style="padding:30px 20px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
              <!-- Header -->
              <tr>
                <td style="background-color:#5A1E12;padding:28px 40px;border-radius:12px 12px 0 0;text-align:center;">
                  <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Made in Arnhem Land</h1>
                  <p style="margin:6px 0 0;color:#F0D0C8;font-size:14px;">Payout Transfer Notification</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="background-color:#ffffff;padding:36px 40px;">
                  <p style="margin:0 0 16px;color:#3D1009;font-size:16px;font-weight:700;">Hi ${sellerName},</p>
                  <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.7;">A payment has been transferred to your Stripe account for a completed order.</p>

                  <div style="background:#F0FAF0;border-left:4px solid #2E7D32;border-radius:0 8px 8px 0;padding:20px 24px;margin-bottom:28px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="color:#555;font-size:14px;padding:6px 0;width:50%;">Order Reference</td>
                        <td style="color:#3D1009;font-size:14px;font-weight:700;text-align:right;">#${orderDisplayId}</td>
                      </tr>
                      <tr>
                        <td style="color:#555;font-size:14px;padding:6px 0;">Amount Transferred</td>
                        <td style="color:#2E7D32;font-size:18px;font-weight:700;text-align:right;">${amountFormatted}</td>
                      </tr>
                    </table>
                  </div>

                  <p style="margin:0 0 20px;color:#555;font-size:13px;line-height:1.6;">The funds have been sent to your Stripe Express account. Depending on your payout schedule, they will arrive in your bank account accordingly. You can view full details in your Stripe dashboard.</p>

                  <div style="text-align:center;margin-bottom:28px;">
                    <a href="${dashboardUrl}/sellerdashboard/payouts" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">View My Earnings</a>
                  </div>

                  <p style="margin:0;color:#888;font-size:13px;">Questions about your payout? Email <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;border-radius:0 0 12px 12px;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Thank you for being a valued Made in Arnhem Land seller!</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  return sendWithFallback(msg, 'Seller Payout Transfer Email');
};

// ─── Seller: Stripe onboarding complete / account fully approved ─────────────
// Sent automatically when the connect webhook fires account.updated and
// charges_enabled flips to true for the first time.
const sendSellerStripeApprovedEmail = async (sellerEmail, sellerName) => {
  if (isDevelopmentMode) {
    console.log('\n' + '='.repeat(50));
    console.log('DEVELOPMENT MODE - Seller Stripe Approved');
    console.log(`To: ${sellerEmail} | Name: ${sellerName}`);
    console.log('='.repeat(50) + '\n');
    return { success: true };
  }

  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.madeinarnhemland.com.au';

  const msg = {
    to: sellerEmail,
    from: { email: senderEmail, name: senderName },
    subject: '🎉 Your Stripe Account is Ready — You Can Now Receive Payments!',
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin:0;padding:0;background-color:#F5EDE8;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="center" style="padding:30px 20px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
              <!-- Header -->
              <tr>
                <td style="background-color:#5A1E12;padding:28px 40px;border-radius:12px 12px 0 0;text-align:center;">
                  <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Made in Arnhem Land</h1>
                  <p style="margin:6px 0 0;color:#F0D0C8;font-size:14px;">Seller Payment Account Approved</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="background-color:#ffffff;padding:36px 40px;">
                  <p style="margin:0 0 16px;color:#3D1009;font-size:16px;font-weight:700;">Hi ${sellerName},</p>
                  <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.7;">Great news! Your Stripe payment account has been fully verified and approved. You are now set up to receive payouts directly to your bank account when customers purchase your products.</p>

                  <div style="background:#F9EDE9;border-left:4px solid #5A1E12;border-radius:0 8px 8px 0;padding:20px 24px;margin-bottom:28px;">
                    <p style="margin:0 0 10px;color:#5A1E12;font-weight:700;font-size:14px;">✅ What this means for you</p>
                    <p style="margin:4px 0;color:#7D2E1E;font-size:13px;">• Payments from customers are automatically transferred to your Stripe account</p>
                    <p style="margin:4px 0;color:#7D2E1E;font-size:13px;">• You can view your earnings and transaction history in your Stripe Express dashboard</p>
                    <p style="margin:4px 0;color:#7D2E1E;font-size:13px;">• Payouts to your bank account are managed by the platform</p>
                  </div>

                  <div style="text-align:center;margin-bottom:28px;">
                    <a href="${dashboardUrl}/sellerdashboard/payouts" style="display:inline-block;background-color:#5A1E12;color:#ffffff;padding:14px 40px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">View My Earnings Dashboard</a>
                  </div>

                  <p style="margin:0;color:#888;font-size:13px;line-height:1.6;">If you have any questions about your payments, contact us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color:#3D1009;padding:22px 40px;text-align:center;border-radius:0 0 12px 12px;">
                  <p style="margin:0 0 4px;color:#F0D0C8;font-size:13px;">Welcome to your new earnings journey! 🎨</p>
                  <p style="margin:0;color:#8B5C54;font-size:11px;">This is an automated email &mdash; please do not reply. &copy; 2026 Made in Arnhem Land.</p>
                  <p style="margin:4px 0 0;color:#B8998F;font-size:11px;">Questions? Email us at <a href="mailto:sellers@madeinarnhemland.com.au" style="color:#C4603A;text-decoration:underline;">sellers@madeinarnhemland.com.au</a></p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  };

  return sendWithFallback(msg, 'Seller Stripe Approved Email');
};

const sendDisputeAlertEmail = async ({ adminEmail, adminName, disputeId, amount, currency, reason, orderId, orderDisplayId, chargeId, customerEmail }) => {
  console.log(`[sendDisputeAlertEmail] Dispute ${disputeId} — Order #${orderDisplayId || orderId}`);

  const amountFormatted = amount ? `${currency?.toUpperCase() || 'AUD'} ${(amount / 100).toFixed(2)}` : 'Unknown';
  const orderLink = orderDisplayId ? `#${orderDisplayId}` : (orderId || 'N/A');

  const msg = {
    to: adminEmail,
    from: { email: senderEmail, name: senderName },
    subject: `⚠️ Stripe Dispute Opened — Order ${orderLink}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #c0392b;">Stripe Dispute Opened</h2>
        <p>Hi ${adminName || 'Admin'},</p>
        <p>A Stripe chargeback/dispute has been opened that requires your attention.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; width: 40%;">Order</td><td style="padding: 8px; border: 1px solid #ddd;">${orderLink}</td></tr>
          <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Dispute ID</td><td style="padding: 8px; border: 1px solid #ddd;">${disputeId}</td></tr>
          <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Charge ID</td><td style="padding: 8px; border: 1px solid #ddd;">${chargeId || 'N/A'}</td></tr>
          <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Amount</td><td style="padding: 8px; border: 1px solid #ddd;">${amountFormatted}</td></tr>
          <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Reason</td><td style="padding: 8px; border: 1px solid #ddd;">${reason || 'Not specified'}</td></tr>
          <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Customer Email</td><td style="padding: 8px; border: 1px solid #ddd;">${customerEmail || 'N/A'}</td></tr>
        </table>
        <p>Please log in to the <a href="https://dashboard.stripe.com/disputes/${disputeId}">Stripe Dashboard</a> to respond to this dispute. You typically have 7 days to submit evidence.</p>
        <p style="color: #888; font-size: 12px;">Made in Arnhem Land — Automated Dispute Alert</p>
      </div>
    `
  };

  return sendWithFallback(msg, 'Dispute Alert Email');
};

// Send seller account deactivated email
const sendSellerAccountDeactivatedEmail = async (email, sellerName, reason) => {
  if (isDevelopmentMode) {
    console.log("\n" + "=".repeat(50));
    console.log("DEVELOPMENT MODE - Seller Account Deactivated");
    console.log("=".repeat(50));
    console.log(`To: ${email}`);
    console.log(`Seller Name: ${sellerName}`);
    console.log(`Reason: ${reason || 'No reason provided'}`);
    console.log("=".repeat(50) + "\n");
    return { success: true };
  }

  const msg = {
    to: email,
    from: { email: senderEmail, name: senderName },
    subject: "Account Status Update - Made in Arnhem Land",
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#FDF5F3;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF5F3;padding:30px 0;">
          <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(90,30,18,0.12);">
              <!-- Header -->
              <tr>
                <td style="background:linear-gradient(135deg,#5A1E12 0%,#7D2E1E 100%);padding:36px 40px;text-align:center;">
                  <p style="margin:0 0 8px;font-size:12px;color:#F9EDE9;letter-spacing:3px;text-transform:uppercase;">Made in Arnhem Land</p>
                  <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;">Account Status Update</h1>
                  <p style="margin:10px 0 0;color:#F0D0C8;font-size:14px;">Important notification about your seller account</p>
                </td>
              </tr>
              <!-- Warning banner -->
              <tr>
                <td style="background-color:#FF9800;padding:14px 40px;text-align:center;">
                  <p style="margin:0;color:#ffffff;font-size:15px;font-weight:600;">Account Deactivated</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 28px;">
                  <p style="color:#3D1009;font-size:17px;margin:0 0 10px;">Hi <strong>${sellerName}</strong>,</p>
                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">Your seller account on Made in Arnhem Land has been <strong style="color:#C4603A;">deactivated</strong> by our administration team, effective immediately.</p>

                  <!-- What this means -->
                  <div style="background:#F9EDE9;border-radius:8px;padding:22px;border-top:3px solid #FF9800;margin-bottom:24px;">
                    <p style="margin:0 0 16px;color:#5A1E12;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">What This Means</p>
                    <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 12px;">
                      <strong>You can still:</strong>
                    </p>
                    <ul style="color:#555;font-size:14px;line-height:1.6;margin:0 0 16px;padding-left:20px;">
                      <li>Log in to your account</li>
                      <li>View your products and orders</li>
                      <li>View your payment history</li>
                    </ul>
                    <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 12px;">
                      <strong>You cannot:</strong>
                    </p>
                    <ul style="color:#555;font-size:14px;line-height:1.6;margin:0;padding-left:20px;">
                      <li>Add or edit products</li>
                      <li>Create or manage coupons</li>
                      <li>Request payouts or bank changes</li>
                      <li>Update order status or tracking information</li>
                    </ul>
                  </div>

                  <!-- Reason -->
                  ${reason ? `
                  <div style="background:#fff3cd;border-radius:8px;padding:16px;border-left:4px solid #FF9800;margin-bottom:24px;">
                    <p style="margin:0 0 8px;color:#5A1E12;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Reason</p>
                    <p style="margin:0;color:#555;font-size:14px;line-height:1.6;">${reason}</p>
                  </div>
                  ` : ''}

                  <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 28px;">If you believe this decision was made in error or have questions about your account status, please contact our support team for further assistance.</p>

                  <!-- CTA -->
                  <div style="text-align:center;">
                    <a href="${FRONTEND_URL || 'https://madeinarnhemland.com.au'}/contact-support" style="display:inline-block;background:#5A1E12;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;margin-bottom:24px;">Contact Support</a>
                  </div>

                  <p style="color:#888;font-size:12px;margin:0;text-align:center;">Made in Arnhem Land — Seller Account Management</p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `
  };

  return sendWithFallback(msg, 'Seller Account Deactivated Email');
};

module.exports = { 
  generateOTP,
  sendOTPEmail, 
  testEmailConfig,
  sendOrderConfirmationEmail,
  sendOrderStatusEmail,
  sendSellerOrderNotificationEmail,
  sendAdminNewOrderEmail,
  sendContactFormEmail,
  sendSLAWarningEmail,
  sendSellerApplicationSubmittedEmail,
  sendSellerApprovedEmail,
  sendSellerRegistrationEmail,
  sendSellerLowStockEmail,
  sendAdminProductPendingEmail,
  sendSellerProductApprovedEmail,
  sendSellerProductRejectedEmail,
  sendSellerCategoryApprovedEmail,
  sendSellerCategoryRejectedEmail,
  sendSuperAdminCategoryRequestEmail,
  sendSuperAdminNewSellerEmail,
  sendSellerProductActivatedEmail,
  sendSellerProductDeactivatedEmail,
  sendAdminLowStockDeactivationEmail,
  sendAdminProductSellerDeactivatedEmail,
  sendAdminProductSubmitReviewEmail,
  sendSellerProductSelfDeactivatedEmail,
  sendSellerProductSubmitReviewConfirmEmail,
  sendSellerOrderStatusEmail,
  sendAdminOrderStatusEmail,
  sendSuperAdminBankChangeRequestEmail,
  sendSellerBankChangeApprovedEmail,
  sendSellerBankChangeRejectedEmail,
  sendRefundRequestConfirmationEmail,
  sendRefundStatusUpdateEmail,
  sendSellerRefundStatusEmail,
  sendMonthlyGstReportEmail,
  sendFinanceOrderInvoiceEmail,
  sendNewsletterSubscriptionAlertEmail,
  sendNewsletterCampaignEmail,
  sendDisputeAlertEmail,
  sendSellerStripeApprovedEmail,
  sendSellerPayoutTransferEmail,
  sendSellerAccountDeactivatedEmail
};






