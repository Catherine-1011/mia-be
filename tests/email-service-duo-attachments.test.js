const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const emailServicePath = path.resolve(__dirname, "../utils/emailService.js");

function loadEmailServiceWithDuoMock() {
  delete require.cache[emailServicePath];

  const sendMailCalls = [];
  const originalLoad = Module._load;
  const originalEnv = {
    DUO_CIRCLE_USER: process.env.DUO_CIRCLE_USER,
    DUO_CIRCLE_PASS: process.env.DUO_CIRCLE_PASS,
    SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
    NODE_ENV: process.env.NODE_ENV,
  };

  process.env.DUO_CIRCLE_USER = "duo-user";
  process.env.DUO_CIRCLE_PASS = "duo-pass";
  delete process.env.SENDGRID_API_KEY;
  process.env.NODE_ENV = "test";

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "nodemailer") {
      return {
        createTransport: () => ({
          sendMail: async (mailOptions) => {
            sendMailCalls.push(mailOptions);
            return { accepted: [mailOptions.to] };
          },
        }),
      };
    }
    if (request === "@sendgrid/mail") {
      return {
        setApiKey: () => {},
        send: async () => {
          throw new Error("SendGrid should not be called when Duo Circle succeeds");
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  const emailService = require(emailServicePath);

  return {
    emailService,
    sendMailCalls,
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

test("sendSellerPaymentReceivedEmail passes invoice attachment through Duo Circle SMTP", async () => {
  const { emailService, sendMailCalls, restore } = loadEmailServiceWithDuoMock();
  try {
    const pdfBuffer = Buffer.from("%PDF-1.4 seller invoice");

    const result = await emailService.sendSellerPaymentReceivedEmail("seller@example.com", "Seller", {
      orderId: "order_1",
      orderDisplayId: "ABC123",
      amount: 125.5,
      currency: "AUD",
      invoicePDFBuffer: pdfBuffer,
      invoiceFilename: "Invoice-ABC123-Seller.pdf",
    });

    assert.equal(result.success, true);
    assert.equal(sendMailCalls.length, 1);
    assert.deepEqual(sendMailCalls[0].attachments, [
      {
        content: pdfBuffer.toString("base64"),
        filename: "Invoice-ABC123-Seller.pdf",
        type: "application/pdf",
        disposition: "attachment",
      },
    ]);
  } finally {
    restore();
  }
});

test("sendSellerPaymentReceivedEmail sends without attachments when no invoice buffer exists", async () => {
  const { emailService, sendMailCalls, restore } = loadEmailServiceWithDuoMock();
  try {
    const result = await emailService.sendSellerPaymentReceivedEmail("seller@example.com", "Seller", {
      orderId: "order_1",
      orderDisplayId: "ABC123",
      amount: 125.5,
      currency: "AUD",
    });

    assert.equal(result.success, true);
    assert.equal(sendMailCalls.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(sendMailCalls[0], "attachments"), false);
  } finally {
    restore();
  }
});

