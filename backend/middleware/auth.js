import jwt from 'jsonwebtoken';
import { hostPool, hotPool } from '../src/db.js';

const pool = hostPool || hotPool;

// Verify JWT token
export const verifyToken = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: 'Access denied. No token provided.' 
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user from database
    const userQuery = await pool.query(
      'SELECT id, username, email, role, coins, is_active FROM users WHERE id = $1',
      [decoded.userId || decoded.id]
    );

    if (userQuery.rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid token. User not found.' 
      });
    }

    const user = userQuery.rows[0];
    
    if (!user.is_active) {
      return res.status(401).json({ 
        success: false, 
        message: 'Account is deactivated.' 
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ 
      success: false, 
      message: 'Invalid token.' 
    });
  }
};

// Check if user is admin
export const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      message: 'Access denied. Admin privileges required.' 
    });
  }
  next();
};

// Check if user has sufficient coins
export const checkCoins = (requiredCoins) => {
  return (req, res, next) => {
    if (req.user.coins < requiredCoins) {
      return res.status(400).json({ 
        success: false, 
        message: `Insufficient coins. Required: ${requiredCoins}, Available: ${req.user.coins}` 
      });
    }
    next();
  };
};