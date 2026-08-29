const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const cloudinaryPath = require.resolve('../config/cloudinary');
const controllerPath = require.resolve('../controllers/upload');
const storageCalls = [];
let storageFailure = null;

require.cache[cloudinaryPath] = {
  id: cloudinaryPath,
  filename: cloudinaryPath,
  loaded: true,
  exports: {
    uploadToCloudinary: async (filePath, folder, contentType) => {
      storageCalls.push({ filePath, folder, contentType, bytes: fs.readFileSync(filePath) });
      if (storageFailure) throw storageFailure;
      return { url: 'https://assets.example/test' };
    }
  }
};
delete require.cache[controllerPath];
const { uploadImage } = require('../controllers/upload');
const { createContainedUploadPath, detectRasterImageType } = require('../utils/uploadSecurity');

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64').subarray(0, 42);

function makeReply() {
  return {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.payload = payload; return this; }
  };
}

function requestFor(bytes, { filename = 'image.jpg', mimetype = 'image/jpeg', ip } = {}) {
  return {
    headers: {},
    ip: ip || `test-${Math.random()}`,
    async *parts() {
      yield { type: 'file', file: Readable.from(bytes), fieldname: 'file', filename, mimetype };
    }
  };
}

test('server-generated paths stay contained and never reuse hostile client names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-path-test-'));
  try {
    const hostileNames = [
      '../evil.jpg', '../../evil.png', '..\\evil.jpg', '/tmp/evil.jpg',
      'C:\\Windows\\evil.jpg', 'nested/path/evil.jpg', 'a'.repeat(5000), 'same.jpg', 'same.jpg'
    ];
    const paths = hostileNames.map(() => createContainedUploadPath(root, 'upload', '.jpg'));
    for (const filepath of paths) {
      const relative = path.relative(path.resolve(root), filepath);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      assert.equal(path.dirname(filepath), path.resolve(root));
      assert.equal(filepath.includes('evil'), false);
    }
    assert.equal(new Set(paths).size, paths.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detects only structurally valid JPEG, PNG, and WEBP fixtures', () => {
  assert.equal(detectRasterImageType(JPEG).mime, 'image/jpeg');
  assert.equal(detectRasterImageType(PNG).mime, 'image/png');
  assert.equal(detectRasterImageType(WEBP).mime, 'image/webp');
  assert.equal(detectRasterImageType(Buffer.from('<svg><script/></svg>')), null);
  assert.equal(detectRasterImageType(Buffer.from('<html>bad</html>')), null);
  assert.equal(detectRasterImageType(Buffer.from('random bytes')), null);
  assert.equal(detectRasterImageType(Buffer.concat([
    Buffer.from([0xff, 0xd8]), Buffer.from('<svg><script/></svg>'), Buffer.from([0xff, 0xd9])
  ])), null);
  assert.equal(detectRasterImageType(Buffer.concat([WEBP, Buffer.from('<script/>')])), null);
});

for (const [name, bytes, extension, mime] of [['JPEG', JPEG, '.jpg', 'image/jpeg'], ['PNG', PNG, '.png', 'image/png'], ['WEBP', WEBP, '.webp', 'image/webp']]) {
  test(`public upload accepts valid ${name}, normalizes storage metadata, and cleans up`, async () => {
    storageCalls.length = 0;
    storageFailure = null;
    const reply = makeReply();
    await uploadImage(requestFor(bytes, { filename: 'client.svg', mimetype: 'image/jpeg' }), reply);
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(reply.payload, { url: 'https://assets.example/test' });
    assert.equal(storageCalls.length, 1);
    assert.equal(path.extname(storageCalls[0].filePath), extension);
    assert.equal(storageCalls[0].folder, 'refund-evidence');
    assert.equal(storageCalls[0].contentType, mime);
    assert.deepEqual(storageCalls[0].bytes, bytes);
    assert.equal(fs.existsSync(storageCalls[0].filePath), false);
  });
}

for (const [name, bytes, filename] of [
  ['SVG with SVG name', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'attack.svg'],
  ['SVG renamed JPEG', Buffer.from('<?xml version="1.0"?><svg/>'), 'photo.jpg'],
  ['HTML renamed PNG', Buffer.from('<html><script/></html>'), 'photo.png'],
  ['random bytes', Buffer.from('not an image'), 'photo.jpg']
]) {
  test(`public upload rejects ${name} before storage`, async () => {
    storageCalls.length = 0;
    const reply = makeReply();
    await uploadImage(requestFor(bytes, { filename, mimetype: 'image/jpeg' }), reply);
    assert.equal(reply.statusCode, 400);
    assert.match(reply.payload.message, /genuine JPEG, PNG, and WEBP/);
    assert.equal(storageCalls.length, 0);
  });
}

test('actual PNG with JPEG metadata is accepted as normalized PNG', async () => {
  storageCalls.length = 0;
  const reply = makeReply();
  await uploadImage(requestFor(PNG, { filename: 'wrong.jpg', mimetype: 'image/jpeg' }), reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(path.extname(storageCalls[0].filePath), '.png');
});

test('oversize upload is rejected before storage', async () => {
  storageCalls.length = 0;
  const reply = makeReply();
  await uploadImage(requestFor(Buffer.alloc(5 * 1024 * 1024 + 1, 0x41)), reply);
  assert.equal(reply.statusCode, 400);
  assert.equal(storageCalls.length, 0);
});

test('storage failure returns the existing error shape and cleans up', async () => {
  storageCalls.length = 0;
  storageFailure = new Error('storage unavailable');
  const reply = makeReply();
  await uploadImage(requestFor(JPEG), reply);
  storageFailure = null;
  assert.equal(reply.statusCode, 400);
  assert.deepEqual(reply.payload, { message: 'Upload failed: Failed to upload image to storage' });
  assert.equal(storageCalls.length, 1);
  assert.equal(fs.existsSync(storageCalls[0].filePath), false);
});
