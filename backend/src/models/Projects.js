// src/models/Projects.js
import { db } from "../config/database.js";

function pickPeriodStart(data, fallback = null) {
    if (data.period_start !== undefined) return data.period_start;
    if (data.periode_start !== undefined) return data.periode_start;
    return fallback;
}

function pickPeriodEnd(data, fallback = null) {
    if (data.period_end !== undefined) return data.period_end;
    if (data.periode_end !== undefined) return data.periode_end;
    return fallback;
}

function periodStartFromRow(row) {
    return row?.period_start ?? row?.periode_start ?? null;
}

function periodEndFromRow(row) {
    return row?.period_end ?? row?.periode_end ?? null;
}

function normalizeStatus(status, fallback = "gepland") {
    const s = String(status ?? fallback).trim().toLowerCase();
    return s || fallback;
}

function normalizeInvoiceId(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function requiresInvoiceIdForStatus(status) {
    return ["gefactureerd", "paid", "invoiced"].includes(String(status || "").toLowerCase());
}

export const ProjectsModel = {
    async list(userId) {
        const { rows } = await db.query(
            `
      SELECT
        p.*,
        p.period_start AS periode_start,
        p.period_end AS periode_end,
        c.name AS contact_name,
        c.company AS contact_company
      FROM projects p
      LEFT JOIN contacts c ON c.id = p.contact_id AND c.user_id = p.user_id
      WHERE p.user_id=$1
      ORDER BY COALESCE(p.period_start, p.created_at) DESC, p.created_at DESC
      `,
            [userId]
        );
        return rows;
    },

    async getById(userId, id) {
        const { rows } = await db.query(
            `
      SELECT
        *,
        period_start AS periode_start,
        period_end AS periode_end
      FROM projects
      WHERE user_id=$1 AND id=$2
      LIMIT 1
      `,
            [userId, id]
        );
        return rows[0] || null;
    },

    async create(userId, data) {
        const {
            name,
            description,
            status,
            start_date,
            end_date,
            budget,
            spent,
            contact_id,
            work_start,
            work_end,
            invoice_id,

            locatie,
            tarief_type,
            tarief,
            invoice_scan_json,
        } = data;

        const periodStart = pickPeriodStart(data, null);
        const periodEnd = pickPeriodEnd(data, periodStart);
        const safeStatus = normalizeStatus(status, "gepland");
        const safeInvoiceId = normalizeInvoiceId(invoice_id);

        if (requiresInvoiceIdForStatus(safeStatus) && !safeInvoiceId) {
            const err = new Error("invoice_id_required_for_status");
            err.code = "PROJECT_INVOICE_REQUIRED";
            throw err;
        }

        const { rows } = await db.query(
            `
      INSERT INTO projects (
        user_id, name, description, status,
        start_date, end_date,
        budget, spent, contact_id,
        work_start, work_end,
        invoice_id,
        locatie, tarief_type, tarief,
        period_start, period_end,
        invoice_scan_json
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *, period_start AS periode_start, period_end AS periode_end
      `,
            [
                userId,
                name,
                description || null,
                safeStatus,
                start_date || null,
                end_date || null,
                budget ?? null,
                spent ?? 0,
                contact_id ?? null,
                work_start || null,
                work_end || null,
                safeInvoiceId,
                locatie || null,
                tarief_type || null,
                tarief ?? null,
                periodStart || null,
                periodEnd || periodStart || null,
                invoice_scan_json ? JSON.stringify(invoice_scan_json) : null,
            ]
        );

        return rows[0];
    },

    async update(userId, id, data) {
        const existing = await this.getById(userId, id);
        if (!existing) return null;

        // Invoice link blijft behouden als frontend hem niet meestuurt
        const invoiceIdNextRaw =
            data.invoice_id === undefined ? existing.invoice_id : data.invoice_id;
        const invoiceIdNext = normalizeInvoiceId(invoiceIdNextRaw);

        const periodStartExisting = periodStartFromRow(existing);
        const periodEndExisting = periodEndFromRow(existing);

        const periodStartNext = pickPeriodStart(data, periodStartExisting);

        const periodEndInput = pickPeriodEnd(data, undefined);
        const periodEndNext =
            periodEndInput === undefined ? periodEndExisting : periodEndInput ?? periodStartNext;

        const next = {
            name: data.name ?? existing.name,
            description:
                data.description === undefined ? existing.description : data.description,
            status: normalizeStatus(data.status ?? existing.status, existing.status || "gepland"),

            start_date:
                data.start_date === undefined ? existing.start_date : data.start_date,
            end_date: data.end_date === undefined ? existing.end_date : data.end_date,

            budget: data.budget === undefined ? existing.budget : data.budget,
            spent: data.spent === undefined ? existing.spent : data.spent,

            contact_id:
                data.contact_id === undefined ? existing.contact_id : data.contact_id,

            work_start:
                data.work_start === undefined ? existing.work_start : data.work_start,
            work_end:
                data.work_end === undefined ? existing.work_end : data.work_end,

            invoice_id: invoiceIdNext,

            locatie: data.locatie === undefined ? existing.locatie : data.locatie,
            tarief_type:
                data.tarief_type === undefined ? existing.tarief_type : data.tarief_type,
            tarief: data.tarief === undefined ? existing.tarief : data.tarief,

            period_start: periodStartNext,
            period_end: periodEndNext,

            invoice_scan_json:
                data.invoice_scan_json === undefined
                    ? existing.invoice_scan_json
                    : data.invoice_scan_json,
        };

        if (requiresInvoiceIdForStatus(next.status) && !next.invoice_id) {
            const err = new Error("invoice_id_required_for_status");
            err.code = "PROJECT_INVOICE_REQUIRED";
            throw err;
        }

        const { rows } = await db.query(
            `
      UPDATE projects
      SET
        name=$3,
        description=$4,
        status=$5,
        start_date=$6,
        end_date=$7,
        budget=$8,
        spent=$9,
        contact_id=$10,
        work_start=$11,
        work_end=$12,
        invoice_id=$13,
        locatie=$14,
        tarief_type=$15,
        tarief=$16,
        period_start=$17,
        period_end=$18,
        invoice_scan_json=$19,
        updated_at=NOW()
      WHERE user_id=$1 AND id=$2
      RETURNING *, period_start AS periode_start, period_end AS periode_end
      `,
            [
                userId,
                id,
                next.name,
                next.description || null,
                next.status,
                next.start_date || null,
                next.end_date || null,
                next.budget ?? null,
                next.spent ?? 0,
                next.contact_id ?? null,
                next.work_start || null,
                next.work_end || null,
                next.invoice_id ?? null,
                next.locatie || null,
                next.tarief_type || null,
                next.tarief ?? null,
                next.period_start || null,
                next.period_end || next.period_start || null,
                typeof next.invoice_scan_json === "string"
                    ? next.invoice_scan_json
                    : next.invoice_scan_json
                        ? JSON.stringify(next.invoice_scan_json)
                        : null,
            ]
        );

        return rows[0] || null;
    },

    async remove(userId, id) {
        const { rows } = await db.query(
            `DELETE FROM projects WHERE user_id=$1 AND id=$2 RETURNING id`,
            [userId, id]
        );
        return rows[0] || null;
    },

    async removeCascade(userId, id) {
        const p = await this.getById(userId, id);
        if (!p) return null;

        const deleted = await this.remove(userId, id);

        // Belangrijk: eerst project verwijderen, dan factuur.
        // Anders kan FK ON DELETE SET NULL op projects.invoice_id afgaan
        // en check constraints raken terwijl het project nog bestaat.
        if (deleted && p.invoice_id) {
            await db.query(
                `DELETE FROM invoices WHERE user_id=$1 AND id=$2`,
                [userId, p.invoice_id]
            );
        }

        return { project_id: deleted?.id || id, invoice_id: p.invoice_id || null };
    },

    /**
     * Gebruikt door projectInvoiceLink upload service.
     * Zorgt dat invoice link + scan json etc. in 1x wordt opgeslagen.
     */
    async updateInvoiceLink(userId, projectId, patch) {
        const existing = await this.getById(userId, projectId);
        if (!existing) throw new Error("Project not found");

        const next = {
            invoice_id: patch.invoice_id ?? existing.invoice_id,
            invoice_scan_json: patch.invoice_scan_json ?? existing.invoice_scan_json,
            contact_id: patch.contact_id ?? existing.contact_id,

            tarief_type: patch.tarief_type ?? existing.tarief_type,
            tarief: patch.tarief ?? existing.tarief,

            // opdracht_datum: als die nog leeg is, mag invoice_date hem zetten
            period_start:
                periodStartFromRow(existing) ||
                pickPeriodStart(patch, null) ||
                patch.invoice_date ||
                null,
            period_end:
                periodEndFromRow(existing) ||
                pickPeriodEnd(patch, null) ||
                patch.invoice_date ||
                null,

            // optioneel: extra velden als je ze in DB hebt (niet verplicht)
            invoice_date: patch.invoice_date ?? null,
            invoice_hours: patch.invoice_hours ?? null,
            invoice_rate: patch.invoice_rate ?? null,
        };

        const { rows } = await db.query(
            `
      UPDATE projects
      SET
        invoice_id=$3,
        invoice_scan_json=$4,
        contact_id=$5,
        tarief_type=$6,
        tarief=$7,
        period_start=$8,
        period_end=$9,
        updated_at=NOW()
      WHERE user_id=$1 AND id=$2
      RETURNING *, period_start AS periode_start, period_end AS periode_end
      `,
            [
                userId,
                projectId,
                next.invoice_id,
                typeof next.invoice_scan_json === "string"
                    ? next.invoice_scan_json
                    : next.invoice_scan_json
                        ? JSON.stringify(next.invoice_scan_json)
                        : null,
                next.contact_id,
                next.tarief_type,
                next.tarief,
                next.period_start,
                next.period_end ?? next.period_start,
            ]
        );

        return rows[0];
    },
};

export default ProjectsModel;
