import { auth } from 'express-oauth2-jwt-bearer';
import { auth0Config } from '../config/auth0.js';

export const debugAuthHeader = (req, res, next) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return next();

    const parts = token.split(".");
    if (parts.length < 2) return next();

    try {
        const header = JSON.parse(Buffer.from(parts[0], "base64").toString("utf8"));
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
        console.log("AUTH TOKEN HEADER:", header);
        console.log("AUTH TOKEN PAYLOAD.permissions:", payload.permissions);
        console.log("AUTH TOKEN PAYLOAD.roles:", payload.roles);
    } catch {
        console.log("AUTH TOKEN: decode failed");
    }

    next();
};



// JWT validatie middleware
export const checkJwt = auth({
    audience: process.env.AUTH0_AUDIENCE,              // https://api.freelancercrm.local
    issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`, // https://lg01.eu.auth0.com
    tokenSigningAlg: "RS256",
});


// Permissions checker middleware
export const checkPermissions = (requiredPermissions) => {
    return (req, res, next) => {
        const permissions = req.auth?.payload?.permissions || [];

        const hasPermission = requiredPermissions.every(permission =>
            permissions.includes(permission)
        );

        if (!hasPermission) {
            return res.status(403).json({
                error: 'Insufficient permissions',
                required: requiredPermissions,
                actual: permissions
            });
        }

        next();
    };
};

// Error handler voor auth errors
export const handleAuthErrors = (err, req, res, next) => {
    if (err.name === 'UnauthorizedError') {
        return res.status(401).json({
            error: 'Invalid or expired token',
            message: err.message
        });
    }
    next(err);
};

export const checkAdmin = () => {
    return (req, res, next) => {
        const permissions = req.auth?.payload?.permissions || [];
        const roles = req.auth?.payload?.roles || []; // alleen als je roles in token zet

        const isAdmin =
            permissions.includes("admin:access") ||
            roles.includes("admin");

        if (!isAdmin) {
            return res.status(403).json({ error: "Admin only" });
        }

        next();
    };
};
