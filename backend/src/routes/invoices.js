// src/routes/invoices.js
import express from "express";
import multer from "multer";
import fs from "node:fs";

import { checkJwt } from "../middleware/authMiddleware.js";
import { attachUser } from "../middleware/userContext.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";

import { db } from "../config/database.js";
import { InvoicesModel } from "../models/Invoices.js";
import { UserInvoiceSettingsModel } from "../models/UserInvoiceSettings.js";
import { extractPdfTextFromBuffer, parseInvoiceTextToJson } from "../services/invoiceScan.js";
import { fetchAndImportInvoicesFromLink } from "../services/invoicingFetchImport.js";

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
});

function isMissingTableError(err) {
    return String(err?.code || "") === "42P01";
}

async function safeSelectAttachmentPaths(client, userId, entityTypes) {
    try {
        const { rows } = await client.query(
            `
            SELECT storage_path
            FROM attachments
            WHERE user_id=$1
              AND entity_type = ANY($2::text[])
            `,
            [userId, entityTypes]
        );
        return rows
            .map((r) => String(r.storage_path || "").trim())
            .filter(Boolean);
    } catch (e) {
        if (isMissingTableError(e)) return [];
        throw e;
    }
}

async function safeDelete(client, sql, params = []) {
    try {
        const out = await client.query(sql, params);
        return Number(out?.rowCount || 0);
    } catch (e) {
        if (isMissingTableError(e)) return 0;
        throw e;
    }
}

router.use(checkJwt, attachUser, requireActiveSubscription);

// invoice settings (link for external invoicing source)
router.get("/invoicing-settings", async (req, res) => {
    try {
        const settings = await UserInvoiceSettingsModel.getByUserId(req.user.id);
        res.json({
            ok: true,
            invoicing_link: settings?.invoicing_link || null,
            updated_at: settings?.updated_at || null,
        });
    } catch (e) {
        console.error("get invoicing-settings error:", e);
        res.status(500).json({ error: "invoicing-settings-get-failed", message: e?.message || String(e) });
    }
});

router.put("/invoicing-settings", async (req, res) => {
    try {
        const updated = await UserInvoiceSettingsModel.upsertByUserId(req.user.id, {
            invoicing_link: req.body?.invoicing_link ?? null,
        });
        res.json({
            ok: true,
            invoicing_link: updated?.invoicing_link || null,
            updated_at: updated?.updated_at || null,
        });
    } catch (e) {
        const msg = String(e?.message || e);
        if (msg.toLowerCase().includes("invoicing link")) {
            return res.status(400).json({ error: "invalid_invoicing_link", message: msg });
        }
        console.error("put invoicing-settings error:", e);
        res.status(500).json({ error: "invoicing-settings-save-failed", message: msg });
    }
});

router.post("/fetch-invoicing", async (req, res) => {
    try {
        const nowYear = new Date().getUTCFullYear();
        const year = Number(req.body?.year ?? nowYear);
        if (!Number.isInteger(year) || year < 2000 || year > nowYear + 1) {
            return res.status(400).json({ error: "invalid_year", message: "Jaar is ongeldig." });
        }

        const settings = await UserInvoiceSettingsModel.getByUserId(req.user.id);
        const invoicingLink = String(settings?.invoicing_link || "").trim();
        if (!invoicingLink) {
            return res.status(400).json({
                error: "missing_invoicing_link",
                message: "Stel eerst je invoicing link in onder instellingen.",
            });
        }

        const out = await fetchAndImportInvoicesFromLink({
            userId: req.user.id,
            auth0Id: req.user.auth0_id || req.user.sub || "unknown",
            invoicingLink,
            year,
        });

        res.json({ ok: true, ...out });
    } catch (e) {
        const msg = String(e?.message || e);
        if (/expired|unauthorized|not found/i.test(msg.toLowerCase())) {
            return res.status(400).json({ error: "fetch-invoicing-failed", message: msg });
        }
        console.error("fetch-invoicing error:", e);
        res.status(500).json({ error: "fetch-invoicing-failed", message: msg });
    }
});

router.post("/delete-all-test-data", async (req, res) => {
    const confirmToken = String(req.body?.confirm || "").trim().toUpperCase();
    if (confirmToken !== "DELETE_ALL") {
        return res.status(400).json({
            error: "confirm_required",
            message: "Bevestiging ontbreekt. Stuur confirm='DELETE_ALL'.",
        });
    }

    const userId = Number(req.user?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({
            error: "invalid_user",
            message: "Gebruiker kon niet worden bepaald.",
        });
    }

    const entityTypes = ["contacts", "projects", "invoices"];
    const client = await db.connect();
    let attachmentPaths = [];

    try {
        await client.query("BEGIN");

        attachmentPaths = await safeSelectAttachmentPaths(client, userId, entityTypes);

        const deletedNotes = await safeDelete(
            client,
            `
            DELETE FROM notes
            WHERE user_id=$1
              AND entity_type = ANY($2::text[])
            `,
            [userId, entityTypes]
        );

        const deletedAttachments = await safeDelete(
            client,
            `
            DELETE FROM attachments
            WHERE user_id=$1
              AND entity_type = ANY($2::text[])
            `,
            [userId, entityTypes]
        );

        const deletedInvoiceFetchCache = await safeDelete(
            client,
            `DELETE FROM invoice_fetch_cache WHERE user_id=$1`,
            [userId]
        );

        const deletedInvoiceMonthCache = await safeDelete(
            client,
            `DELETE FROM invoice_month_cache WHERE user_id=$1`,
            [userId]
        );

        const deletedActivities = await safeDelete(
            client,
            `
            DELETE FROM activities
            WHERE user_id=$1
              AND (entity_type IS NULL OR entity_type = ANY($2::text[]))
            `,
            [userId, ["contact", "project", "invoice"]]
        );

        const deletedProjects = await safeDelete(
            client,
            `DELETE FROM projects WHERE user_id=$1`,
            [userId]
        );

        const deletedInvoices = await safeDelete(
            client,
            `DELETE FROM invoices WHERE user_id=$1`,
            [userId]
        );

        const deletedContacts = await safeDelete(
            client,
            `DELETE FROM contacts WHERE user_id=$1`,
            [userId]
        );

        await client.query("COMMIT");

        let filesDeleted = 0;
        for (const p of attachmentPaths) {
            try {
                if (p && fs.existsSync(p)) {
                    fs.unlinkSync(p);
                    filesDeleted += 1;
                }
            } catch {
                // Best effort: db reset mag niet falen door losse file delete errors.
            }
        }

        res.json({
            ok: true,
            deleted: {
                contacts: deletedContacts,
                projects: deletedProjects,
                invoices: deletedInvoices,
                notes: deletedNotes,
                attachments: deletedAttachments,
                attachment_files: filesDeleted,
                invoice_fetch_cache: deletedInvoiceFetchCache,
                invoice_month_cache: deletedInvoiceMonthCache,
                activities: deletedActivities,
            },
        });
    } catch (e) {
        try {
            await client.query("ROLLBACK");
        } catch {
            // ignore rollback errors
        }
        console.error("delete-all-test-data error:", e);
        res.status(500).json({
            error: "delete-all-test-data-failed",
            message: String(e?.message || e),
        });
    } finally {
        client.release();
    }
});

// list
router.get("/", async (req, res) => {
    res.json(await InvoicesModel.list(req.user.id));
});

// month cache list
router.get("/month-history", async (req, res) => {
    const fromYear = Number(req.query.fromYear || 2020);
    const totals = await InvoicesModel.computeMonthTotals(req.user.id, fromYear);
    await InvoicesModel.upsertMonthCache(req.user.id, totals);
    const rows = await InvoicesModel.listMonthCache(req.user.id, fromYear);
    res.json({ ok: true, rows });
});

// month details
router.get("/by-month", async (req, res) => {
    try {
        const year = Number(req.query.year);
        const month = Number(req.query.month);

        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
            return res.status(400).json({
                error: "invalid_month_query",
                message: "Gebruik numerieke query params: year en month (1-12).",
            });
        }

        const items = await InvoicesModel.listByMonth(req.user.id, year, month);
        res.json({ ok: true, items });
    } catch (e) {
        console.error("by-month error:", e);
        res.status(500).json({ error: "by-month-failed", message: String(e?.message || e) });
    }
});

// create
router.post("/", async (req, res) => {
    try {
        if (!req.is("application/json")) {
            return res.status(415).json({ error: "unsupported_media_type" });
        }

        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return res.status(400).json({ error: "invalid_payload" });
        }

        const created = await InvoicesModel.create(req.user.id, body);
        res.status(201).json(created);
    } catch (e) {
        console.error("invoices create error:", e);
        if (
            e?.code === "NEGATIVE_INVOICE_AMOUNT" ||
            e?.code === "INVALID_INVOICE_AMOUNT" ||
            e?.code === "22P02" ||
            e?.code === "23514" ||
            e?.code === "23502"
        ) {
            return res.status(400).json({ error: "invalid_invoice_payload" });
        }
        res.status(500).json({ error: "invoices_create_failed" });
    }
});

// update
router.put("/:id", async (req, res) => {
    try {
        if (!req.is("application/json")) {
            return res.status(415).json({ error: "unsupported_media_type" });
        }

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: "invalid_id" });
        }

        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return res.status(400).json({ error: "invalid_payload" });
        }

        const updated = await InvoicesModel.update(req.user.id, id, body);
        if (!updated) return res.status(404).json({ error: "Not found" });
        res.json(updated);
    } catch (e) {
        console.error("invoices update error:", e);
        if (
            e?.code === "NEGATIVE_INVOICE_AMOUNT" ||
            e?.code === "INVALID_INVOICE_AMOUNT" ||
            e?.code === "22P02" ||
            e?.code === "23514" ||
            e?.code === "23502"
        ) {
            return res.status(400).json({ error: "invalid_invoice_payload" });
        }
        res.status(500).json({ error: "invoices_update_failed" });
    }
});

// delete (cascade optioneel)
router.delete("/:id", async (req, res) => {
    const id = Number(req.params.id);
    const cascade = String(req.query.cascade || "0") === "1";

    const deleted = cascade
        ? await InvoicesModel.removeCascade(req.user.id, id)
        : await InvoicesModel.remove(req.user.id, id);

    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, ...deleted });
});

// scan pdf -> json
router.post("/scan", upload.single("file"), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "Missing file field 'file'" });

        const text = await extractPdfTextFromBuffer(file.buffer);
        const parsed = parseInvoiceTextToJson(text);
        const excerpt = String(text).slice(0, 2000);

        res.json({ ok: true, parsed, excerpt });
    } catch (e) {
        console.error("invoice scan error:", e);
        res.status(500).json({ error: "Scan failed", message: e?.message || String(e) });
    }
});

export default router;
