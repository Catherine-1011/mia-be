const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const VALID_ISSUE_TYPES = [
  'Customer Order Support',
  'Seller Registration',
  'Becoming a Marketplace Partner',
  'Cultural or Community Enquiries',
  'Media / Press',
  'General Enquiry'
];

exports.submitContactForm = async (request, reply) => {
  try {
    const { issueType, fullName, phoneNumber, email, message } = request.body;

    if (!issueType || !VALID_ISSUE_TYPES.includes(issueType)) {
      return reply.status(400).send({ error: 'Invalid or missing issue type.' });
    }

    if (!fullName || !email || !message) {
      return reply.status(400).send({ error: 'Full name, email, and message are required.' });
    }

    const newContactMessage = await prisma.contactMessage.create({
      data: {
        issueType,
        fullName,
        phoneNumber,
        email,
        message
      }
    });

    return reply.status(201).send({ 
      success: true, 
      message: 'Contact form submitted successfully', 
      data: newContactMessage 
    });
  } catch (error) {
    console.error('Submit contact form error:', error);
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};

exports.getContactSubmissions = async (request, reply) => {
  try {
    const { page = 1, limit = 20, issueType, search, status } = request.query;
    
    const pageNumber = parseInt(page);
    const pageSize = parseInt(limit);
    const skip = (pageNumber - 1) * pageSize;

    const where = {};
    
    if (issueType) {
      where.issueType = issueType;
    }
    
    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } }
      ];
    }

    const [submissions, totalCount] = await Promise.all([
      prisma.contactMessage.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.contactMessage.count({ where })
    ]);
    
    return reply.status(200).send({ 
      success: true, 
      data: submissions,
      pagination: {
        total: totalCount,
        page: pageNumber,
        limit: pageSize,
        totalPages: Math.ceil(totalCount / pageSize)
      }
    });
  } catch (error) {
    console.error('Get contact submissions error:', error);
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};

exports.updateContactStatus = async (request, reply) => {
  try {
    const { id } = request.params;
    const { status } = request.body;

    const VALID_STATUSES = ['NEW', 'IN_PROGRESS', 'RESOLVED'];

    if (!status || !VALID_STATUSES.includes(status)) {
      return reply.status(400).send({ error: 'Invalid or missing status.' });
    }

    const updatedMessage = await prisma.contactMessage.update({
      where: { id },
      data: { status }
    });

    return reply.status(200).send({
      success: true,
      message: 'Status updated successfully',
      data: updatedMessage
    });
  } catch (error) {
    console.error('Update contact status error:', error);
    if (error.code === 'P2025') {
      return reply.status(404).send({ success: false, error: 'Contact message not found' });
    }
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};

exports.deleteContactMessage = async (request, reply) => {
  try {
    const { id } = request.params;

    await prisma.contactMessage.delete({
      where: { id }
    });

    return reply.status(200).send({
      success: true,
      message: 'Contact message deleted successfully'
    });
  } catch (error) {
    console.error('Delete contact message error:', error);
    if (error.code === 'P2025') {
      return reply.status(404).send({ success: false, error: 'Contact message not found' });
    }
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
};