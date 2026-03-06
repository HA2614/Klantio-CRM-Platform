// backend/src/models/AdminUsers.js
import pool from "../config/database.js";

function roundToMs(d) {
    if (!d) return null;
    const dt = new Date(d);
    return Number.isNaN(dt.getTime()) ? null : dt;
}

export const AdminUsersModel = {
    async list() {
        const { rows } = await pool.query(
            `
      SELECT
        id,
        auth0_id,
        email,
        name,
        picture,
        created_at,
        updated_at,
        last_login,
        subscription_status,
        subscription_expires_at,
        blocked_reason,
        blocked_note,
        blocked_at,
        profile_picture_url
      FROM users
      ORDER BY id DESC
      `
        );
        return rows;
    },

    async getById(id) {
        const { rows } = await pool.query(
            `
      SELECT
        id,
        auth0_id,
        email,
        name,
        picture,
        created_at,
        updated_at,
        last_login,
        subscription_status,
        subscription_expires_at,
        blocked_reason,
        blocked_note,
        blocked_at,
        profile_picture_url
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
            [id]
        );
        return rows[0] || null;
    },

    async updateProfile(id, data) {
        const name = data?.name ?? null;
        const profilePictureUrl = data?.profile_picture_url ?? null;

        const { rows } = await pool.query(
            `
      UPDATE users
      SET name = $2,
          profile_picture_url = $3,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
            [id, name, profilePictureUrl]
        );
        return rows[0] || null;
    },

    async setBlocked(id, { blocked, reason, note }) {
        if (blocked) {
            const { rows } = await pool.query(
                `
        UPDATE users
        SET blocked_at = NOW(),
            blocked_reason = $2,
            blocked_note = $3,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
                [id, reason || "blocked_by_admin", note || null]
            );
            return rows[0] || null;
        }

        // unblock
        const { rows } = await pool.query(
            `
      UPDATE users
      SET blocked_at = NULL,
          blocked_reason = NULL,
          blocked_note = NULL,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
            [id]
        );
        return rows[0] || null;
    },

    // Extend subscription by delta seconds (can be negative, but you can block that in route)
    async extendSubscription(id, deltaSeconds) {
        const user = await this.getById(id);
        if (!user) return null;

        const now = new Date();
        const current = roundToMs(user.subscription_expires_at);

        // base = max(now, current) so "extend" from now if expired/null
        const base = current && current.getTime() > now.getTime() ? current : now;

        const next = new Date(base.getTime() + (Number(deltaSeconds) * 1000));

        const { rows } = await pool.query(
            `
      UPDATE users
      SET subscription_status = 'active',
          subscription_expires_at = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
            [id, next.toISOString()]
        );

        return rows[0] || null;
    }
};
