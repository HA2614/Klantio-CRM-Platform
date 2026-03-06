import pool from "../config/database.js";
import { InvoicesModel } from "../models/Invoices.js";
import { ProjectsModel } from "../models/Projects.js";
import { AttachmentsModel } from "../models/Attachments.js";
import { extractPdfTextFromBuffer, parseInvoiceTextToJson } from "./invoiceScan.js";

function normalizeName(s) {
    return String(s || "")
        .trim()
        .toLowerCase()
        .replace(/[\s\-_.]+/g, " ")
        .replace(/[^\p{L}\p{N} ]/gu, "");
}

async function findContactIdByClientName(userId, clientName) {
    const cn = normalizeName(clientName);
    if (!cn) return null;

    const { rows } = await pool.query(
        `SELECT id, name, company FROM contacts WHERE user_id = $1`,
        [userId]
    );

    let hit = rows.find(r => normalizeName(r.name) === cn);
    if (hit) return hit.id;

    hit = rows.find(r => normalizeName(r.company) === cn);
    if (hit) return hit.id;

    hit = rows.find(r => {
        const n = normalizeName(r.name);
        const co = normalizeName(r.company);
        return (n && (n.includes(cn) || cn.includes(n))) ||
            (co && (co.includes(cn) || cn.includes(co)));
    });

    return hit ? hit.id : null;
}

function pickInvoiceAmountFromScan(parsed) {
    // Jij wil final_payout als echte “ontvangen” bedrag
    const payout = Number(parsed?.final_payout);
    if (Number.isFinite(payout)) return payout;

    const totalIncl = Number(parsed?.total_incl_btw);
    if (Number.isFinite(totalIncl)) return totalIncl;

    return 0;
}

function sumHoursFromItems(parsed) {
    const items = Array.isArray(parsed?.invoice_items) ? parsed.invoice_items : [];
    let sum = 0;

    for (const it of items) {
        const unit = String(it?.unit || "").toLowerCase();
        if (unit !== "uren" && unit !== "uur" && unit !== "hours") continue;
        const q = Number(it?.quantity);
        if (Number.isFinite(q)) sum += q;
    }
    return sum > 0 ? sum : null;
}

function pickRateFromItems(parsed) {
    const items = Array.isArray(parsed?.invoice_items) ? parsed.invoice_items : [];
    for (const it of items) {
        const unit = String(it?.unit || "").toLowerCase();
        const rate = Number(it?.rate);
        if ((unit === "uren" || unit === "uur" || unit === "hours") && Number.isFinite(rate) && rate > 0) {
            return rate;
        }
    }
    return null;
}

function deriveProjectFieldsFromScan(parsed) {
    const invoiceDate = parsed?.invoice_date || null;
    const hours = sumHoursFromItems(parsed);
    const rate = pickRateFromItems(parsed);

    return {
        invoice_date: invoiceDate,
        invoice_hours: hours,
        invoice_rate: rate,
        tarief_type: rate != null ? "hourly" : null,
        tarief: rate,
        periode_start: invoiceDate,
        periode_end: invoiceDate
    };
}

export async function uploadScanAndLinkInvoiceToProject({ userId, auth0Sub, projectId, file }) {
    if (!file?.buffer) throw new Error("Missing file buffer");
    if (!Number.isFinite(Number(projectId))) throw new Error("Invalid projectId");

    // 1) Scan PDF
    const text = await extractPdfTextFromBuffer(file.buffer);
    const parsed = parseInvoiceTextToJson(text);

    const invoiceNumber = String(parsed?.external_invoice_number || "").trim();
    if (!invoiceNumber) {
        throw new Error("Scan heeft geen external_invoice_number gevonden (factuurnummer ontbreekt)");
    }

    // 2) opdrachtgever match op client_name
    const clientName = String(parsed?.client_name || "").trim();
    const contactId = await findContactIdByClientName(userId, clientName);

    // 3) invoice bedragen/dates
    const amount = pickInvoiceAmountFromScan(parsed);

    const issueDate = parsed?.invoice_date || new Date().toISOString().slice(0, 10);
    let dueDate = null;
    if (issueDate) {
        const d = new Date(issueDate + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + 14);
        dueDate = d.toISOString().slice(0, 10);
    }

    // ✅ Jouw snippet is OK, maar alleen als createOrUpdateByNumber scan_json opslaat en ON CONFLICT goed staat
    const invoiceRow = await InvoicesModel.createOrUpdateByNumber(userId, {
        invoice_number: invoiceNumber,
        amount,
        status: "paid",
        issue_date: issueDate,
        due_date: dueDate,
        paid_date: issueDate,
        notes: null,
        project_id: projectId,
        contact_id: contactId,
        scan_json: parsed
    });

    // 4) PDF als attachment koppelen aan invoice (optioneel; als jij al disk-write doet in andere service, sla dit over)
    // Als je dit WEL gebruikt: AttachmentsModel.create verwacht velden zoals multer file object.
    // Hier gebruiken we jouw bestaande projectInvoiceLink aanpak met disk write, dus meestal hier NIET nodig.

    // 5) Project linken:
    // - invoice_id zetten
    // - invoice_scan_json zetten
    // - opdrachtgever (contact_id) op project zetten zodat frontend dropdown automatisch goed staat
    // - tarief/uren/periode invullen
    const derived = deriveProjectFieldsFromScan(parsed);

    const projectRow = await ProjectsModel.updateInvoiceLink(userId, projectId, {
        invoice_id: invoiceRow.id,
        invoice_scan_json: parsed,
        invoice_date: derived.invoice_date,
        invoice_hours: derived.invoice_hours,
        invoice_rate: derived.invoice_rate,
        tarief_type: derived.tarief_type,
        tarief: derived.tarief,
        periode_start: derived.periode_start,
        periode_end: derived.periode_end,

        // 🔥 belangrijk voor “opdrachtgever automatisch geselecteerd”
        // (hiervoor moet ProjectsModel.updateInvoiceLink óf update() dit veld kunnen zetten)
        contact_id: contactId
    });

    return { ok: true, invoice: invoiceRow, project: projectRow, parsed };
}
