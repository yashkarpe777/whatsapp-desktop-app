import { getLocalPool, isLocalDbDisabled } from '../db.js';

// Middleware to check if local database is available
export const requireLocalDB = (req, res, next) => {
  if (isLocalDbDisabled()) {
    return res.status(503).json({
      success: false,
      error: 'LOCAL_DB_DISABLED',
      message: 'Local database is disabled in this build. Please connect to hosted API.',
      action: 'use_remote_api'
    });
  }
  const localPool = getLocalPool();
  if (!localPool) {
    return res.status(503).json({
      success: false,
      error: 'LOCAL_DB_NOT_CONFIGURED',
      message: 'Local database is not configured. Please configure your database settings in Settings page.',
      action: 'configure_database'
    });
  }

  // Test connection
  localPool.query('SELECT 1')
    .then(() => {
      next();
    })
    .catch((error) => {
      console.error('Local database connection failed:', error.message);
      return res.status(503).json({
        success: false,
        error: 'LOCAL_DB_CONNECTION_FAILED',
        message: 'Local database connection failed. Please check your database settings.',
        action: 'check_database_settings',
        details: error.message
      });
    });
};

// Middleware to check if local database is available (non-blocking)
export const checkLocalDB = (req, res, next) => {
  if (isLocalDbDisabled()) {
    req.localDbAvailable = false;
    return next();
  }
  const localPool = getLocalPool();
  if (!localPool) {
    req.localDbAvailable = false;
    return next();
  }

  localPool.query('SELECT 1')
    .then(() => {
      req.localDbAvailable = true;
      next();
    })
    .catch((error) => {
      console.warn('Local database check failed:', error.message);
      req.localDbAvailable = false;
      next();
    });
};