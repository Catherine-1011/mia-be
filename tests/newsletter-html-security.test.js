const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const { sanitizeNewsletterHtml } = require('../utils/newsletterHtml');

test('newsletter sanitizer removes active HTML, handlers, unsafe URLs, and unsafe CSS', () => {
  const unsafe = [
    '<script>alert(1)</script>',
    '<img src="https://images.example/x.png" onerror="alert(1)">',
    '<svg onload="alert(1)"></svg>',
    '<a href="javascript:alert(1)">click</a>',
    '<a href="JaVaScRiPt&#58;alert(1)">encoded</a>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<object data="javascript:alert(1)"></object>',
    '<div onclick="alert(1)">x</div>',
    '<div style="background-image:url(javascript:alert(1));width:100%">x</div>',
    '<div style="width:expression(alert(1));color:#123456">x</div>'
  ].join('');
  const sanitized = sanitizeNewsletterHtml(unsafe);

  assert.doesNotMatch(sanitized, /<(?:script|svg|iframe|object)\b/i);
  assert.doesNotMatch(sanitized, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(sanitized, /javascript\s*(?::|&#)/i);
  assert.doesNotMatch(sanitized, /(?:expression|background-image|url\s*\()/i);
  assert.match(sanitized, /<img src="https:\/\/images\.example\/x\.png" \/>/);
  assert.match(sanitized, /<div style="width:100%">x<\/div>/);
  assert.match(sanitized, /<div style="color:#123456">x<\/div>/);
});

test('newsletter sanitizer preserves supported email formatting', () => {
  const legitimate = [
    '<h1 style="color:#5A1E12;text-align:center">News</h1>',
    '<p><strong>Bold</strong> and <em>italic</em><br />copy</p>',
    '<a href="https://example.com/path" target="_blank">Web</a>',
    '<a href="mailto:team@example.com">Email</a><a href="tel:+61123456789">Call</a>',
    '<img src="https://images.example/banner.jpg" alt="Banner" width="600" height="200">',
    '<table width="100%" cellpadding="8" cellspacing="0" border="0" style="border-collapse:collapse">',
    '<tbody><tr bgcolor="#ffffff"><td align="center" valign="middle">Cell</td></tr></tbody></table>',
    '<ul><li><u>Item</u></li></ul><blockquote>Quote</blockquote>'
  ].join('');
  const sanitized = sanitizeNewsletterHtml(legitimate);

  for (const expected of ['<h1', '<strong>', '<em>', '<br />', 'https://example.com/path',
    'mailto:team@example.com', 'tel:+61123456789', '<img', '<table', 'cellpadding="8"',
    'border-collapse:collapse', '<ul>', '<blockquote>']) {
    assert.ok(sanitized.includes(expected), `expected sanitized HTML to preserve ${expected}`);
  }
  assert.match(sanitized, /rel="noopener noreferrer"/);
});

function loadEmailServiceWithSendGridMock() {
  const emailServicePath = path.resolve(__dirname, '../utils/emailService.js');
  delete require.cache[emailServicePath];
  const sendCalls = [];
  const originalLoad = Module._load;
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
    DUO_CIRCLE_USER: process.env.DUO_CIRCLE_USER,
    DUO_CIRCLE_PASS: process.env.DUO_CIRCLE_PASS
  };
  process.env.NODE_ENV = 'production';
  process.env.SENDGRID_API_KEY = 'test-sendgrid-key';
  delete process.env.DUO_CIRCLE_USER;
  delete process.env.DUO_CIRCLE_PASS;

  Module._load = function patchedLoad(request) {
    if (request === '@sendgrid/mail') return {
      setApiKey: () => {},
      send: async (msg) => { sendCalls.push(msg); return [{ statusCode: 202 }]; }
    };
    if (request === 'nodemailer') return {
      createTransport: () => ({ sendMail: async () => ({ accepted: [] }) })
    };
    return originalLoad.apply(this, arguments);
  };
  const emailService = require(emailServicePath);

  return { emailService, sendCalls, restore() {
    delete require.cache[emailServicePath];
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  } };
}

test('newsletter send sanitizes historical unsafe content and wrapper values before SendGrid', async () => {
  const { emailService, sendCalls, restore } = loadEmailServiceWithSendGridMock();
  try {
    const result = await emailService.sendNewsletterCampaignEmail({
      toEmail: 'recipient@example.com',
      subject: 'Newsletter',
      content: '<h2 style="text-align:center">Hello</h2><img src="https://images.example/x.png" onerror="alert(1)"><script>alert(1)</script>',
      bannerImage: 'x" onerror="alert(1)',
      buttonText: '<img src=x onerror=alert(1)>Read',
      buttonLink: 'javascript:alert(1)'
    });
    assert.equal(result.success, true);
    assert.equal(sendCalls.length, 1);
    assert.match(sendCalls[0].html, /<h2 style="text-align:center">Hello<\/h2>/);
    assert.doesNotMatch(sendCalls[0].html, /<script|onerror|javascript:/i);
  } finally { restore(); }
});

test('campaign create and update store canonical sanitized content', async () => {
  const controllerPath = path.resolve(__dirname, '../controllers/newsletterCampaign.js');
  delete require.cache[controllerPath];
  const originalLoad = Module._load;
  const writes = [];
  const stored = {
    id: 'campaign-1',
    status: 'DRAFT',
    subject: 'Subject',
    content: '<img src="https://images.example/x.png" onerror="alert(1)"><script>alert(1)</script>'
  };
  const prisma = { newsletterCampaign: {
    findUnique: async () => stored,
    create: async ({ data }) => { writes.push(data); return { id: 'campaign-1', ...data }; },
    update: async ({ data }) => { writes.push(data); return { ...stored, ...data }; }
  } };
  Module._load = function patchedLoad(request) {
    if (request === '@prisma/client') return { PrismaClient: function PrismaClient() { return prisma; } };
    if (request === '../config/cloudinary') return { uploadToCloudinary: async () => ({ url: '' }) };
    if (request === '../utils/emailService') return { sendNewsletterCampaignEmail: async () => ({ success: true }) };
    return originalLoad.apply(this, arguments);
  };
  const controller = require(controllerPath);
  const reply = () => ({ statusCode: 0, status(code) { this.statusCode = code; return this; }, send(value) { return value; } });
  const unsafe = '<p style="text-align:center" onclick="alert(1)">Hello</p><script>alert(1)</script>';
  try {
    const createReply = reply();
    await controller.createCampaign({ isMultipart: () => false, body: { subject: 'Subject', content: unsafe } }, createReply);
    assert.equal(createReply.statusCode, 201);
    const updateReply = reply();
    await controller.updateCampaign({ isMultipart: () => false, params: { id: 'campaign-1' }, body: { content: unsafe } }, updateReply);
    assert.equal(updateReply.statusCode, 200);
    assert.equal(writes.length, 2);
    for (const write of writes) assert.equal(write.content, '<p style="text-align:center">Hello</p>');

    const partialReply = reply();
    const partialResponse = await controller.updateCampaign({
      isMultipart: () => false,
      params: { id: 'campaign-1' },
      body: { buttonText: 'Read more' }
    }, partialReply);
    assert.equal(partialReply.statusCode, 200);
    assert.doesNotMatch(partialResponse.data.content, /onerror|<script/i);
  } finally {
    delete require.cache[controllerPath];
    Module._load = originalLoad;
  }
});
