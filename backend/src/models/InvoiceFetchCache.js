import { db } from "../config/database.js";

let ensurePromise = null;
let ensureDone = false;

async function ensureTable() {
    if (ensureDone) return;
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await db.query(`
                CREATE TABLE IF NOT EXISTS invoice_fetch_cache (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    source_key TEXT NOT NULL,
                    source_url TEXT NULL,
                    source_year INTEGER NULL,
                    invoice_number TEXT NULL,
                    invoice_id INTEGER NULL REFERENCES invoices(id) ON DELETE SET NULL,
                    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (user_id, source_key)
                )
            `);

            await db.query(`
                CREATE INDEX IF NOT EXISTS idx_invoice_fetch_cache_user_year
                ON invoice_fetch_cache (user_id, source_year, fetched_at DESC)
            `);

            ensureDone = true;
        })().catch((err) => {
            ensurePromise = null;
            throw err;
        });
    }
    await ensurePromise;
}

function assertUserId(userId) {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) {
        throw new Error("Invalid user id");
    }
    return uid;
}

function normalizeKey(key) {
    const out = String(key || "").trim();
    if (!out) throw new Error("Cache key is verplicht");
    if (out.length > 255) throw new Error("Cache key is te lang");
    return out;
}

export const InvoiceFetchCacheModel = {
    async hasKey(userId, key) {
        await ensureTable();
        const uid = assertUserId(userId);
        const sourceKey = normalizeKey(key);

        const { rowCount } = await db.query(
            `
            SELECT 1
            FROM invoice_fetch_cache
            WHERE user_id=$1 AND source_key=$2
            LIMIT 1
            `,
            [uid, sourceKey]
        );

        return rowCount > 0;
    },

    async hasAnyKeys(userId, keys) {
        await ensureTable();
        const uid = assertUserId(userId);

        const cleanKeys = Array.from(
            new Set((Array.isArray(keys) ? keys : []).map((k) => String(k || "").trim()).filter(Boolean))
        );

        if (!cleanKeys.length) return new Set();

        const { rows } = await db.query(
            `
            SELECT source_key
            FROM invoice_fetch_cache
            WHERE user_id=$1
              AND source_key = ANY($2::text[])
            `,
            [uid, cleanKeys]
        );

        return new Set(rows.map((r) => String(r.source_key)));
    },

    async markFetched(userId, data) {
        await ensureTable();
        const uid = assertUserId(userId);
        const sourceKey = normalizeKey(data?.sourceKey);

        const sourceUrlRaw = data?.sourceUrl == null ? null : String(data.sourceUrl).trim();
        const sourceUrl = sourceUrlRaw ? sourceUrlRaw.slice(0, 3000) : null;

        const sourceYearNum = Number(data?.sourceYear);
        const sourceYear = Number.isInteger(sourceYearNum) ? sourceYearNum : null;

        const invoiceNumberRaw = data?.invoiceNumber == null ? null : String(data.invoiceNumber).trim();
        const invoiceNumber = invoiceNumberRaw ? invoiceNumberRaw.slice(0, 200) : null;

        const invoiceIdNum = Number(data?.invoiceId);
        const invoiceId = Number.isInteger(invoiceIdNum) && invoiceIdNum > 0 ? invoiceIdNum : null;

        const { rows } = await db.query(
            `
            INSERT INTO invoice_fetch_cache (
                user_id, source_key, source_url, source_year, invoice_number, invoice_id, fetched_at, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            ON CONFLICT (user_id, source_key) DO UPDATE
            SET
                source_url = COALESCE(EXCLUDED.source_url, invoice_fetch_cache.source_url),
                source_year = COALESCE(EXCLUDED.source_year, invoice_fetch_cache.source_year),
                invoice_number = COALESCE(EXCLUDED.invoice_number, invoice_fetch_cache.invoice_number),
                invoice_id = COALESCE(EXCLUDED.invoice_id, invoice_fetch_cache.invoice_id),
                fetched_at = NOW()
            RETURNING *
            `,
            [uid, sourceKey, sourceUrl, sourceYear, invoiceNumber, invoiceId]
        );

        return rows[0];
    },
};

export default InvoiceFetchCacheModel;
