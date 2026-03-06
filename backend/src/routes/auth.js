import express from 'express';
import axios from 'axios';
import { authController } from '../controllers/authController.js';
import { checkJwt, checkPermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public routes
router.post('/password-reset', authController.requestPasswordReset);

// DEBUG: List all connections (admin only)
router.get('/connections', checkJwt, checkPermissions(['admin:access']), async (req, res) => {
    try {
        // Get Management API token
        const tokenResponse = await axios.post(
            `https://${process.env.AUTH0_DOMAIN}/oauth/token`,
            {
                client_id: process.env.AUTH0_MGMT_CLIENT_ID,
                client_secret: process.env.AUTH0_MGMT_CLIENT_SECRET,
                audience: `https://${process.env.AUTH0_DOMAIN}/api/v2/`,
                grant_type: 'client_credentials'
            }
        );

        const managementToken = tokenResponse.data.access_token;

        // Get connections
        const connections = await axios.get(
            `https://${process.env.AUTH0_DOMAIN}/api/v2/connections`,
            {
                headers: { Authorization: `Bearer ${managementToken}` }
            }
        );

        res.json(connections.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Protected routes
router.get('/userinfo', checkJwt, authController.getUserInfo);
router.get('/verify', checkJwt, authController.verifyToken);

export default router;
