/**
 * Investigate specific seller's commission loss
 * This will show exactly what happened to the missing commissions
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: [] });

async function investigateSellerCommissionLoss() {
  console.log("🕵️ Investigating Commission Loss");
  console.log("═══════════════════════════════════════════════════════");

  try {
    // First, let's find sellers who had recent payout activity
    console.log("1. Looking for sellers with recent payout activity...");
    
    const recentPayoutSellers = await prisma.$queryRaw`
      SELECT DISTINCT seller_id
      FROM payout_requests 
      WHERE created_at >= NOW() - INTERVAL '60 days'
      ORDER BY seller_id
    `;

    for (const seller of recentPayoutSellers) {
      const sellerId = seller.seller_id;
      
      // Get current commission status
      const currentStatus = await prisma.$queryRaw`
        SELECT
          COUNT(*) as total_records,
          COUNT(CASE WHEN status = 'PENDING' THEN 1 END) as pending_count,
          COUNT(CASE WHEN status = 'PAID' THEN 1 END) as paid_count,
          COALESCE(SUM(CASE WHEN status = 'PENDING' THEN net_payable ELSE 0 END), 0)::float AS "pendingAmount",
          COALESCE(SUM(CASE WHEN status = 'PAID' THEN net_payable ELSE 0 END), 0)::float AS "paidAmount",
          MIN(created_at) as earliest_commission,
          MAX(created_at) as latest_commission
        FROM commission_earned
        WHERE seller_id = ${sellerId}
      `;

      // Get payout request history
      const payoutHistory = await prisma.$queryRaw`
        SELECT 
          id,
          requested_amount::float,
          redeemable_at_request::float,
          status,
          created_at,
          processed_at
        FROM payout_requests 
        WHERE seller_id = ${sellerId}
        ORDER BY created_at DESC
      `;

      const current = currentStatus[0];
      
      // Look for suspicious patterns (high total paid vs small payout requests)
      const totalPayoutRequested = payoutHistory.reduce((sum, p) => 
        sum + (p.status === 'COMPLETED' ? parseFloat(p.requested_amount) : 0), 0);
      
      const suspiciousRatio = current.paidAmount / Math.max(totalPayoutRequested, 1);
      
      if (suspiciousRatio > 2 && current.pendingAmount === 0 && current.paidAmount > 1000) {
        console.log(`\n🚨 SUSPICIOUS: Seller ${sellerId}`);
        console.log(`   Current Status: $${current.paidAmount.toFixed(2)} PAID, $${current.pendingAmount.toFixed(2)} PENDING`);
        console.log(`   Total Payout Requests Completed: $${totalPayoutRequested.toFixed(2)}`);
        console.log(`   Ratio (Paid/Requested): ${suspiciousRatio.toFixed(2)}x (should be ~1.0)`);
        
        console.log(`\n   📋 Payout History:`);
        payoutHistory.forEach(payout => {
          const date = new Date(payout.created_at).toLocaleDateString();
          const redeemableAtTime = parseFloat(payout.redeemable_at_request || 0);
          console.log(`   - ${date}: Requested $${parseFloat(payout.requested_amount).toFixed(2)} (had $${redeemableAtTime.toFixed(2)} redeemable) - ${payout.status}`);
        });

        // Show commission records that got marked as PAID
        const allCommissions = await prisma.$queryRaw`
          SELECT 
            id,
            order_id,
            net_payable::float,
            status,
            created_at,
            updated_at
          FROM commission_earned
          WHERE seller_id = ${sellerId}
          ORDER BY updated_at DESC
          LIMIT 10
        `;

        console.log(`\n   💰 Recent Commission Records:`);
        allCommissions.forEach(comm => {
          const created = new Date(comm.created_at).toLocaleDateString();
          const updated = new Date(comm.updated_at).toLocaleDateString();
          console.log(`   - Order ${comm.order_id}: $${comm.net_payable.toFixed(2)} (${comm.status}) - Created: ${created}, Updated: ${updated}`);
        });

        // Check if all commissions were updated at the same time (smoking gun!)
        const updateTimes = [...new Set(allCommissions.map(c => new Date(c.updated_at).toISOString()))];
        if (updateTimes.length === 1 && allCommissions.length > 1) {
          console.log(`   🔥 SMOKING GUN: All ${allCommissions.length} commissions were updated at the SAME TIME: ${new Date(updateTimes[0]).toLocaleString()}`);
          console.log(`   🐛 This is clear evidence of the old bug marking ALL commissions as PAID at once!`);
        }
      }
    }

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`💡 What This Means:`);
    console.log(`   - If you see suspicious ratios above, those sellers were affected by the old bug`);
    console.log(`   - The "SMOKING GUN" shows when all commissions were wrongly marked as PAID`);
    console.log(`   - Your $7000+ probably got marked as PAID when you requested $500`);

  } catch (error) {
    console.error("❌ Investigation failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

investigateSellerCommissionLoss();