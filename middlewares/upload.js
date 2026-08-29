const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { createContainedUploadPath, extensionForMime, sanitizeOriginalFilename } = require('../utils/uploadSecurity');

// Ensure upload directories exist
const uploadDir = 'uploads';
const sellerDocsDir = path.join(uploadDir, 'seller-docs');
const productsDir = path.join(uploadDir, 'products');

[uploadDir, sellerDocsDir, productsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Allowed file types
const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

// Max file sizes
const MAX_DOCUMENT_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_IMAGE_SIZE = 3 * 1024 * 1024; // 3MB

// Fastify multipart handler for seller documents
const handleSellerDocsUpload = async (request, reply) => {
  const files = [];
  try {
    const parts = request.parts();
    const fields = {};

    for await (const part of parts) {
      if (part.file) {
        // Validate file type
        if (!ALLOWED_DOCUMENT_TYPES.includes(part.mimetype)) {
          throw new Error('Only PDF, JPEG, JPG, and PNG files are allowed');
        }

        // Generate unique filename
        const filepath = createContainedUploadPath(sellerDocsDir, part.fieldname, extensionForMime(part.mimetype));
        const filename = path.basename(filepath);

        // Save file
        try {
          await pipeline(part.file, fs.createWriteStream(filepath, { flags: 'wx' }));
        } catch (error) {
          await fs.promises.unlink(filepath).catch(() => {});
          throw error;
        }

        files.push({
          fieldname: part.fieldname,
          originalname: sanitizeOriginalFilename(part.filename),
          filename: filename,
          path: filepath,
          mimetype: part.mimetype,
          size: fs.statSync(filepath).size
        });

        // Check file size
        if (files[files.length - 1].size > MAX_DOCUMENT_SIZE) {
          fs.unlinkSync(filepath);
          throw new Error(`File ${part.filename} exceeds 5MB limit`);
        }
      } else {
        // Handle regular form fields
        fields[part.fieldname] = part.value;
      }
    }

    // Attach files and fields to request
    request.files = files;
    request.body = fields;
  } catch (error) {
    await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
    reply.status(400).send({ success: false, message: error.message });
    throw error;
  }
};

// Fastify multipart handler for product images
const handleProductImagesUpload = async (request, reply) => {
  const files = [];
  try {
    const parts = request.parts();
    const fields = {};

    for await (const part of parts) {
      if (part.file) {
        // Validate file type
        if (!ALLOWED_IMAGE_TYPES.includes(part.mimetype)) {
          throw new Error('Only image files (JPEG, JPG, PNG, WEBP) are allowed');
        }

        // Generate unique filename
        const filepath = createContainedUploadPath(productsDir, 'product', extensionForMime(part.mimetype));
        const filename = path.basename(filepath);

        // Save file
        try {
          await pipeline(part.file, fs.createWriteStream(filepath, { flags: 'wx' }));
        } catch (error) {
          await fs.promises.unlink(filepath).catch(() => {});
          throw error;
        }

        files.push({
          fieldname: part.fieldname,
          originalname: sanitizeOriginalFilename(part.filename),
          filename: filename,
          path: filepath,
          mimetype: part.mimetype,
          size: fs.statSync(filepath).size
        });

        // Check file size
        if (files[files.length - 1].size > MAX_IMAGE_SIZE) {
          fs.unlinkSync(filepath);
          throw new Error(`File ${part.filename} exceeds 3MB limit`);
        }
      } else {
        // Handle regular form fields - accumulate repeated keys as arrays
        // so sending galleryImages multiple times results in an array
        if (fields[part.fieldname] !== undefined) {
          if (Array.isArray(fields[part.fieldname])) {
            fields[part.fieldname].push(part.value);
          } else {
            fields[part.fieldname] = [fields[part.fieldname], part.value];
          }
        } else {
          fields[part.fieldname] = part.value;
        }
      }
    }

    // Attach files and fields to request
    request.files = files;
    request.body = fields;
  } catch (error) {
    await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
    reply.status(400).send({ success: false, message: error.message });
    throw error;
  }
};

// Fastify multipart handler for blog cover image
const handleBlogImageUpload = async (request, reply) => {
  const files = [];
  try {
    const contentType = request.headers['content-type'] || '';
    // If not multipart, body is already parsed (raw JSON) — skip
    if (!contentType.includes('multipart/form-data')) return;

    const parts = request.parts();
    const fields = {};

    for await (const part of parts) {
      if (part.file) {
        if (!ALLOWED_IMAGE_TYPES.includes(part.mimetype)) {
          throw new Error('Only image files (JPEG, JPG, PNG, WEBP) are allowed');
        }

        const filepath = createContainedUploadPath(productsDir, 'blog', extensionForMime(part.mimetype));
        const filename = path.basename(filepath);

        try {
          await pipeline(part.file, fs.createWriteStream(filepath, { flags: 'wx' }));
        } catch (error) {
          await fs.promises.unlink(filepath).catch(() => {});
          throw error;
        }

        const fileSize = fs.statSync(filepath).size;
        if (fileSize > MAX_IMAGE_SIZE) {
          fs.unlinkSync(filepath);
          throw new Error(`File ${part.filename} exceeds 3MB limit`);
        }

        files.push({
          fieldname: part.fieldname,
          originalname: sanitizeOriginalFilename(part.filename),
          filename,
          path: filepath,
          mimetype: part.mimetype,
          size: fileSize
        });
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    request.files = files;
    request.body = fields;
  } catch (error) {
    await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
    reply.status(400).send({ success: false, message: error.message });
    throw error;
  }
};

module.exports = {
  handleSellerDocsUpload,
  handleProductImagesUpload,
  handleBlogImageUpload
};






