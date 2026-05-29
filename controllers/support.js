const prisma = require("../config/prisma");
const { sendContactFormEmail } = require("../utils/emailService");

// Submit Contact Form
exports.submitContactForm = async (request, reply) => {
  try {
    const { name, email, phone, subject, message } = request.body;

    // Validation
    if (!name || !email || !subject || !message) {
      return reply.status(400).send({ 
        success: false, 
        message: "Name, email, subject, and message are required" 
      });
    }

    // Get userId if authenticated
    const userId = request.user?.uid || null;

    // Save to database
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: userId,
        subject,
        message,
        status: "OPEN",
        priority: "MEDIUM",
        category: "Contact Form",
        attachments: []
      }
    });

    // Send confirmation email to user
    await sendContactFormEmail(email, name, subject, message);

    return reply.status(200).send({ 
      success: true, 
      message: "Your message has been submitted successfully. We'll get back to you soon!",
      ticketId: ticket.id
    });
  } catch (err) {
    console.error("Contact form submission error:", err);
    return reply.status(500).send({ 
      success: false, 
      error: err.message 
    });
  }
};

// Get Return Policy (Static)
exports.getReturnPolicy = async (request, reply) => {
  try {
    const returnPolicy = {
      title: "Return & Refund Policy",
      lastUpdated: "2025-12-15",
      sections: [
        {
          heading: "Return Window",
          content: "You can return most items within 30 days of delivery for a full refund. Some products may have different return windows."
        },
        {
          heading: "Conditions for Returns",
          content: "Items must be unused, in original packaging, and in the same condition as received. Original tags and labels must be attached."
        },
        {
          heading: "Non-Returnable Items",
          content: "The following items cannot be returned: Perishable goods, intimate items, downloadable software, gift cards, and personalized items."
        },
        {
          heading: "Return Process",
          content: "1. Log into your account and go to Orders\n2. Select the order and click 'Request Return'\n3. Choose reason for return\n4. Pack the item securely\n5. Ship to the return address provided\n6. Refund will be processed within 7-10 business days after we receive the item"
        },
        {
          heading: "Refund Method",
          content: "Refunds will be issued to the original payment method (Stripe). Refunds are typically processed within 5-10 business days depending on your bank."
        },
        {
          heading: "Shipping Costs",
          content: "Return shipping costs are the responsibility of the customer unless the item is defective or incorrect."
        },
        {
          heading: "Exchanges",
          content: "We currently do not offer direct exchanges. Please return the item for a refund and place a new order."
        },
        {
          heading: "Damaged or Defective Items",
          content: "If you receive a damaged or defective item, please contact us immediately with photos. We'll arrange a free return and full refund."
        },
        {
          heading: "Contact Us",
          content: "For return inquiries, please contact our support team through the contact form or email us at support@yourstore.com"
        }
      ]
    };

    return reply.status(200).send({ 
      success: true, 
      policy: returnPolicy 
    });
  } catch (err) {
    console.error("Get return policy error:", err);
    return reply.status(500).send({ 
      success: false, 
      error: err.message 
    });
  }
};

// Get My Support Tickets (Authenticated User)
exports.getMyTickets = async (request, reply) => {
  try {
    const userId = request.userId; // From auth middleware

    const ticketsSnap = await db.collection("contactForms")
      .where("userId", "==", userId)
      .get();

    // Sort manually in JavaScript to avoid needing Firestore index
    const tickets = ticketsSnap.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
      .sort((a, b) => {
        const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
        const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
        return dateB - dateA; // Descending order (newest first)
      });

    return reply.status(200).send({ 
      success: true, 
      tickets,
      count: tickets.length 
    });
  } catch (err) {
    console.error("Get my tickets error:", err);
    return reply.status(500).send({ 
      success: false, 
      error: err.message 
    });
  }
};


