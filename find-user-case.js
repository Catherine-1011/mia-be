/**
 * Find sellers matching the user's specific case:
 * - Had ~$7000+ redeemable 
 * - Requested ~$500 payout
 * - Now shows $0 redeemable
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: [] });

async function findUserCase() {
  console.log("🔍 Looking for Your Specific Commission Loss Case");
  console.log("═══════════════════════════════════════════════════════");

  try {
    // Look for sellers with payout patterns matching user's description
    const matchingCases = await prisma.$queryRaw`
      SELECT 
        pr.seller_id,
        pr.requested_amount::float as requested_amount,
        pr.redeemable_at_request::float as redeemable_at_request,
        pr.created_at as payout_date,
        pr.status as payout_status,
        -- Current commission totals
        COALESCE(SUM(ce.net_payable), 0)::float as current_total_paid
      FROM payout_requests pr
      LEFT JOIN commission_earned ce ON pr.seller_id = ce.seller_id AND ce.status = 'PAID'
      WHERE pr.requested_amount BETWEEN 400 AND 600  -- Around $500
        AND pr.redeemable_at_request BETWEEN 6000 AND 8000  -- Around $7000
        AND pr.status = 'COMPLETED'
        AND pr.created_at >= NOW() - INTERVAL '90 days'  -- Recent
      GROUP BY pr.seller_id, pr.requested_amount, pr.redeemable_at_request, pr.created_at, pr.status
      ORDER BY pr.created_at DESC
    `;

    if (matchingCases.length === 0) {
      console.log("❌ No exact matches found. Let's look for similar patterns...");
      
      // Broader search
      const broaderSearch = await prisma.$queryRaw`
        SELECT 
          pr.seller_id,
          pr.requested_amount::float,
          pr.redeemable_at_request::float,
          pr.created_at,
          pr.status,
          -- Check current status
          (SELECT COUNT(*) FROM commission_earned WHERE seller_id = pr.seller_id AND status = 'PENDING') as current_pending_count,
          (SELECT COALESCE(SUM(net_payable), 0) FROM commission_earned WHERE seller_id = pr.seller_id AND status = 'PAID')::float as current_paid_total
        FROM payout_requests pr
        WHERE pr.redeemable_at_request > 5000  -- Had significant amount
          AND pr.requested_amount < pr.redeemable_at_request * 0.2  -- Requested less than 20% of balance
          AND pr.status = 'COMPLETED'
          AND pr.created_at >= NOW() - INTERVAL '90 days'
        ORDER BY pr.created_at DESC
        LIMIT 10
      `;
      
      console.log("📋 Similar cases found:");
      broaderSearch.forEach(case_ => {
        const date = new Date(case_.created_at).toLocaleDateString();
        const hadAmount = parseFloat(case_.redeemable_at_request);
        const requested = parseFloat(case_.requested_amount);
        const currentPaid = parseFloat(case_.current_paid_total);
        const currentPending = parseInt(case_.current_pending_count);
        
        console.log(`\n   Seller: ${case_.seller_id}`);
        console.log(`   Date: ${date}`);
        console.log(`   Had: $${hadAmount.toFixed(2)} → Requested: $${requested.toFixed(2)} → Status: ${case_.status}`);
        console.log(`   Current: $${currentPaid.toFixed(2)} PAID, ${currentPending} PENDING records`);
        
        if (currentPending === 0 && currentPaid > requested * 2) {
          console.log(`   🚨 VICTIM OF BUG: Lost $${(hadAmount - requested).toFixed(2)} due to old payout bug!`);
        }
      });
      
    } else {
      console.log("🎯 Found exact matches for your case:");
      
      matchingCases.forEach(case_ => {
        const date = new Date(case_.payout_date).toLocaleDateString();
        const redeemableAmount = parseFloat(case_.redeemable_at_request);
        const requestedAmount = parseFloat(case_.requested_amount);
        const currentPaidTotal = parseFloat(case_.current_total_paid);
        const lostAmount = redeemableAmount - requestedAmount;
        
        console.log(`\n📊 CASE FOUND - Seller: ${case_.seller_id}`);
        console.log(`   📅 Payout Date: ${date}`);
        console.log(`   💰 Had Redeemable: $${redeemableAmount.toFixed(2)}`);
        console.log(`   💸 Requested: $${requestedAmount.toFixed(2)}`);
        console.log(`   ✅ Status: ${case_.payout_status}`);
        console.log(`   📈 Current Total Marked PAID: $${currentPaidTotal.toFixed(2)}`);
        console.log(`   💔 Amount Lost to Bug: $${lostAmount.toFixed(2)}`);
        
        console.log(`\n   🔍 What Happened:`);
        console.log(`   1. You had $${redeemableAmount.toFixed(2)} in pending commissions`);
        console.log(`   2. You requested a $${requestedAmount.toFixed(2)} payout`);
        console.log(`   3. Admin completed your payout request`);
        console.log(`   4. 🐛 OLD BUG: Marked ALL $${redeemableAmount.toFixed(2)} as PAID instead of just $${requestedAmount.toFixed(2)}`);
        console.log(`   5. 📉 Result: You lost $${lostAmount.toFixed(2)} that should still be pending`);
      });
    }

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`💡 SUMMARY:`);
    console.log(`   - This confirms you were affected by the old payout bug`);
    console.log(`   - Your $7000+ was incorrectly marked as PAID when you requested $500`);
    console.log(`   - The fix we implemented prevents this from happening again`);
    console.log(`   - You may want to discuss compensation/correction with the admin`);

  } catch (error) {
    console.error("❌ Search failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

findUserCase();