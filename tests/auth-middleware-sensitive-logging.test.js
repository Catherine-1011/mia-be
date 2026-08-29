const test = require("node:test");
const assert = require("node:assert/strict");

const jwt = require("jsonwebtoken");
const authMiddleware = require("../middlewares/auth");

function createReply() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function captureConsoleLogs() {
  const entries = [];
  const originalLog = console.log;
  console.log = (...args) => entries.push(args);
  return {
    entries,
    restore() {
      console.log = originalLog;
    },
  };
}

test("auth middleware verifies bearer token without logging credentials", async () => {
  const token = "sensitive-bearer-token";
  const secret = "sensitive-jwt-secret";
  const originalVerify = jwt.verify;
  const originalSecret = process.env.JWT_SECRET;
  const logs = captureConsoleLogs();
  let receivedToken;
  let receivedSecret;

  jwt.verify = (candidateToken, candidateSecret) => {
    receivedToken = candidateToken;
    receivedSecret = candidateSecret;
    return { userId: "user_1", role: "USER" };
  };
  process.env.JWT_SECRET = secret;

  try {
    const request = { headers: { authorization: `Bearer ${token}` } };
    const reply = createReply();

    await authMiddleware(request, reply);

    assert.equal(receivedToken, token);
    assert.equal(receivedSecret, secret);
    assert.deepEqual(request.user, { userId: "user_1", role: "USER" });
    assert.equal(reply.statusCode, null);

    const output = logs.entries.flat().map(String).join(" ");
    assert.equal(output.includes(token), false);
    assert.equal(output.includes(secret), false);
  } finally {
    jwt.verify = originalVerify;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    logs.restore();
  }
});

test("auth middleware preserves invalid and missing token responses without logging credentials", async () => {
  const token = "invalid-sensitive-bearer-token";
  const secret = "sensitive-jwt-secret";
  const originalVerify = jwt.verify;
  const originalSecret = process.env.JWT_SECRET;
  const logs = captureConsoleLogs();

  jwt.verify = () => {
    throw new Error("invalid token");
  };
  process.env.JWT_SECRET = secret;

  try {
    const invalidReply = createReply();
    await authMiddleware(
      { headers: { authorization: `Bearer ${token}` } },
      invalidReply
    );
    assert.equal(invalidReply.statusCode, 401);
    assert.deepEqual(invalidReply.payload, {
      success: false,
      message: "Invalid or expired token",
    });

    const missingReply = createReply();
    await authMiddleware({ headers: {} }, missingReply);
    assert.equal(missingReply.statusCode, 401);
    assert.deepEqual(missingReply.payload, {
      success: false,
      message: "No token provided",
    });

    const output = logs.entries.flat().map(String).join(" ");
    assert.equal(output.includes(token), false);
    assert.equal(output.includes(secret), false);
  } finally {
    jwt.verify = originalVerify;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    logs.restore();
  }
});
