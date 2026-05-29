/**
 * Investigation script to check commission status after payout fix
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: [] });

async function investigateCommissions() {
  console.log("🔍 Commission Status Investigation");
  console.log("═══════════════════════════════════════════════════════");

  try {
    // 1. Check overall commission distribution
    console.log("1. Overall commission status distribution:");
    const statusDistribution = await prisma.$queryRaw`
      SELECT 
        status,
        COUNT(*) as record_count,
        SUM(net_payable)::float as total_amount
      FROM commission_earned 
      GROUP BY status
      ORDER BY record_count DESC
    `;
    
    statusDistribution.forEach(row => {
      console.log(`   ${row.status}: ${row.record_count} records, $${parseFloat(row.total_amount).toFixed(2)}`);
    });

    // 2. Find sellers with pending commissions (good for testing our fix)
    console.log("\n2. Sellers with pending commissions (good for testing):");
    const sellersWithPending = await prisma.$queryRaw`
      SELECT 
        seller_id,
        COUNT(*) as pending_count,
        SUM(net_payable)::float as pending_amount
      FROM commission_earned 
      WHERE status = 'PENDING'
      GROUP BY seller_id
      ORDER BY pending_amount DESC
      LIMIT 5
    `;

    if (sellersWithPending.length > 0) {
      sellersWithPending.forEach(seller => {
        console.log(`   Seller ${seller.seller_id}: ${seller.pending_count} pending, $${parseFloat(seller.pending_amount).toFixed(2)}`);
      });
    } else {
      console.log("   ❌ No sellers found with pending commissions!");
    }

    // 3. Find sellers who were likely affected by the old bug (all PAID, recent payout history)
    console.log("\n3. Sellers likely affected by old bug (all commissions marked PAID):");
    const affectedSellers = await prisma.$queryRaw`
      SELECT 
        ce.seller_id,
        COUNT(ce.*) as total_records,
        SUM(ce.net_payable)::float as total_paid_amount,
        COUNT(pr.*) as payout_request_count,
        MAX(pr.created_at) as last_payout_date
      FROM commission_earned ce
      LEFT JOIN payout_requests pr ON ce.seller_id = pr.seller_id
      WHERE ce.status = 'PAID'
      GROUP BY ce.seller_id
      HAVING COUNT(CASE WHEN ce.status = 'PENDING' THEN 1 END) = 0
      ORDER BY total_paid_amount DESC
      LIMIT 5
    `;

    affectedSellers.forEach(seller => {
      console.log(`   Seller ${seller.seller_id}: $${parseFloat(seller.total_paid_amount).toFixed(2)} all PAID, ${seller.payout_request_count || 0} payouts`);
    });

    // 4. Recent payout history analysis
    console.log("\n4. Recent payout requests analysis:");
    const recentPayouts = await prisma.$queryRaw`
      SELECT 
        seller_id,
        requested_amount::float,
        status,
        created_at,
        processed_at
      FROM payout_requests 
      WHERE created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC
      LIMIT 10
    `;

    if (recentPayouts.length > 0) {
      console.log("   Recent payouts (last 30 days):");
      recentPayouts.forEach(payout => {
        const date = new Date(payout.created_at).toLocaleDateString();
        console.log(`   - ${date}: $${parseFloat(payout.requested_amount).toFixed(2)} (${payout.status}) - Seller ${payout.seller_id}`);
      });
    } else {
      console.log("   No recent payout requests found");
    }

    // 5. Recommendations
    console.log("\n5. Recommendations:");
    console.log("═══════════════════════════════════════════════════════");
    
    if (sellersWithPending.length > 0) {
      console.log("✅ Test the fix with sellers who have pending commissions:");
      sellersWithPending.slice(0, 2).forEach(seller => {
        console.log(`   - Seller ${seller.seller_id} (has $${parseFloat(seller.pending_amount).toFixed(2)} pending)`);
      });
    }

    if (affectedSellers.length > 0) {
      console.log("\n⚠️ Sellers likely affected by old bug may need manual review:");
      affectedSellers.slice(0, 2).forEach(seller => {
        console.log(`   - Seller ${seller.seller_id} (all $${parseFloat(seller.total_paid_amount).toFixed(2)} marked as PAID)`);
      });
    }

  } catch (error) {
    console.error("❌ Investigation failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

investigateCommissions();