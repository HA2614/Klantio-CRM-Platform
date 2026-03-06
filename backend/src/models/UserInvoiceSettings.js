import { db } from "../config/database.js";

let ensurePromise = null;
let ensureDone = false;

function normalizeInvoicingLink(input) {
    const value = String(input || "").trim();
    if (!value) return null;
    if (value.length > 2000) {
        throw new Error("Invoicing link is te lang (max 2000 tekens).");
    }

    // Support {year} placeholder for dynamic year substitution.
    const probe = value.replace(/\{year\}/g, "2026");
    let parsed;
    try {
        parsed = new URL(probe);
    } catch {
        throw new Error("Invoicing link moet een geldige http(s) URL zijn.");
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
        throw new Error("Invoicing link moet beginnen met http:// of https://.");
    }

    return value;
}

async function ensureTable() {
    if (ensureDone) return;
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await db.query(`
                CREATE TABLE IF NOT EXISTS user_invoice_settings (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    invoicing_link TEXT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            ensureDone = true;
        })().catch((err) => {
            ensurePromise = null;
            throw err;
        });
    }
    await ensurePromise;
}

export const UserInvoiceSettingsModel = {
    async getByUserId(userId) {
        await ensureTable();
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) {
            throw new Error("Invalid user id");
        }

        const { rows } = await db.query(
            `
            SELECT user_id, invoicing_link, updated_at
            FROM user_invoice_settings
            WHERE user_id=$1
            LIMIT 1
            `,
            [uid]
        );

        if (!rows[0]) {
            return {
                user_id: uid,
                invoicing_link: null,
                updated_at: null,
            };
        }

        return rows[0];
    },

    async upsertByUserId(userId, data) {
        await ensureTable();
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) {
            throw new Error("Invalid user id");
        }

        const invoicingLink = normalizeInvoicingLink(data?.invoicing_link);

        const { rows } = await db.query(
            `
            INSERT INTO user_invoice_settings (user_id, invoicing_link, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (user_id) DO UPDATE
            SET
                invoicing_link = EXCLUDED.invoicing_link,
                updated_at = NOW()
            RETURNING user_id, invoicing_link, updated_at
            `,
            [uid, invoicingLink]
        );

        return rows[0];
    },
};

export default UserInvoiceSettingsModel;
