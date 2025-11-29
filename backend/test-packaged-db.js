#!/usr/bin/env node

// Test script to verify database connection in packaged app
import { databaseConfig } from './src/databaseConfig.js';
import { hotPool, getLocalPool, hostPool } from './src/db.js';

console.log('🔍 Testing packaged app database connection...\n');

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
}

console.log('\n🔍 Test complete.');