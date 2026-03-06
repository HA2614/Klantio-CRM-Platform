// backend/src/models/Notes.js
import pool from "../config/database.js";

export const NotesModel = {
    async list(userId, entityType, entityId) {
        const { rows } = await pool.query(
            `
      SELECT id, user_id, entity_type, entity_id, body, created_at
      FROM notes
      WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3
      ORDER BY created_at DESC
      `,
            [userId, entityType, entityId]
        );
        return rows;
    },

    async create(userId, entityType, entityId, body) {
        const { rows } = await pool.query(
            `
      INSERT INTO notes (user_id, entity_type, entity_id, body)
      VALUES ($1, $2, $3, $4)
      RETURNING id, user_id, entity_type, entity_id, body, created_at
      `,
            [userId, entityType, entityId, body]
        );
        return rows[0];
    },

    async update(userId, noteId, body) {
        const { rows } = await pool.query(
            `
      UPDATE notes
      SET body = $1
      WHERE id = $2 AND user_id = $3
      RETURNING id, user_id, entity_type, entity_id, body, created_at
      `,
            [body, noteId, userId]
        );
        return rows[0] || null;
    },

    async remove(userId, noteId) {
        const { rowCount } = await pool.query(
            `DELETE FROM notes WHERE id = $1 AND user_id = $2`,
            [noteId, userId]
        );
        return rowCount > 0;
    }
};
