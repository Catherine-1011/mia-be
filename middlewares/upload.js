const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');

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
  try {
    const parts = request.parts();
    const files = [];
    const fields = {};

    for await (const part of parts) {
      if (part.file) {
        // Validate file type
        if (!ALLOWED_DOCUMENT_TYPES.includes(part.mimetype)) {
          throw new Error('Only PDF, JPEG, JPG, and PNG files are allowed');
        }

        // Generate unique filename
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(part.filename);
        const filename = `${part.fieldname}-${uniqueSuffix}${ext}`;
        const filepath = path.join(sellerDocsDir, filename);

        // Save file
        await pipeline(part.file, fs.createWriteStream(filepath));

        files.push({
          fieldname: part.fieldname,
          originalname: part.filename,
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
    reply.status(400).send({ success: false, message: error.message });
    throw error;
  }
};

// Fastify multipart handler for product images
const handleProductImagesUpload = async (request, reply) => {
  try {
    const parts = request.parts();
    const files = [];
    const fields = {};

    for await (const part of parts) {
      if (part.file) {
        // Validate file type
        if (!ALLOWED_IMAGE_TYPES.includes(part.mimetype)) {
          throw new Error('Only image files (JPEG, JPG, PNG, WEBP) are allowed');
        }

        // Generate unique filename
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(part.filename);
        const filename = `product-${uniqueSuffix}${ext}`;
        const filepath = path.join(productsDir, filename);

        // Save file
        await pipeline(part.file, fs.createWriteStream(filepath));

        files.push({
          fieldname: part.fieldname,
          originalname: part.filename,
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
    reply.status(400).send({ success: false, message: error.message });
    throw error;
  }
};

// Fastify multipart handler for blog cover image
const handleBlogImageUpload = async (request, reply) => {
  try {
    const contentType = request.headers['content-type'] || '';
    // If not multipart, body is already parsed (raw JSON) — skip
    if (!contentType.includes('multipart/form-data')) return;

    const parts = request.parts();
    const files = [];
    const fields = {};

    for await (const part of parts) {
      if (part.file) {
        if (!ALLOWED_IMAGE_TYPES.includes(part.mimetype)) {
          throw new Error('Only image files (JPEG, JPG, PNG, WEBP) are allowed');
        }

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(part.filename);
        const filename = `blog-${uniqueSuffix}${ext}`;
        const filepath = path.join(productsDir, filename); // reuse existing uploads/products dir

        await pipeline(part.file, fs.createWriteStream(filepath));

        const fileSize = fs.statSync(filepath).size;
        if (fileSize > MAX_IMAGE_SIZE) {
          fs.unlinkSync(filepath);
          throw new Error(`File ${part.filename} exceeds 3MB limit`);
        }

        files.push({
          fieldname: part.fieldname,
          originalname: part.filename,
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
    reply.status(400).send({ success: false, message: error.message });
    throw error;
  }
};

module.exports = {
  handleSellerDocsUpload,
  handleProductImagesUpload,
  handleBlogImageUpload
};






