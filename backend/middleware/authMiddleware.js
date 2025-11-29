import jwt from 'jsonwebtoken';

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    console.log('⚠️  No token provided for protected endpoint:', req.path);
    return res.status(401).json({ 
      success: false,
      message: 'Access token required',
      code: 'NO_TOKEN'
    });
  }

  const primary = process.env.JWT_SECRET;
  const secondary = process.env.JWT_SECRET_ALT;

  if (!primary) {
    console.error('❌ JWT_SECRET not configured');
    return res.status(500).json({ 
      success: false,
      message: 'Server configuration error' 
    });
  }

  try {
    const user = jwt.verify(token, primary);
    req.user = user;
    console.log('✅ Token validated for user:', user.id || user.userId);
    return next();
  } catch (errPrimary) {
    // Check if it's an expired token error
    if (errPrimary.name === 'TokenExpiredError') {
      console.log('⏰ Token expired for user:', errPrimary.expiredAt);
      return res.status(401).json({
        success: false,
        message: 'Token expired - please login again',
        code: 'TOKEN_EXPIRED'
      });
    }
    
    if (secondary) {
      try {
        const userAlt = jwt.verify(token, secondary);
        req.user = userAlt;
        console.log('✅ Token validated with secondary secret for user:', userAlt.id || userAlt.userId);
        return next();
      } catch (errAlt) {
        console.log('❌ Token validation failed with both secrets');
        return res.status(403).json({
          success: false,
          message: 'Invalid or expired token',
          code: 'INVALID_TOKEN'
        });
      }
    }
    console.log('❌ Token validation failed:', errPrimary.message);
    return res.status(403).json({
      success: false,
      message: 'Invalid or expired token',
      code: 'INVALID_TOKEN'
    });
  }
};
