// backend/src/middleware/subscriptionMiddleware.js
import pool from "../config/database.js";

function hasAdminAccess(req) {
    const perms = req.auth?.payload?.permissions || [];
    return perms.includes("admin:access");
}

export async function requireActiveSubscription(req, res, next) {
    try {
        // admin mag altijd door
        if (hasAdminAccess(req)) return next();

        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: "No user context" });

        const { rows } = await pool.query(
            `SELECT subscription_expires_at, blocked_at, blocked_reason, blocked_note
       FROM users
       WHERE id = $1
       LIMIT 1`,
            [userId]
        );

        const u = rows[0];
        if (!u) return res.status(401).json({ error: "User not found" });

        const now = new Date();
        const expiresAt = u.subscription_expires_at ? new Date(u.subscription_expires_at) : null;

        const expired = expiresAt && expiresAt.getTime() < now.getTime();
        const blocked = !!u.blocked_at || expired;

        if (!blocked) return next();

        const reason = u.blocked_at ? (u.blocked_reason || "blocked_by_admin") : "subscription_expired";

        return res.status(403).json({
            blocked: true,
            reason,
            note: u.blocked_note || "Je hebt geen toegang. Je abonnement is verlopen of je account is geblokkeerd."
        });
    } catch (e) {
        console.error("requireActiveSubscription error:", e);
        return res.status(500).json({ error: "Subscription check failed" });
    }
}
