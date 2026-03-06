import pool from "../config/database.js";

export const ContactsModel = {
    async list(userId) {
        const r = await pool.query(
            `SELECT *
       FROM contacts
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
            [userId]
        );
        return r.rows;
    },

    async create(userId, data) {
        const {
            name,
            email,
            phone,
            company,
            notes,

            opdrachtgever_type,
            contactpersoon,
            btw_nummer,
            kvk_nummer,
            betaaltermijn_dagen,
            standaard_uurtarief
        } = data;
        const safeName = String(name || "").trim();
        if (!safeName) {
            const err = new Error("name_required");
            err.code = "INVALID_CONTACT_NAME";
            throw err;
        }

        const r = await pool.query(
            `INSERT INTO contacts (
        user_id,
        name, email, phone, company, notes,
        opdrachtgever_type, contactpersoon, btw_nummer, kvk_nummer,
        betaaltermijn_dagen, standaard_uurtarief
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
            [
                userId,
                safeName,
                email || null,
                phone || null,
                company || null,
                notes || null,
                opdrachtgever_type || null,
                contactpersoon || null,
                btw_nummer || null,
                kvk_nummer || null,
                Number.isFinite(Number(betaaltermijn_dagen)) ? Number(betaaltermijn_dagen) : null,
                (standaard_uurtarief === "" || standaard_uurtarief == null) ? null : Number(standaard_uurtarief)
            ]
        );

        return r.rows[0];
    },

    async update(userId, id, data) {
        const {
            name,
            email,
            phone,
            company,
            notes,

            opdrachtgever_type,
            contactpersoon,
            btw_nummer,
            kvk_nummer,
            betaaltermijn_dagen,
            standaard_uurtarief
        } = data;
        const safeName = String(name || "").trim();
        if (!safeName) {
            const err = new Error("name_required");
            err.code = "INVALID_CONTACT_NAME";
            throw err;
        }

        const r = await pool.query(
            `UPDATE contacts
       SET
         name = $3,
         email = $4,
         phone = $5,
         company = $6,
         notes = $7,
         opdrachtgever_type = $8,
         contactpersoon = $9,
         btw_nummer = $10,
         kvk_nummer = $11,
         betaaltermijn_dagen = $12,
         standaard_uurtarief = $13
       WHERE user_id = $1 AND id = $2
       RETURNING *`,
            [
                userId,
                id,
                safeName,
                email || null,
                phone || null,
                company || null,
                notes || null,
                opdrachtgever_type || null,
                contactpersoon || null,
                btw_nummer || null,
                kvk_nummer || null,
                Number.isFinite(Number(betaaltermijn_dagen)) ? Number(betaaltermijn_dagen) : null,
                (standaard_uurtarief === "" || standaard_uurtarief == null) ? null : Number(standaard_uurtarief)
            ]
        );

        return r.rows[0] || null;
    },

    async remove(userId, id) {
        const r = await pool.query(
            `DELETE FROM contacts WHERE user_id = $1 AND id = $2 RETURNING id`,
            [userId, id]
        );
        return r.rows[0] || null;
    }
};
