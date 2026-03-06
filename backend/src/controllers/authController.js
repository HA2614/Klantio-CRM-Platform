import axios from 'axios';
import { auth0Config } from '../config/auth0.js';

export const authController = {
    // Get user info from Auth0
    async getUserInfo(req, res) {
        try {
            const token = req.headers.authorization?.split(' ')[1];

            const response = await axios.get(
                `https://${auth0Config.domain}/userinfo`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            );

            res.json(response.data);
        } catch (error) {
            res.status(500).json({
                error: 'Failed to fetch user info',
                details: error.message
            });
        }
    },

    // Request password reset
    async requestPasswordReset(req, res) {
        try {
            const { email } = req.body;

            if (!email) {
                return res.status(400).json({ error: 'Email is required' });
            }

            console.log('Requesting password reset for:', email);

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
            console.log('Management token obtained');

            // Eerst: zoek de database connection
            const connectionsResponse = await axios.get(
                `https://${process.env.AUTH0_DOMAIN}/api/v2/connections?strategy=auth0`,
                {
                    headers: { Authorization: `Bearer ${managementToken}` }
                }
            );

            if (!connectionsResponse.data || connectionsResponse.data.length === 0) {
                return res.status(500).json({
                    error: 'No database connection found',
                    hint: 'Create a database connection in Auth0 Dashboard → Authentication → Database'
                });
            }

            const connectionId = connectionsResponse.data[0].id;
            console.log('Using connection ID:', connectionId);

            // Trigger password reset
            const resetResponse = await axios.post(
                `https://${process.env.AUTH0_DOMAIN}/api/v2/tickets/password-change`,
                {
                    email: email,
                    connection_id: connectionId,  // ← Dit was missing!
                    ttl_sec: 86400
                },
                {
                    headers: {
                        Authorization: `Bearer ${managementToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log('Password reset ticket created:', resetResponse.data);

            res.json({
                message: 'If an account exists, password reset instructions were sent'
            });
        } catch (error) {
            console.error('Password reset error:', error.response?.data || error.message);
            if (error.response?.status === 404 && error.response?.data?.errorCode === 'inexistent_user') {
                return res.json({
                    message: 'If an account exists, password reset instructions were sent'
                });
            }

            res.status(500).json({ error: 'Failed to send password reset email' });
        }
    },

    // Verify token (voor debugging)
    verifyToken(req, res) {
        res.json({
            message: 'Token is valid',
            user: req.auth.payload
        });
    }
};
