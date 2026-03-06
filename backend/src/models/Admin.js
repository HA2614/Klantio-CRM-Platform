// backend/src/models/Admin.js
import pool from "../config/database.js";

export const AdminModel = {
    async listUsers(q, limit = 50) {
        const query = String(q || "").trim();
        const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);

        if (!query) {
            const { rows } = await pool.query(
                `SELECT id, auth0_id, email, name,
                subscription_status, subscription_expires_at,
                blocked_reason, blocked_note, blocked_at,
                profile_picture_url,
                created_at, last_login
         FROM users
         ORDER BY id DESC
         LIMIT $1`,
                [lim]
            );
            return rows;
        }

        // ILIKE + prepared params => veilig
        const like = `%${query}%`;
        const { rows } = await pool.query(
            `SELECT id, auth0_id, email, name,
              subscription_status, subscription_expires_at,
              blocked_reason, blocked_note, blocked_at,
              profile_picture_url,
              created_at, last_login
       FROM users
       WHERE email ILIKE $1
          OR name ILIKE $1
          OR auth0_id ILIKE $1
       ORDER BY id DESC
       LIMIT $2`,
            [like, lim]
        );
        return rows;
    },

    async getUserById(id) {
        const { rows } = await pool.query(
            `SELECT id, auth0_id, email, name,
              subscription_status, subscription_expires_at,
              blocked_reason, blocked_note, blocked_at,
              profile_picture_url
       FROM users
       WHERE id = $1
       LIMIT 1`,
            [id]
        );
        return rows[0] || null;
    },

    async extendSubscription(id, secondsToAdd) {
        // Als expires_at leeg is, neem nu als basis.
        // Als verlopen is, ook vanaf nu.
        const { rows } = await pool.query(
            `UPDATE users
       SET subscription_expires_at =
           CASE
             WHEN subscription_expires_at IS NULL THEN NOW() + ($2 * INTERVAL '1 second')
             WHEN subscription_expires_at < NOW() THEN NOW() + ($2 * INTERVAL '1 second')
             ELSE subscription_expires_at + ($2 * INTERVAL '1 second')
           END,
           subscription_status = 'active',
           blocked_at = NULL,
           blocked_reason = NULL
       WHERE id = $1
       RETURNING id, auth0_id, email, name,
                 subscription_status, subscription_expires_at,
                 blocked_reason, blocked_note, blocked_at,
                 profile_picture_url`,
            [id, secondsToAdd]
        );
        return rows[0] || null;
    },

    async setBlocked(id, blocked, reason, note) {
        const { rows } = await pool.query(
            `UPDATE users
       SET blocked_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
           blocked_reason = CASE WHEN $2 THEN $3 ELSE NULL END,
           blocked_note = CASE WHEN $2 THEN $4 ELSE blocked_note END
       WHERE id = $1
       RETURNING id, auth0_id, email, name,
                 subscription_status, subscription_expires_at,
                 blocked_reason, blocked_note, blocked_at,
                 profile_picture_url`,
            [id, !!blocked, reason || "blocked_by_admin", note || null]
        );
        return rows[0] || null;
    },

    async updateProfile(id, patch) {
        const {
            name = null,
            profile_picture_url = null,
            subscription_expires_at = null,
            blocked_note = null
        } = patch || {};

        const { rows } = await pool.query(
            `UPDATE users
       SET name = COALESCE($2, name),
           profile_picture_url = COALESCE($3, profile_picture_url),
           subscription_expires_at = COALESCE($4, subscription_expires_at),
           blocked_note = COALESCE($5, blocked_note)
       WHERE id = $1
       RETURNING id, auth0_id, email, name,
                 subscription_status, subscription_expires_at,
                 blocked_reason, blocked_note, blocked_at,
                 profile_picture_url`,
            [id, name, profile_picture_url, subscription_expires_at, blocked_note]
        );

        return rows[0] || null;
    }
};
