// src/services/projectInvoiceLink.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { extractPdfTextFromBuffer, parseInvoiceTextToJson } from "./invoiceScan.js";
import { InvoicesModel } from "../models/Invoices.js";
import { ProjectsModel } from "../models/Projects.js";
import { AttachmentsModel } from "../models/Attachments.js";
import { ContactsModel } from "../models/Contacts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsRoot = path.join(__dirname, "..", "..", "uploads");

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function safePathSegment(s) {
    return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function safeFilename(s) {
    return String(s || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sumInvoiceHours(parsed) {
    const items = Array.isArray(parsed?.invoice_items) ? parsed.invoice_items : [];
    return items.reduce((sum, it) => {
        const unit = String(it?.unit || "").toLowerCase();
        if (unit !== "uren" && unit !== "uur" && unit !== "hours") return sum;
        const q = Number(it?.quantity || 0);
        return sum + (Number.isFinite(q) ? q : 0);
    }, 0);
}

function pickInvoiceRate(parsed) {
    const items = Array.isArray(parsed?.invoice_items) ? parsed.invoice_items : [];
    const it = items.find((x) => Number.isFinite(Number(x?.rate)));
    return it ? Number(it.rate) : null;
}

async function findContactIdByClientName(userId, clientName) {
    const name = String(clientName || "").trim();
    if (!name) return null;

    // simpele match op contact name
    const contacts = await ContactsModel.list(userId);
    const n = name.toLowerCase();

    const exact = contacts.find((c) => String(c.name || "").trim().toLowerCase() === n);
    if (exact) return exact.id;

    const partial = contacts.find((c) =>
        String(c.name || "").toLowerCase().includes(n) || n.includes(String(c.name || "").toLowerCase())
    );
    return partial ? partial.id : null;
}

/**
 * upload + scan + maak/werk invoice bij + sla PDF op + maak attachment + link invoice aan project
 */
export async function uploadScanAndLinkInvoiceToProject({
    userId,
    auth0Sub,
    projectId,
    file, // multer file
}) {
    if (!file) throw new Error("Missing file");

    // 1) scan
    const text = await extractPdfTextFromBuffer(file.buffer);
    const parsed = parseInvoiceTextToJson(text);

    // 2) bepaal invoice velden
    const invoice_number =
        String(parsed?.external_invoice_number || "").trim() ||
        `AUTO-${new Date().getFullYear()}-${Date.now()}`;

    const issue_date = parsed?.invoice_date || new Date().toISOString().slice(0, 10);

    const due_date = (() => {
        const d = new Date(issue_date + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + 14);
        return d.toISOString().slice(0, 10);
    })();

    const status = "paid";

    const payout = Number(parsed?.final_payout);
    const fallback = Number(parsed?.total_incl_btw);
    const amount = Number.isFinite(payout) ? payout : Number.isFinite(fallback) ? fallback : 0;

    // 3) contact match
    const contact_id = await findContactIdByClientName(userId, parsed?.client_name);

    // 4) create/update invoice
    const invoiceRow = await InvoicesModel.createOrUpdateByNumber(userId, {
        invoice_number,
        amount,
        status,
        issue_date,
        due_date,
        paid_date: issue_date,
        notes: null,
        project_id: projectId,
        contact_id: contact_id,
        scan_json: parsed,
    });

    // 5) sla PDF op disk in uploads/<sub>/invoices/<invoiceId>/
    ensureDir(uploadsRoot);
    const subFolder = safePathSegment(auth0Sub || "unknown");
    const entityType = "invoices";
    const entityId = String(invoiceRow.id);

    const dir = path.join(uploadsRoot, subFolder, entityType, entityId);
    ensureDir(dir);

    const stored = `${Date.now()}_${safeFilename(file.originalname)}`;
    const storagePath = path.join(dir, stored);
    fs.writeFileSync(storagePath, Buffer.from(file.buffer));

    // 6) attachments row
    await AttachmentsModel.create(userId, entityType, Number(invoiceRow.id), {
        originalname: file.originalname,
        filename: stored,
        mimetype: file.mimetype || "application/pdf",
        size: file.size || Buffer.byteLength(file.buffer),
        path: storagePath,
    });

    // 7) update project link + scan json + tarief etc.
    const invoiceHours = sumInvoiceHours(parsed);
    const invoiceRate = pickInvoiceRate(parsed);

    const projectRow = await ProjectsModel.updateInvoiceLink(userId, projectId, {
        invoice_id: invoiceRow.id,
        invoice_scan_json: parsed,
        invoice_date: parsed?.invoice_date || null,
        invoice_hours: invoiceHours,
        invoice_rate: invoiceRate,

        tarief_type: invoiceRate ? "hourly" : null,
        tarief: invoiceRate,

        // opdracht_datum -> periode_start (zelfde dag)
        // alleen invullen als nog leeg is (model doet dat)
        contact_id: contact_id || null,
    });

    return { ok: true, invoice: invoiceRow, project: projectRow, parsed };
}
