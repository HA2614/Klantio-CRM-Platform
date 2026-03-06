// backend/src/models/Attachments.js
import pool from "../config/database.js";

export const AttachmentsModel = {
    async list(userId, entityType, entityId) {
        const { rows } = await pool.query(
            `
      SELECT
        id,
        user_id,
        entity_type,
        entity_id,
        original_name,
        stored_name,
        mime_type,
        size_bytes,
        storage_path,
        created_at
      FROM attachments
      WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3
      ORDER BY created_at DESC
      `,
            [userId, entityType, entityId]
        );
        return rows;
    },

    async getById(userId, id) {
        const { rows } = await pool.query(
            `
      SELECT
        id,
        user_id,
        entity_type,
        entity_id,
        original_name,
        stored_name,
        mime_type,
        size_bytes,
        storage_path,
        created_at
      FROM attachments
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
            [id, userId]
        );
        return rows[0] || null;
    },

    async create(userId, entityType, entityId, file) {
        // Multer fields:
        // file.originalname, file.filename, file.mimetype, file.size, file.path
        const originalName = String(file?.originalname || "");
        const storedName = String(file?.filename || "");
        const mimeType = String(file?.mimetype || "application/octet-stream");
        const sizeBytes = Number(file?.size || 0);
        const storagePath = String(file?.path || "");

        if (!originalName || !storedName || !storagePath || !Number.isFinite(sizeBytes)) {
            throw new Error("Invalid file payload from multer (missing originalname/filename/path/size)");
        }

        const { rows } = await pool.query(
            `
      INSERT INTO attachments
        (user_id, entity_type, entity_id, original_name, stored_name, mime_type, size_bytes, storage_path)
      VALUES
        ($1,      $2,          $3,        $4,            $5,          $6,        $7,        $8)
      RETURNING
        id,
        user_id,
        entity_type,
        entity_id,
        original_name,
        stored_name,
        mime_type,
        size_bytes,
        storage_path,
        created_at
      `,
            [userId, entityType, entityId, originalName, storedName, mimeType, sizeBytes, storagePath]
        );

        return rows[0];
    },

    async remove(userId, id) {
        const { rows } = await pool.query(
            `
    DELETE FROM attachments
    WHERE id = $1 AND user_id = $2
    RETURNING id, storage_path, original_name, stored_name, mime_type
    `,
            [id, userId]
        );

        return rows[0] || null;
    }

};

