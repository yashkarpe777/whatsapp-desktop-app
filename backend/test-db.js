#!/usr/bin/env node

import { databaseConfig } from './src/databaseConfig.js';
import { hotPool, getLocalPool, hostPool, rebuildPool } from './src/db.js';

console.log('🔍 Testing database connection...\n');

// Test database config
console.log('1. Testing database config:');
const config = databaseConfig.getConfig();
console.log('Config:', config ? {
  host: config.host,
  port: config.port,
  user: config.user,
  database: config.database,
  hasPassword: !!config.password
} : 'No config found');

// Test pools
console.log('\n2. Testing database pools:');
console.log('Local pool exists:', !!getLocalPool());
console.log('Host pool exists:', !!hostPool);

// Test hot pool
console.log('\n3. Testing hot pool connection:');
try {
  const result = await hotPool.query('SELECT NOW() as time, version() as version');
  console.log('✅ Database connection successful');
  console.log('Time:', result.rows[0].time);
  console.log('Version:', result.rows[0].version.split(' ')[0]);
} catch (error) {
  console.error('❌ Database connection failed:', error.message);
  console.error('Error code:', error.code);
  
  // Try to rebuild if local pool is missing
  if (!getLocalPool() && config) {
    console.log('\n🔄 Attempting to rebuild local pool...');
    try {
      await rebuildPool();
      console.log('✅ Local pool rebuilt successfully');
      
      // Test again
      const result = await hotPool.query('SELECT NOW() as time');
      console.log('✅ Database connection successful after rebuild');
      console.log('Time:', result.rows[0].time);
    } catch (rebuildError) {
      console.error('❌ Pool rebuild failed:', rebuildError.message);
    }
  }
}

console.log('\n🔍 Test complete.');