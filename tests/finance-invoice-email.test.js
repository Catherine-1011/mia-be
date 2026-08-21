const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const emailServicePath = path.resolve(__dirname, "../utils/emailService.js");

function loadEmailServiceWithSendGridMock({ financeReceiver } = {}) {
  delete require.cache[emailServicePath];

  const sendCalls = [];
  const originalLoad = Module._load;
  const originalEnv = {
    SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
    DUO_CIRCLE_USER: process.env.DUO_CIRCLE_USER,
    DUO_CIRCLE_PASS: process.env.DUO_CIRCLE_PASS,
    FINANCE_EMAIL_RECEIVER: process.env.FINANCE_EMAIL_RECEIVER,
  };

  process.env.SENDGRID_API_KEY = "test-sendgrid-key";
  delete process.env.DUO_CIRCLE_USER;
  delete process.env.DUO_CIRCLE_PASS;
  if (financeReceiver === undefined) delete process.env.FINANCE_EMAIL_RECEIVER;
  else process.env.FINANCE_EMAIL_RECEIVER = financeReceiver;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "@sendgrid/mail") {
      return {
        setApiKey: () => {},
        send: async (msg) => {
          sendCalls.push(msg);
          return [{ statusCode: 202 }];
        },
      };
    }
    if (request === "nodemailer") {
      return { createTransport: () => ({ sendMail: async () => ({ accepted: [] }) }) };
    }
    return originalLoad.apply(this, arguments);
  };

  const emailService = require(emailServicePath);

  return {
    emailService,
    sendCalls,
    restore() {
      delete require.cache[emailServicePath];
      Module._load = originalLoad;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test("sendFinanceOrderInvoiceEmail sends to the configured FINANCE_EMAIL_RECEIVER with the invoice PDF attached", async () => {
  const { emailService, sendCalls, restore } = loadEmailServiceWithSendGridMock({
    financeReceiver: "alpa.accountsreceivable@alpa.asn.au",
  });
  try {
    const pdfBuffer = Buffer.from("%PDF-1.4 order invoice");

    const result = await emailService.sendFinanceOrderInvoiceEmail(
      { displayId: "ABC123", customerName: "Customer", customerEmail: "customer@example.com", totalAmount: 120, paymentMethod: "STRIPE" },
      pdfBuffer
    );

    assert.equal(result.success, true);
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].to, "alpa.accountsreceivable@alpa.asn.au");
    assert.equal(sendCalls[0].attachments[0].filename, "invoice-ABC123.pdf");
    assert.equal(sendCalls[0].attachments[0].type, "application/pdf");
    assert.equal(sendCalls[0].attachments[0].disposition, "attachment");
    assert.ok(Buffer.from(sendCalls[0].attachments[0].content, "base64").length > 0);
    assert.equal(Buffer.from(sendCalls[0].attachments[0].content, "base64").subarray(0, 5).toString(), "%PDF-");
  } finally {
    restore();
  }
});

test("sendFinanceOrderInvoiceEmail fails safely and does not fall back to a personal/test address when FINANCE_EMAIL_RECEIVER is unset", async () => {
  const { emailService, sendCalls, restore } = loadEmailServiceWithSendGridMock();
  try {
    const result = await emailService.sendFinanceOrderInvoiceEmail(
      { displayId: "ABC123", customerName: "Customer" },
      Buffer.from("%PDF-1.4")
    );

    assert.equal(result.success, false);
    assert.match(result.error, /FINANCE_EMAIL_RECEIVER/);
    assert.equal(sendCalls.length, 0);
  } finally {
    restore();
  }
});

test("sendFinanceOrderInvoiceEmail fails safely when FINANCE_EMAIL_RECEIVER is configured with an invalid address", async () => {
  const { emailService, sendCalls, restore } = loadEmailServiceWithSendGridMock({ financeReceiver: "not-an-email" });
  try {
    const result = await emailService.sendFinanceOrderInvoiceEmail(
      { displayId: "ABC123", customerName: "Customer" },
      Buffer.from("%PDF-1.4")
    );

    assert.equal(result.success, false);
    assert.equal(sendCalls.length, 0);
  } finally {
    restore();
  }
});
