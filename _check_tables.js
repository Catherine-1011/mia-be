require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.$queryRawUnsafe("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")
  .then(r => {
    const tables = r.map(x => x.table_name);
    console.log(`Tables created (${tables.length}):`);
    console.log(tables.join('\n'));
    const hasSub = tables.includes('sub_orders');
    console.log('\nsub_orders exists:', hasSub);
  })
  .catch(console.error)
  .finally(() => p.$disconnect());
