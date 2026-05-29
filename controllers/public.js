const prisma = require("../config/prisma");

// Get active sponsored sections for public website
exports.getActiveSponsoredSections = async (request, reply) => {
  try {
    const sponsoredSections = await prisma.sponsoredSection.findMany({
      where: {
        isActive: true
      },
      select: {
        id: true,
        title: true,
        description: true,
        mediaUrl: true,
        mediaType: true,
        ctaText: true,
        ctaUrl: true,
        order: true
      },
      orderBy: [
        { order: 'asc' },
        { createdAt: 'desc' }
      ]
    });

    return reply.status(200).send({
      success: true,
      data: sponsoredSections
    });
  } catch (error) {
    console.error('getActiveSponsoredSections error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};