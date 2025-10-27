const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('WhatsApp Bulker Sender - Local Database Setup');
console.log('===========================================');
console.log('This script will set up the local PostgreSQL database');
console.log('for campaign data, contacts, logs, and dashboard.');
console.log('The Render connection for authentication and coins is configured separately.');
console.log('\n');

// Function to execute commands
function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

// Function to check if PostgreSQL is installed
async function checkPostgresInstallation() {
  try {
    await runCommand('psql --version');
    console.log('✅ PostgreSQL is installed');
    return true;
  } catch (error) {
    console.log('❌ PostgreSQL is not installed or not in PATH');
    console.log('Please install PostgreSQL from: https://www.postgresql.org/download/');
    return false;
  }
}

// Function to create database
async function createDatabase(password) {
  try {
    const dbName = 'whatsappbulkerdesktop';
    
    // Set PGPASSWORD environment variable for the command
    const createDbCommand = `set "PGPASSWORD=${password}" && createdb -U postgres ${dbName}`;
    
    try {
      await runCommand(createDbCommand);
      console.log(`✅ Database '${dbName}' created successfully`);
      return true;
    } catch (error) {
      // Check if error is because database already exists
      if (error.message.includes('already exists')) {
        console.log(`✅ Database '${dbName}' already exists`);
        return true;
      }
      throw error;
    }
  } catch (error) {
    console.log('❌ Failed to create database:', error.message);
    return false;
  }
}

// Function to update local_db.json
function updateLocalDbConfig(password) {
  const configPath = path.join(__dirname, 'backend', 'local_db.json');
  
  const config = {
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: password,
    database: 'whatsappbulkerdesktop',
    ssl: false
  };
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('✅ Local database configuration updated successfully');
    return true;
  } catch (error) {
    console.log('❌ Failed to update local database configuration:', error.message);
    return false;
  }
}

// Main function
async function main() {
  try {
    console.log('Setting up LOCAL PostgreSQL database for:');
    console.log('- Contacts');
    console.log('- Campaigns');
    console.log('- Logs');
    console.log('- Dashboard');
    console.log('\nNote: Authentication and coin management use the Render backend');
    console.log('      and are configured separately in the .env file.\n');
    
    // Check PostgreSQL installation
    const isPostgresInstalled = await checkPostgresInstallation();
    if (!isPostgresInstalled) {
      rl.close();
      return;
    }
    
    // Get PostgreSQL password
    rl.question('Enter your PostgreSQL password for user "postgres": ', async (password) => {
      // Create database
      const isDatabaseCreated = await createDatabase(password);
      if (!isDatabaseCreated) {
        rl.close();
        return;
      }
      
      // Update local_db.json
      const isConfigUpdated = updateLocalDbConfig(password);
      if (!isConfigUpdated) {
        rl.close();
        return;
      }
      
      console.log('\n✅ Local database setup completed successfully!');
      console.log('You can now start the WhatsApp Bulker Sender application.');
      rl.close();
    });
  } catch (error) {
    console.log('❌ Setup failed:', error.message);
    rl.close();
  }
}

main();