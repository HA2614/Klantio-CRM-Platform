// src/models/Invoices.js
import { db } from "../config/database.js";

function normalizeAmount(raw) {
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        const err = new Error("invalid_invoice_amount");
        err.code = "INVALID_INVOICE_AMOUNT";
        throw err;
    }
    if (n < 0) {
        const err = new Error("negative_invoice_amount");
        err.code = "NEGATIVE_INVOICE_AMOUNT";
        throw err;
    }
    return n;
}

/**
 * InvoicesModel
 * - list/create/update/remove/removeCascade
 * - scan_json opslaan
 * - month cache + month totals helpers
 */
export const InvoicesModel = {
    async list(userId) {
        const { rows } = await db.query(
            `
      SELECT
        i.*,
        p.name AS project_name,
        c.name AS contact_name
      FROM invoices i
      LEFT JOIN projects p ON p.id = i.project_id AND p.user_id = i.user_id
      LEFT JOIN contacts c ON c.id = i.contact_id AND c.user_id = i.user_id
      WHERE i.user_id = $1
      ORDER BY i.created_at DESC
      `,
            [userId]
        );
        return rows;
    },

    async getById(userId, id) {
        const { rows } = await db.query(
            `SELECT * FROM invoices WHERE user_id=$1 AND id=$2 LIMIT 1`,
            [userId, id]
        );
        return rows[0] || null;
    },

    async create(userId, data) {
        const {
            invoice_number,
            status,
            amount,
            issue_date,
            due_date,
            paid_date,
            notes,
            project_id,
            contact_id,
            scan_json,
        } = data;
        const safeAmount = normalizeAmount(amount);

        const { rows } = await db.query(
            `
      INSERT INTO invoices (
        user_id, invoice_number, status, amount,
        issue_date, due_date, paid_date,
        notes, project_id, contact_id, scan_json
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
            [
                userId,
                invoice_number,
                status || "draft",
                safeAmount,
                issue_date,
                due_date,
                paid_date || null,
                notes || null,
                project_id || null,
                contact_id || null,
                scan_json ? JSON.stringify(scan_json) : null,
            ]
        );

        return rows[0];
    },

    async update(userId, id, data) {
        const existing = await this.getById(userId, id);
        if (!existing) return null;
        const safeAmount =
            data.amount === undefined ? existing.amount : normalizeAmount(data.amount);

        const next = {
            invoice_number: data.invoice_number ?? existing.invoice_number,
            status: data.status ?? existing.status,
            amount: safeAmount,
            issue_date: data.issue_date ?? existing.issue_date,
            due_date: data.due_date ?? existing.due_date,
            paid_date:
                data.paid_date === undefined ? existing.paid_date : data.paid_date,
            notes: data.notes === undefined ? existing.notes : data.notes,
            project_id:
                data.project_id === undefined ? existing.project_id : data.project_id,
            contact_id:
                data.contact_id === undefined ? existing.contact_id : data.contact_id,
            scan_json:
                data.scan_json === undefined ? existing.scan_json : data.scan_json,
        };

        const { rows } = await db.query(
            `
      UPDATE invoices
      SET
        invoice_number=$3,
        status=$4,
        amount=$5,
        issue_date=$6,
        due_date=$7,
        paid_date=$8,
        notes=$9,
        project_id=$10,
        contact_id=$11,
        scan_json=$12,
        updated_at=NOW()
      WHERE user_id=$1 AND id=$2
      RETURNING *
      `,
            [
                userId,
                id,
                next.invoice_number,
                next.status,
                next.amount,
                next.issue_date,
                next.due_date,
                next.paid_date,
                next.notes,
                next.project_id,
                next.contact_id,
                typeof next.scan_json === "string"
                    ? next.scan_json
                    : next.scan_json
                        ? JSON.stringify(next.scan_json)
                        : null,
            ]
        );

        return rows[0] || null;
    },

    async remove(userId, id) {
        const { rows } = await db.query(
            `DELETE FROM invoices WHERE user_id=$1 AND id=$2 RETURNING id`,
            [userId, id]
        );
        return rows[0] || null;
    },

    async removeCascade(userId, id) {
        // Invoice verwijderen + gekoppelde project verwijderen (zoals UI belooft).
        const inv = await this.getById(userId, id);
        if (!inv) return null;

        // Eerst project verwijderen zodat constraints op project->invoice niet afgaan
        // via FK ON DELETE SET NULL op invoice delete.
        if (inv.project_id) {
            await db.query(
                `
        DELETE FROM projects
        WHERE user_id=$1 AND id=$2
        `,
                [userId, inv.project_id]
            );
        }

        const deleted = await this.remove(userId, id);
        return { invoice_id: deleted?.id || id, project_id: inv.project_id || null };
    },

    /**
     * Belangrijk: deze wordt gebruikt door projectInvoiceLink (upload+scan)
     */
    async createOrUpdateByNumber(userId, data) {
        const invoiceNumber = String(data.invoice_number || "").trim();
        if (!invoiceNumber) throw new Error("invoice_number is required");

        const { rows: found } = await db.query(
            `
      SELECT * FROM invoices
      WHERE user_id=$1 AND invoice_number=$2
      LIMIT 1
      `,
            [userId, invoiceNumber]
        );

        if (!found.length) {
            return this.create(userId, data);
        }

        const existing = found[0];
        return this.update(userId, existing.id, data);
    },

    // ------------------------------
    // MONTH CACHE + TOTALS
    // ------------------------------

    async upsertMonthCache(userId, rows) {
        // rows: [{year, month, invoice_count, total_amount}]
        // tabel: invoice_month_cache(user_id, year, month, invoice_count, total_amount, updated_at)
        if (!Array.isArray(rows) || rows.length === 0) return { ok: true };

        await db.query("BEGIN");
        try {
            for (const r of rows) {
                await db.query(
                    `
          INSERT INTO invoice_month_cache (user_id, year, month, invoice_count, total_amount, updated_at)
          VALUES ($1,$2,$3,$4,$5,NOW())
          ON CONFLICT (user_id, year, month)
          DO UPDATE SET
            invoice_count=EXCLUDED.invoice_count,
            total_amount=EXCLUDED.total_amount,
            updated_at=NOW()
          `,
                    [
                        userId,
                        Number(r.year),
                        Number(r.month),
                        Number(r.invoice_count || 0),
                        Number(r.total_amount || 0),
                    ]
                );
            }
            await db.query("COMMIT");
            return { ok: true };
        } catch (e) {
            try {
                await db.query("ROLLBACK");
            } catch {
                // ignore rollback errors
            }

            // invoice_month_cache bestaat mogelijk nog niet in oudere omgevingen
            if (e?.code === "42P01") return { ok: true, skipped: true };
            throw e;
        }
    },

    async listMonthCache(userId, fromYear = 2020) {
        const currentYear = new Date().getUTCFullYear();
        const safeFromYear = Math.max(
            2000,
            Math.min(Number(fromYear) || 2020, currentYear)
        );

        try {
            const { rows } = await db.query(
                `
        WITH months AS (
          SELECT
            EXTRACT(YEAR FROM gs.month_start)::int AS year,
            EXTRACT(MONTH FROM gs.month_start)::int AS month
          FROM generate_series(
            make_date($2, 1, 1)::date,
            date_trunc('month', NOW()::date)::date,
            interval '1 month'
          ) AS gs(month_start)
        )
        SELECT
          m.year,
          m.month,
          COALESCE(c.invoice_count, 0)::int AS invoice_count,
          COALESCE(c.total_amount, 0)::numeric AS total_amount,
          c.updated_at
        FROM months m
        LEFT JOIN invoice_month_cache c
          ON c.user_id=$1 AND c.year=m.year AND c.month=m.month
        ORDER BY m.year DESC, m.month DESC
        `,
                [userId, safeFromYear]
            );

            return rows;
        } catch (e) {
            if (e?.code !== "42P01") throw e;

            // Fallback zonder cache-tabel
            const { rows } = await db.query(
                `
        WITH months AS (
          SELECT
            EXTRACT(YEAR FROM gs.month_start)::int AS year,
            EXTRACT(MONTH FROM gs.month_start)::int AS month
          FROM generate_series(
            make_date($2, 1, 1)::date,
            date_trunc('month', NOW()::date)::date,
            interval '1 month'
          ) AS gs(month_start)
        ),
        totals AS (
          SELECT
            EXTRACT(YEAR FROM COALESCE(i.paid_date, i.issue_date))::int AS year,
            EXTRACT(MONTH FROM COALESCE(i.paid_date, i.issue_date))::int AS month,
            COUNT(*)::int AS invoice_count,
            COALESCE(SUM(i.amount), 0)::numeric AS total_amount
          FROM invoices i
          WHERE i.user_id=$1
            AND i.status='paid'
            AND EXTRACT(YEAR FROM COALESCE(i.paid_date, i.issue_date))::int >= $2
          GROUP BY 1, 2
        )
        SELECT
          m.year,
          m.month,
          COALESCE(t.invoice_count, 0)::int AS invoice_count,
          COALESCE(t.total_amount, 0)::numeric AS total_amount,
          NULL::timestamptz AS updated_at
        FROM months m
        LEFT JOIN totals t
          ON t.year=m.year AND t.month=m.month
        ORDER BY m.year DESC, m.month DESC
        `,
                [userId, safeFromYear]
            );

            return rows;
        }
    },

    async computeMonthTotals(userId, fromYear = 2020) {
        // “Ontvangen” = facturen met status paid (optioneel: paid_date in maand)
        // We nemen paid_date als beschikbaar, anders issue_date fallback.
        const { rows } = await db.query(
            `
      SELECT
        EXTRACT(YEAR FROM COALESCE(paid_date, issue_date))::int AS year,
        EXTRACT(MONTH FROM COALESCE(paid_date, issue_date))::int AS month,
        COUNT(*)::int AS invoice_count,
        COALESCE(SUM(amount), 0)::numeric AS total_amount
      FROM invoices
      WHERE user_id=$1
        AND status = 'paid'
        AND EXTRACT(YEAR FROM COALESCE(paid_date, issue_date))::int >= $2
      GROUP BY 1,2
      ORDER BY 1 DESC,2 DESC
      `,
            [userId, Number(fromYear)]
        );
        return rows;
    },

    async listByMonth(userId, year, month) {
        const safeYear = Number(year);
        const safeMonth = Number(month);
        if (!Number.isInteger(safeYear) || !Number.isInteger(safeMonth) || safeMonth < 1 || safeMonth > 12) {
            const err = new Error("invalid_year_or_month");
            err.code = "INVALID_INPUT";
            throw err;
        }

        const { rows } = await db.query(
            `
      SELECT
        i.*,
        c.name AS contact_name
      FROM invoices i
      LEFT JOIN contacts c ON c.id=i.contact_id AND c.user_id=i.user_id
      WHERE i.user_id=$1
        AND EXTRACT(YEAR FROM COALESCE(i.paid_date, i.issue_date))::int = $2
        AND EXTRACT(MONTH FROM COALESCE(i.paid_date, i.issue_date))::int = $3
        AND i.status='paid'
      ORDER BY COALESCE(i.paid_date, i.issue_date) DESC, i.created_at DESC
      `,
            [userId, safeYear, safeMonth]
        );
        return rows;
    },
};

export default InvoicesModel;
