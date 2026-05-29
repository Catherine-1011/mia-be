const { PrismaClient } = require('@prisma/client');
const { sendNewsletterSubscriptionAlertEmail } = require('../utils/emailService');

const prisma = new PrismaClient();
const NEWSLETTER_ISSUE_TYPE = 'Newsletter Subscription';

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

exports.submitNewsletterEmail = async (request, reply) => {
  try {
    const { email } = request.body || {};

    if (!email) {
      return reply.status(400).send({ success: false, error: 'Email is required.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    if (!isValidEmail(normalizedEmail)) {
      return reply.status(400).send({ success: false, error: 'Please provide a valid email address.' });
    }

    const existing = await prisma.contactMessage.findFirst({
      where: {
        issueType: NEWSLETTER_ISSUE_TYPE,
        email: normalizedEmail
      }
    });

    if (existing) {
      return reply.status(200).send({
        success: true,
        message: 'Email is already subscribed to newsletter updates.',
        data: existing
      });
    }

    const subscription = await prisma.contactMessage.create({
      data: {
        issueType: NEWSLETTER_ISSUE_TYPE,
        fullName: 'Newsletter Subscriber',
        phoneNumber: null,
        email: normalizedEmail,
        message: 'User requested newsletter updates.'
      }
    });

    await sendNewsletterSubscriptionAlertEmail({
      subscribedEmail: normalizedEmail,
      subscribedAt: subscription.createdAt
    });

    return reply.status(201).send({
      success: true,
      message: 'Newsletter subscription received successfully.',
      data: subscription
    });
  } catch (error) {
    console.error('Submit newsletter email error:', error);
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};

exports.getNewsletterEmails = async (request, reply) => {
  try {
    const { page = 1, limit = 20, search } = request.query;

    const pageNumber = Number.parseInt(page, 10);
    const pageSize = Number.parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageSize;

    const where = {
      issueType: NEWSLETTER_ISSUE_TYPE
    };

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } }
      ];
    }

    const [emails, totalCount] = await Promise.all([
      prisma.contactMessage.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          createdAt: true,
          status: true
        }
      }),
      prisma.contactMessage.count({ where })
    ]);

    return reply.status(200).send({
      success: true,
      data: emails,
      pagination: {
        total: totalCount,
        page: pageNumber,
        limit: pageSize,
        totalPages: Math.ceil(totalCount / pageSize)
      }
    });
  } catch (error) {
    console.error('Get newsletter emails error:', error);
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};

exports.exportNewsletterEmailsCsv = async (request, reply) => {
  try {
    const { search } = request.query;

    const where = {
      issueType: NEWSLETTER_ISSUE_TYPE
    };

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } }
      ];
    }

    const records = await prisma.contactMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true
      }
    });

    const header = ['id', 'email', 'status', 'subscribedAt'];
    const rows = records.map((item) => [
      escapeCsvValue(item.id),
      escapeCsvValue(item.email),
      escapeCsvValue(item.status),
      escapeCsvValue(item.createdAt?.toISOString())
    ].join(','));

    const csv = [header.join(','), ...rows].join('\n');
    const fileName = `newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`;

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .status(200)
      .send(csv);
  } catch (error) {
    console.error('Export newsletter emails CSV error:', error);
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};

exports.unsubscribeNewsletterEmail = async (request, reply) => {
  try {
    const { email } = request.body || {};

    if (!email) {
      return reply.status(400).send({ success: false, error: 'Email is required.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    if (!isValidEmail(normalizedEmail)) {
      return reply.status(400).send({ success: false, error: 'Please provide a valid email address.' });
    }

    const result = await prisma.contactMessage.deleteMany({
      where: {
        issueType: NEWSLETTER_ISSUE_TYPE,
        email: normalizedEmail
      }
    });

    if (result.count === 0) {
      return reply.status(200).send({
        success: true,
        message: 'Email is already unsubscribed from newsletter updates.'
      });
    }

    return reply.status(200).send({
      success: true,
      message: 'Email unsubscribed from newsletter updates successfully.'
    });
  } catch (error) {
    console.error('Unsubscribe newsletter email error:', error);
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};
