#!/usr/bin/env node

// Database setup script for Electron packaged app
import fs from 'fs';
import path from 'path';
import os from 'os';

const userData = process.env.CONFIG_DIR || path.join(os.homedir(), 'AppData', 'Roaming', 'whatsapp-blast', 'config');

console.log('🔧 Setting up database configuration for packaged app...');

// Ensure config directory exists
try {
  fs.mkdirSync(userData, { recursive: true });
  console.log('✅ Config directory created:', userData);
} catch (err) {
  console.error('❌ Failed to create config directory:', err.message);
  process.exit(1);
}

const dbConfigPath = path.join(userData, 'database_config.json');

// Check if config already exists
if (fs.existsSync(dbConfigPath)) {
  console.log('✅ Database config already exists at:', dbConfigPath);
  try {
    const config = JSON.parse(fs.readFileSync(dbConfigPath, 'utf8'));
    console.log('📋 Current config:', {
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      hasPassword: !!config.password
    });
  } catch (err) {
    console.error('❌ Failed to read existing config:', err.message);
  }
  return;
}

// Default database configuration
const defaultConfig = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'admin',
  database: 'whatsapp_blast',
  ssl: false,
  updatedAt: new Date().toISOString()
};

try {
  fs.writeFileSync(dbConfigPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
  console.log('✅ Database config created at:', dbConfigPath);
  console.log('📋 Default configuration:', {
    host: defaultConfig.host,
    port: defaultConfig.port,
    user: defaultConfig.user,
    database: defaultConfig.database,
    hasPassword: !!defaultConfig.password
  });
  console.log('\n🔑 You can update these values in the config file if needed.');
} catch (err) {
  console.error('❌ Failed to create database config:', err.message);
  process.exit(1);
}

console.log('\n✅ Database setup complete!');