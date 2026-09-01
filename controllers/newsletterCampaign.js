const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { PrismaClient } = require('@prisma/client');
const { uploadToCloudinary } = require('../config/cloudinary');
const { sendNewsletterCampaignEmail } = require('../utils/emailService');
const { createContainedUploadPath, extensionForMime } = require('../utils/uploadSecurity');
const { sanitizeNewsletterHtml } = require('../utils/newsletterHtml');

const prisma = new PrismaClient();

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

async function uploadBannerImage(part) {
  if (!ALLOWED_MIME_TYPES.includes(part.mimetype)) {
    throw new Error('Only JPEG, PNG, and WEBP images are allowed for banner.');
  }

  const tempPath = createContainedUploadPath(require('os').tmpdir(), 'campaign-banner', extensionForMime(part.mimetype));

  let size = 0;
  part.file.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_FILE_SIZE) {
      part.file.destroy(new Error('Banner image exceeds 5 MB limit.'));
    }
  });

  try {
    await pipeline(part.file, fs.createWriteStream(tempPath, { flags: 'wx' }));
  } catch (err) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw err;
  }

  try {
    const result = await uploadToCloudinary(tempPath, 'newsletter-campaigns');
    return result.url;
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

const NEWSLETTER_ISSUE_TYPE = 'Newsletter Subscription';

const SEND_DELAY_MS = 200;   // pause between individual sends (ms)
const RETRY_DELAY_MS = 3000; // wait before retry (ms)
const MAX_RETRIES = 1;

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Permanent errors should NOT be retried (they will always fail).
// Only transient errors (network, timeouts, 5xx) should be retried.
function isPermanentError(error) {
  const code = error?.code;
  const statusCode = error?.response?.statusCode || error?.statusCode;
  const msg = (error?.message || '').toLowerCase();

  // SendGrid HTTP permanent errors
  if (statusCode === 400) return true; // bad request — bad email format, invalid params
  if (statusCode === 401) return true; // invalid API key
  if (statusCode === 403) return true; // sender identity not verified / account suspended

  // SMTP permanent codes
  if (code === 'EENVELOPE') return true; // bad recipient address
  if (code === 'EAUTH') return true;     // auth failure

  // Common permanent messages
  if (msg.includes('invalid') && msg.includes('email')) return true;
  if (msg.includes('not verified')) return true;
  if (msg.includes('suspended')) return true;

  return false;
}

// POST /api/newsletter/campaigns  (multipart/form-data)
exports.createCampaign = async (request, reply) => {
  try {
    let subject, content, buttonText, buttonLink, saveDraft;
    let bannerImageUrl = null;

    if (request.isMultipart()) {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'bannerImage') {
          bannerImageUrl = await uploadBannerImage(part);
        } else if (part.type !== 'file') {
          if (part.fieldname === 'subject') subject = part.value;
          else if (part.fieldname === 'content') content = part.value;
          else if (part.fieldname === 'buttonText') buttonText = part.value;
          else if (part.fieldname === 'buttonLink') buttonLink = part.value;
          else if (part.fieldname === 'saveDraft') saveDraft = part.value;
        }
      }
    } else {
      ({ subject, content, buttonText, buttonLink, saveDraft } = request.body || {});
    }

    if (!subject || !subject.trim()) {
      return reply.status(400).send({ success: false, error: 'Subject is required.' });
    }
    if (!content || !content.trim()) {
      return reply.status(400).send({ success: false, error: 'Content is required.' });
    }
    const safeContent = sanitizeNewsletterHtml(content.trim());
    if (!safeContent.trim()) {
      return reply.status(400).send({ success: false, error: 'Content must contain supported newsletter HTML or text.' });
    }

    const campaign = await prisma.newsletterCampaign.create({
      data: {
        subject: subject.trim(),
        content: safeContent,
        bannerImage: bannerImageUrl,
        buttonText: buttonText || null,
        buttonLink: buttonLink || null,
        status: 'DRAFT'
      }
    });

    return reply.status(201).send({
      success: true,
      message: saveDraft ? 'Campaign saved as draft.' : 'Campaign created successfully.',
      data: campaign
    });
  } catch (error) {
    console.error('Create campaign error:', error);
    return reply.status(500).send({ success: false, error: error.message || 'Internal server error' });
  }
};

// GET /api/newsletter/campaigns
exports.getCampaigns = async (request, reply) => {
  try {
    const { page = 1, limit = 20, status } = request.query;

    const pageNumber = Number.parseInt(page, 10);
    const pageSize = Number.parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageSize;

    const where = {};
    if (status) {
      where.status = status.toUpperCase();
    }

    const [campaigns, totalCount] = await Promise.all([
      prisma.newsletterCampaign.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.newsletterCampaign.count({ where })
    ]);

    return reply.status(200).send({
      success: true,
      data: campaigns.map((campaign) => ({ ...campaign, content: sanitizeNewsletterHtml(campaign.content) })),
      pagination: {
        total: totalCount,
        page: pageNumber,
        limit: pageSize,
        totalPages: Math.ceil(totalCount / pageSize)
      }
    });
  } catch (error) {
    console.error('Get campaigns error:', error);
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};

// GET /api/newsletter/campaigns/:id
exports.getCampaign = async (request, reply) => {
  try {
    const { id } = request.params;

    const campaign = await prisma.newsletterCampaign.findUnique({ where: { id } });

    if (!campaign) {
      return reply.status(404).send({ success: false, error: 'Campaign not found.' });
    }

    return reply.status(200).send({
      success: true,
      data: { ...campaign, content: sanitizeNewsletterHtml(campaign.content) }
    });
  } catch (error) {
    console.error('Get campaign error:', error);
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};

// PUT /api/newsletter/campaigns/:id  (multipart/form-data)
exports.updateCampaign = async (request, reply) => {
  try {
    const { id } = request.params;

    const existing = await prisma.newsletterCampaign.findUnique({ where: { id } });

    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Campaign not found.' });
    }

    if (existing.status !== 'DRAFT') {
      return reply.status(400).send({ success: false, error: 'Only draft campaigns can be edited.' });
    }

    let subject, content, buttonText, buttonLink;
    let bannerImageUrl;
    let hasBannerField = false;

    if (request.isMultipart()) {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'bannerImage') {
          hasBannerField = true;
          bannerImageUrl = await uploadBannerImage(part);
        } else if (part.type !== 'file') {
          if (part.fieldname === 'subject') subject = part.value;
          else if (part.fieldname === 'content') content = part.value;
          else if (part.fieldname === 'buttonText') buttonText = part.value;
          else if (part.fieldname === 'buttonLink') buttonLink = part.value;
          else if (part.fieldname === 'removeBanner' && part.value === 'true') {
            hasBannerField = true;
            bannerImageUrl = null;
          }
        }
      }
    } else {
      ({ subject, content, buttonText, buttonLink } = request.body || {});
      if ('bannerImage' in (request.body || {})) {
        hasBannerField = true;
        bannerImageUrl = request.body.bannerImage || null;
      }
    }

    const data = {};
    if (subject !== undefined) data.subject = subject.trim();
    if (content !== undefined) {
      const safeContent = sanitizeNewsletterHtml(content.trim());
      if (!safeContent.trim()) {
        return reply.status(400).send({ success: false, error: 'Content must contain supported newsletter HTML or text.' });
      }
      data.content = safeContent;
    }
    if (hasBannerField) data.bannerImage = bannerImageUrl;
    if (buttonText !== undefined) data.buttonText = buttonText || null;
    if (buttonLink !== undefined) data.buttonLink = buttonLink || null;

    const updated = await prisma.newsletterCampaign.update({ where: { id }, data });

    return reply.status(200).send({
      success: true,
      message: 'Campaign updated.',
      data: { ...updated, content: sanitizeNewsletterHtml(updated.content) }
    });
  } catch (error) {
    console.error('Update campaign error:', error);
    return reply.status(500).send({ success: false, error: error.message || 'Internal server error' });
  }
};

// DELETE /api/newsletter/campaigns/:id
exports.deleteCampaign = async (request, reply) => {
  try {
    const { id } = request.params;

    const existing = await prisma.newsletterCampaign.findUnique({ where: { id } });

    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Campaign not found.' });
    }

    if (existing.status === 'SENDING') {
      return reply.status(400).send({ success: false, error: 'Cannot delete a campaign that is currently being sent.' });
    }

    await prisma.newsletterCampaign.delete({ where: { id } });

    return reply.status(200).send({ success: true, message: 'Campaign deleted successfully.' });
  } catch (error) {
    console.error('Delete campaign error:', error);
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};

// POST /api/newsletter/campaigns/:id/send
exports.sendCampaign = async (request, reply) => {
  try {
    const { id } = request.params;

    const campaign = await prisma.newsletterCampaign.findUnique({ where: { id } });

    if (!campaign) {
      return reply.status(404).send({ success: false, error: 'Campaign not found.' });
    }

    if (campaign.status === 'SENT') {
      return reply.status(400).send({ success: false, error: 'Campaign has already been sent.' });
    }

    if (campaign.status === 'SENDING') {
      return reply.status(400).send({ success: false, error: 'Campaign is already being sent.' });
    }

    // Fetch all active newsletter subscribers
    const subscribers = await prisma.contactMessage.findMany({
      where: { issueType: NEWSLETTER_ISSUE_TYPE },
      select: { email: true }
    });

    const totalRecipients = subscribers.length;

    if (totalRecipients === 0) {
      return reply.status(400).send({ success: false, error: 'No newsletter subscribers found.' });
    }

    // Mark campaign as SENDING
    await prisma.newsletterCampaign.update({
      where: { id },
      data: { status: 'SENDING', totalRecipients }
    });

    // Respond immediately; process sending in background
    reply.status(200).send({
      success: true,
      message: `Campaign sending started. Sending to ${totalRecipients} subscribers.`,
      data: { id, totalRecipients }
    });

    // Background: send emails in batches
    _processCampaignSend({ campaign, subscribers, totalRecipients }).catch((err) => {
      console.error(`[Campaign ${id}] Fatal background send error:`, err);
    });
  } catch (error) {
    console.error('Send campaign error:', error);
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};

async function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function _sendWithRetry(params, id) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let lastError;
    try {
      const result = await sendNewsletterCampaignEmail(params);
      if (result.success) return { success: true };

      // Parse error object from result if available
      lastError = result._errorObj || new Error(result.error || 'Send failed');

      const permanent = isPermanentError(lastError);
      if (permanent || attempt >= MAX_RETRIES) {
        if (permanent) {
          console.warn(`[Campaign ${id}] Permanent failure for ${params.toEmail} (no retry): ${result.error}`);
        }
        return { success: false, error: result.error };
      }

      console.warn(`[Campaign ${id}] Attempt ${attempt + 1} failed for ${params.toEmail}: ${result.error}. Retrying in ${RETRY_DELAY_MS}ms...`);
      await _sleep(RETRY_DELAY_MS);
    } catch (err) {
      lastError = err;
      if (isPermanentError(err) || attempt >= MAX_RETRIES) {
        return { success: false, error: err.message };
      }
      console.warn(`[Campaign ${id}] Attempt ${attempt + 1} threw for ${params.toEmail}: ${err.message}. Retrying...`);
      await _sleep(RETRY_DELAY_MS);
    }
  }
  return { success: false, error: 'Max retries exceeded' };
}

async function _processCampaignSend({ campaign, subscribers, totalRecipients }) {
  const { id, subject, bannerImage, buttonText, buttonLink } = campaign;
  const content = sanitizeNewsletterHtml(campaign.content);
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  // De-duplicate and validate emails up front
  const seenEmails = new Set();
  const validEmails = [];
  for (const s of subscribers) {
    const email = s.email.toLowerCase().trim();
    if (seenEmails.has(email)) continue;
    seenEmails.add(email);
    if (!isValidEmail(email)) {
      console.warn(`[Campaign ${id}] Skipping invalid email address: ${email}`);
      skippedCount++;
      continue;
    }
    validEmails.push(email);
  }


  for (let i = 0; i < validEmails.length; i++) {
    const email = validEmails[i];

    const result = await _sendWithRetry(
      { toEmail: email, subject, content, bannerImage, buttonText, buttonLink },
      id
    );

    if (result.success) {
      sentCount++;
    } else {
      failedCount++;
      console.warn(`[Campaign ${id}] Failed (${i + 1}/${validEmails.length}) ${email}: ${result.error}`);
    }

    // Persist progress every 10 emails or at the end
    if ((i + 1) % 10 === 0 || i === validEmails.length - 1) {
      await prisma.newsletterCampaign.update({
        where: { id },
        data: { sentCount, failedCount }
      });
    }

    // Small pause between sends to avoid overwhelming SMTP connection pool
    if (i < validEmails.length - 1) {
      await _sleep(SEND_DELAY_MS);
    }
  }

  // Mark as SENT
  await prisma.newsletterCampaign.update({
    where: { id },
    data: {
      status: 'SENT',
      sentCount,
      failedCount,
      totalRecipients,
      sentAt: new Date()
    }
  });

}
