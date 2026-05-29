const prisma = require("../config/prisma");
const { randomBytes } = require("crypto");

// Generate a cuid-compatible ID (matches Prisma's @default(cuid()) format)
const createId = () => 'c' + randomBytes(11).toString('hex').substring(0, 24);

// POST /api/feedback  — anyone can submit (logged in or guest)
exports.submitFeedback = async (request, reply) => {
  try {
    const { rating, comment, name, email } = request.body || {};

    // Validate rating
    const parsedRating = parseInt(rating);
    if (!parsedRating || parsedRating < 1 || parsedRating > 5) {
      return reply.status(400).send({
        success: false,
        message: "Rating is required and must be between 1 and 5"
      });
    }

    // Get userId from JWT if authenticated (optional)
    const userId = request.user?.userId || null;

    // For logged-in users, pull name/email from their profile if not provided
    let resolvedName = name || null;
    let resolvedEmail = email || null;

    if (userId && (!resolvedName || !resolvedEmail)) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true }
      });
      if (user) {
        resolvedName = resolvedName || user.name;
        resolvedEmail = resolvedEmail || user.email;
      }
    }

    const id = createId(); // cuid2 format — same as Prisma's @default(cuid())

    // Use raw SQL since Prisma client hasn't been regenerated for new table
    await prisma.$executeRaw`
      INSERT INTO "site_feedback" ("id", "userId", "name", "email", "rating", "comment", "createdAt")
      VALUES (${id}, ${userId}, ${resolvedName}, ${resolvedEmail}, ${parsedRating}, ${comment || null}, NOW())
    `;

    return reply.status(201).send({
      success: true,
      message: "Thank you for your feedback!",
      feedback: {
        id,
        rating: parsedRating,
        comment: comment || null
      }
    });
  } catch (err) {
    console.error("Submit feedback error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// GET /api/admin/feedback  — admin only
exports.getAllFeedback = async (request, reply) => {
  try {
    const { rating, limit = 20, offset = 0 } = request.query;

    // Build dynamic WHERE clause
    let whereClauses = [];

    if (rating) {
      whereClauses.push(`sf.rating = ${parseInt(rating)}`);
    }

    const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const feedbacks = await prisma.$queryRawUnsafe(`
      SELECT sf.id, sf.rating, sf.comment, sf."createdAt",
             sf.name, sf.email,
             u.id AS "user_id", u.name AS "user_name", u.email AS "user_email", u.role AS "user_role"
      FROM "site_feedback" sf
      LEFT JOIN "users" u ON sf."userId" = u.id
      ${whereSQL}
      ORDER BY sf."createdAt" DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `);

    const countResult = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS total FROM "site_feedback" sf ${whereSQL}
    `);

    const total = countResult[0]?.total || 0;

    // Build stats
    const statsResult = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int                                  AS "totalCount",
        ROUND(AVG(rating)::numeric, 2)                AS "averageRating",
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END)::int AS "five",
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END)::int AS "four",
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END)::int AS "three",
        SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END)::int AS "two",
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)::int AS "one"
      FROM "site_feedback"
    `;

    const stats = statsResult[0];

    const mapped = feedbacks.map(({ user_id, user_name, user_email, user_role, ...f }) => ({
      ...f,
      user: user_id ? { id: user_id, name: user_name, email: user_email, role: user_role } : null
    }));

    return reply.status(200).send({
      success: true,
      feedback: mapped,
      total,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + parseInt(limit) < total
      },
      stats: {
        totalCount: stats.totalCount,
        averageRating: parseFloat(stats.averageRating) || 0,
        breakdown: {
          5: stats.five,
          4: stats.four,
          3: stats.three,
          2: stats.two,
          1: stats.one
        }
      }
    });
  } catch (err) {
    console.error("Get all feedback error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// DELETE /api/admin/feedback/:id  — admin only
exports.deleteFeedback = async (request, reply) => {
  try {
    const { id } = request.params;

    const rows = await prisma.$queryRaw`SELECT id FROM "site_feedback" WHERE id = ${id}`;
    if (!rows.length) {
      return reply.status(404).send({ success: false, message: "Feedback not found" });
    }

    await prisma.$executeRaw`DELETE FROM "site_feedback" WHERE id = ${id}`;

    return reply.status(200).send({ success: true, message: "Feedback deleted" });
  } catch (err) {
    console.error("Delete feedback error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};
