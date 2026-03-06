import pool from '../config/database.js';

function deriveFallbackEmail(auth0Id) {
    const safe = String(auth0Id || "")
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return safe ? `${safe}@no-email.local` : null;
}

export const UserModel = {
    // Find or create user from Auth0 data
    async findOrCreate(auth0User) {
        const { sub: auth0_id, email, name, picture } = auth0User;
        const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
        const safeEmailForCreate = normalizedEmail || deriveFallbackEmail(auth0_id);

        if (!auth0_id) {
            throw new Error("Missing auth0_id in findOrCreate");
        }
        if (!safeEmailForCreate) {
            throw new Error("Missing email and unable to derive fallback email");
        }

        try {
            // Check if user exists
            const existingUser = await pool.query(
                'SELECT * FROM users WHERE auth0_id = $1',
                [auth0_id]
            );

            if (existingUser.rows.length > 0) {
                // update last_login + sync basisvelden (optioneel maar handig)
                const updated = await pool.query(
                    `UPDATE users
         SET last_login = NOW(),
             email = COALESCE($2, email),
             name = COALESCE($3, name),
             picture = COALESCE($4, picture)
         WHERE auth0_id = $1
         RETURNING *`,
                    [auth0_id, normalizedEmail || null, name, picture]
                );
                return updated.rows[0];
            }
            // Create new user
            const newUser = await pool.query(
                `INSERT INTO users (auth0_id, email, name, picture, last_login)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING *`,
                [auth0_id, safeEmailForCreate, name, picture]
            );

            return newUser.rows[0];
        } catch (error) {
            console.error('Error in findOrCreate:', error);
            throw error;
        }
    },

    async getById(id) {
        const result = await pool.query(
            'SELECT * FROM users WHERE id = $1',
            [id]
        );
        return result.rows[0];
    },

    async getByAuth0Id(auth0_id) {
        const result = await pool.query(
            'SELECT * FROM users WHERE auth0_id = $1',
            [auth0_id]
        );
        return result.rows[0];
    }
};
