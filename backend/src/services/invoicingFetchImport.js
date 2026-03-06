import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractPdfTextFromBuffer, parseInvoiceTextToJson } from "./invoiceScan.js";
import { ContactsModel } from "../models/Contacts.js";
import { ProjectsModel } from "../models/Projects.js";
import { InvoicesModel } from "../models/Invoices.js";
import { AttachmentsModel } from "../models/Attachments.js";
import { InvoiceFetchCacheModel } from "../models/InvoiceFetchCache.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PDF_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_CANDIDATES = 300;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsRoot = path.join(__dirname, "..", "..", "uploads");

function normalizeName(input) {
    return String(input || "")
        .trim()
        .toLowerCase()
        .replace(/[\s\-_.]+/g, " ")
        .replace(/[^\p{L}\p{N} ]/gu, "");
}

function safePathSegment(input) {
    return String(input || "")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 160);
}

function safeFilename(input) {
    const clean = String(input || "")
        .replace(/[/\\:*?"<>|]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 180);
    return clean || `invoice_${Date.now()}.pdf`;
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function decodeHtmlEntities(input) {
    return String(input || "")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">");
}

function buildCacheKey(kind, raw) {
    const digest = crypto.createHash("sha256").update(String(raw || "")).digest("hex");
    return `${kind}:${digest}`;
}

function buildFallbackInvoiceNumber(year, buffer) {
    const fingerprint = crypto
        .createHash("sha1")
        .update(buffer || Buffer.alloc(0))
        .digest("hex")
        .slice(0, 12)
        .toUpperCase();

    return `AUTO-${year}-${fingerprint}`;
}

function toIsoDateOrNull(value) {
    const v = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    return null;
}

function parseScanJsonSafe(raw) {
    if (!raw) return null;
    if (typeof raw === "object") return raw;
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }
    return null;
}

function normalizeInvoiceNumber(value) {
    return String(value || "").trim().toLowerCase();
}

function extractYoungOnesUuid(scanJson) {
    const scan = parseScanJsonSafe(scanJson);
    const uuid = String(
        scan?.source_row?.contractor_invoice_uuid ||
        scan?.contractor_invoice_uuid ||
        ""
    ).trim();
    return uuid ? uuid.toLowerCase() : null;
}

function buildExistingInvoiceIndex(existingInvoices) {
    const byInvoiceNumber = new Set();
    const byYoungOnesUuid = new Set();
    const invoiceByInvoiceNumber = new Map();
    const invoiceByYoungOnesUuid = new Map();

    for (const inv of Array.isArray(existingInvoices) ? existingInvoices : []) {
        const nrKey = normalizeInvoiceNumber(inv?.invoice_number);
        if (nrKey) {
            byInvoiceNumber.add(nrKey);
            if (!invoiceByInvoiceNumber.has(nrKey)) {
                invoiceByInvoiceNumber.set(nrKey, inv);
            }
        }

        const yoUuid = extractYoungOnesUuid(inv?.scan_json);
        if (yoUuid) {
            byYoungOnesUuid.add(yoUuid);
            if (!invoiceByYoungOnesUuid.has(yoUuid)) {
                invoiceByYoungOnesUuid.set(yoUuid, inv);
            }
        }
    }

    return { byInvoiceNumber, byYoungOnesUuid, invoiceByInvoiceNumber, invoiceByYoungOnesUuid };
}

function buildDueDate(issueDate) {
    const d = new Date(`${issueDate}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return issueDate;
    d.setUTCDate(d.getUTCDate() + 14);
    return d.toISOString().slice(0, 10);
}

function pickAmountFromParsed(parsed) {
    const payout = Number(parsed?.final_payout);
    if (Number.isFinite(payout)) return payout;

    const totalIncl = Number(parsed?.total_incl_btw);
    if (Number.isFinite(totalIncl)) return totalIncl;

    return 0;
}

function pickStatusFromParsed(parsed) {
    const suggested = String(parsed?.invoice_status_suggested || "").toLowerCase();
    if (suggested === "paid") return "paid";
    return "sent";
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
    const item = items.find((it) => Number.isFinite(Number(it?.rate)));
    return item ? Number(item.rate) : null;
}

function buildProjectName(parsed, invoiceNumber) {
    const client = String(parsed?.client_name || "").trim();
    if (client && invoiceNumber) return `${client} - ${invoiceNumber}`;
    if (client) return `Opdracht ${client}`;
    return `Opdracht ${invoiceNumber}`;
}

function projectStatusForInvoiceStatus(invoiceStatus) {
    return invoiceStatus === "paid" ? "betaald" : "gefactureerd";
}

function parseUrlForInspection(invoicingLink) {
    const raw = String(invoicingLink || "").trim();
    if (!raw) return null;
    const probe = raw.replace(/\{year\}/g, "2026");
    try {
        return new URL(probe);
    } catch {
        return null;
    }
}

function isYoungOnesInvoicingLink(invoicingLink) {
    const parsed = parseUrlForInspection(invoicingLink);
    if (!parsed) return false;
    return /(^|\.)invoicing\.youngones\.io$/i.test(String(parsed.hostname || ""));
}

function getYoungOnesHashToken(invoicingLink) {
    const parsed = parseUrlForInspection(invoicingLink);
    if (!parsed) return null;

    const hash = String(parsed.hash || "").replace(/^#/, "").trim();
    return hash || null;
}

function resolveListingUrl(invoicingLink, year) {
    const raw = String(invoicingLink || "").trim();
    if (!raw) throw new Error("Geen invoicing link ingesteld.");

    if (raw.includes("{year}")) {
        return raw.replace(/\{year\}/g, encodeURIComponent(String(year)));
    }

    const url = new URL(raw);
    const yearParam =
        url.searchParams.has("jaar")
            ? "jaar"
            : url.searchParams.has("invoice_year")
                ? "invoice_year"
                : "year";
    url.searchParams.set(yearParam, String(year));
    return url.toString();
}

async function fetchYoungOnesInvoicesByHash(hashToken, year) {
    const hash = String(hashToken || "").trim();
    if (!hash) {
        throw new Error("YoungOnes hash ontbreekt in de invoicing link.");
    }

    const input = encodeURIComponent(JSON.stringify({ hash, year }));
    const queryUrl = `https://invoicing.youngones.io/api/trpc/invoice.getInvoicesById?input=${input}`;

    const res = await fetchWithTimeout(queryUrl, { method: "GET" });

    let payload = null;
    try {
        payload = await res.json();
    } catch {
        payload = null;
    }

    if (!res.ok || payload?.error) {
        const apiMessage = String(payload?.error?.message || "").trim();
        const msg = apiMessage || `YoungOnes API fout (${res.status})`;
        throw new Error(msg);
    }

    const dataRoot =
        payload?.result?.data?.json ??
        payload?.result?.data ??
        payload?.json ??
        payload;

    const invoices = Array.isArray(dataRoot?.invoices)
        ? dataRoot.invoices
        : Array.isArray(dataRoot)
            ? dataRoot
            : [];

    return { queryUrl, invoices };
}

function pickAmountFromYoungOnesItem(item, parsed) {
    const parsedAmount = pickAmountFromParsed(parsed);
    if (Number.isFinite(parsedAmount) && parsedAmount > 0) return parsedAmount;

    const payout = Number(item?.contractor_invoice_amount_including_vat);
    if (Number.isFinite(payout)) return payout;

    const totalIncl = Number(item?.total_amount_including_vat);
    if (Number.isFinite(totalIncl)) return totalIncl;

    const factoringIncl = Number(item?.factoring_amount_including_vat);
    if (Number.isFinite(factoringIncl)) return factoringIncl;

    return 0;
}

function pickStatusFromYoungOnesItem(item, parsed) {
    // YoungOnes API is leidend: als betaling verstuurd is, markeren als paid.
    if (item?.contractor_payment_send_at) return "paid";

    // Gepland of nog bezig betekent nog niet betaald.
    if (item?.contractor_payment_scheduled_at) return "sent";

    // Fallback op parser voor edge-cases waar API velden ontbreken.
    const parsedStatus = pickStatusFromParsed(parsed);
    if (parsedStatus === "paid") return "paid";
    return "sent";
}

function issueDateFromYoungOnesItem(item, parsed) {
    const parsedDate = toIsoDateOrNull(parsed?.invoice_date);
    if (parsedDate) return parsedDate;

    const rawCreated = String(item?.contractor_invoice_created_at || "");
    const datePart = rawCreated.slice(0, 10);
    const yoDate = toIsoDateOrNull(datePart);
    if (yoDate) return yoDate;

    return new Date().toISOString().slice(0, 10);
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const headers = {
        "User-Agent": "FreelancerCRM-InvoicingFetcher/1.0",
        ...(options.headers || {}),
    };

    try {
        return await fetch(url, {
            ...options,
            headers,
            signal: controller.signal,
            redirect: "follow",
        });
    } catch (err) {
        if (err?.name === "AbortError") {
            throw new Error(`Timeout bij ophalen van ${url}`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
}

function collectAttributeValues(html, attrName) {
    const values = [];
    const re = new RegExp(`${attrName}\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "gi");
    let match;
    while ((match = re.exec(html)) !== null) {
        const raw = match[2] || match[3] || match[4] || "";
        if (raw) values.push(raw);
    }
    return values;
}

function extractCandidateUrlsFromHtml(html, baseUrl) {
    const rawValues = [];

    ["href", "data-href", "data-url", "data-download-url"].forEach((attr) => {
        rawValues.push(...collectAttributeValues(html, attr));
    });

    const onclickRe = /onclick\s*=\s*("([^"]*)"|'([^']*)')/gi;
    let onclickMatch;
    while ((onclickMatch = onclickRe.exec(html)) !== null) {
        const snippet = onclickMatch[2] || onclickMatch[3] || "";
        if (!snippet) continue;
        const embeddedUrlRe = /(https?:\/\/[^\s'"`<>]+|\/[^\s'"`<>]+)/gi;
        let u;
        while ((u = embeddedUrlRe.exec(snippet)) !== null) {
            rawValues.push(u[1]);
        }
    }

    const normalized = new Set();
    for (const value of rawValues) {
        const decoded = decodeHtmlEntities(value).trim();
        if (!decoded || decoded.startsWith("#") || decoded.startsWith("javascript:")) continue;

        let absoluteUrl;
        try {
            absoluteUrl = new URL(decoded, baseUrl).toString();
        } catch {
            continue;
        }

        const low = absoluteUrl.toLowerCase();
        const looksLikeInvoice =
            low.includes(".pdf") ||
            low.includes("download") ||
            low.includes("factuur") ||
            low.includes("invoice");

        if (!looksLikeInvoice) continue;
        if (!/^https?:\/\//i.test(absoluteUrl)) continue;

        normalized.add(absoluteUrl);
    }

    const urls = Array.from(normalized);
    const score = (url) => {
        const low = url.toLowerCase();
        let s = 0;
        if (low.includes(".pdf")) s += 10;
        if (low.includes("download")) s += 4;
        if (low.includes("factuur") || low.includes("invoice")) s += 2;
        return s;
    };

    urls.sort((a, b) => score(b) - score(a));
    return urls.slice(0, MAX_CANDIDATES);
}

function isPdfBuffer(buffer) {
    if (!buffer || buffer.length < 5) return false;
    return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function hasUsableInvoiceAttachment(userId, invoiceId) {
    const id = Number(invoiceId);
    if (!Number.isInteger(id) || id <= 0) return false;

    const items = await AttachmentsModel.list(userId, "invoices", id);
    for (const item of items) {
        const storagePath = String(item?.storage_path || "").trim();
        const sizeBytes = Number(item?.size_bytes || 0);
        if (!storagePath || !Number.isFinite(sizeBytes) || sizeBytes <= 0) continue;

        try {
            const stat = fs.statSync(storagePath);
            if (stat.isFile() && stat.size > 0) {
                return true;
            }
        } catch {
            // Ignore stale/missing paths and keep searching for a valid attachment.
        }
    }

    return false;
}

function filenameFromContentDisposition(headerValue) {
    const raw = String(headerValue || "");
    if (!raw) return null;

    const utf8Match = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
        try {
            return decodeURIComponent(utf8Match[1].trim());
        } catch {
            return utf8Match[1].trim();
        }
    }

    const basicMatch = raw.match(/filename\s*=\s*("?)([^";]+)\1/i);
    if (basicMatch?.[2]) return basicMatch[2].trim();
    return null;
}

function inferFilename({ contentDisposition, sourceUrl, index }) {
    const fromHeader = filenameFromContentDisposition(contentDisposition);
    if (fromHeader) return safeFilename(fromHeader);

    try {
        const url = new URL(sourceUrl);
        const candidate = url.pathname.split("/").filter(Boolean).pop();
        if (candidate) return safeFilename(candidate);
    } catch {
        // ignore URL parse errors, fallback below
    }

    return `invoice_${index}.pdf`;
}

async function downloadPdfCandidate(url) {
    const res = await fetchWithTimeout(url, { method: "GET" });
    if (!res.ok) {
        throw new Error(`Download faalde (${res.status})`);
    }

    const contentLength = Number(res.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_PDF_SIZE_BYTES) {
        throw new Error("PDF is groter dan de ingestelde limiet (15MB)");
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) {
        throw new Error("Gedownloade file is leeg (0 bytes).");
    }
    if (buffer.length > MAX_PDF_SIZE_BYTES) {
        throw new Error("PDF is groter dan de ingestelde limiet (15MB)");
    }

    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (!isPdfBuffer(buffer)) {
        if (contentType.includes("application/pdf")) {
            throw new Error("Response claimt PDF maar bevat geen geldige PDF data.");
        }
        throw new Error("Response is geen PDF");
    }

    return {
        buffer,
        finalUrl: res.url || url,
        contentType,
        contentDisposition: res.headers.get("content-disposition") || null,
    };
}

async function findOrCreateContactId(userId, contactsCache, clientName) {
    const name = String(clientName || "").trim();
    if (!name) return null;

    const target = normalizeName(name);
    if (!target) return null;

    let hit = contactsCache.find((c) => normalizeName(c.name) === target);
    if (!hit) hit = contactsCache.find((c) => normalizeName(c.company) === target);
    if (!hit) {
        hit = contactsCache.find((c) => {
            const n = normalizeName(c.name);
            const co = normalizeName(c.company);
            return (n && (n.includes(target) || target.includes(n))) ||
                (co && (co.includes(target) || target.includes(co)));
        });
    }

    if (hit) return Number(hit.id);

    const created = await ContactsModel.create(userId, {
        name,
        email: null,
        phone: null,
        company: null,
        notes: null,
        opdrachtgever_type: null,
        contactpersoon: null,
        btw_nummer: null,
        kvk_nummer: null,
        betaaltermijn_dagen: null,
        standaard_uurtarief: null,
    });

    contactsCache.push(created);
    return Number(created.id);
}

async function ensureProjectForInvoice({
    userId,
    invoiceRow,
    invoiceStatus,
    parsed,
    contactId,
    projectsCache,
}) {
    const issueDate = toIsoDateOrNull(parsed?.invoice_date) || new Date().toISOString().slice(0, 10);
    const invoiceHours = sumInvoiceHours(parsed);
    const invoiceRate = pickInvoiceRate(parsed);
    const projectStatus = projectStatusForInvoiceStatus(invoiceStatus);
    const projectName = buildProjectName(parsed, invoiceRow.invoice_number);

    let projectId = Number(invoiceRow.project_id) || null;

    if (!projectId) {
        // Try simple match by generated name before creating new project.
        const existing = projectsCache.find((p) =>
            normalizeName(p.name) === normalizeName(projectName) &&
            Number(p.contact_id || 0) === Number(contactId || 0)
        );

        if (existing) {
            projectId = Number(existing.id);
        } else {
            const created = await ProjectsModel.create(userId, {
                name: projectName,
                description: null,
                status: projectStatus,
                start_date: issueDate,
                end_date: issueDate,
                budget: null,
                spent: 0,
                contact_id: contactId,
                work_start: null,
                work_end: null,
                invoice_id: invoiceRow.id,
                locatie: null,
                tarief_type: invoiceRate != null ? "hourly" : null,
                tarief: invoiceRate,
                periode_start: issueDate,
                periode_end: issueDate,
                invoice_scan_json: parsed,
            });
            projectsCache.push(created);
            projectId = Number(created.id);
        }
    }

    await InvoicesModel.update(userId, Number(invoiceRow.id), {
        project_id: projectId,
        contact_id: contactId,
    });

    await ProjectsModel.update(userId, projectId, {
        status: projectStatus,
        contact_id: contactId,
        invoice_id: Number(invoiceRow.id),
    });

    await ProjectsModel.updateInvoiceLink(userId, projectId, {
        invoice_id: invoiceRow.id,
        invoice_scan_json: parsed,
        invoice_date: issueDate,
        invoice_hours: invoiceHours,
        invoice_rate: invoiceRate,
        tarief_type: invoiceRate != null ? "hourly" : null,
        tarief: invoiceRate,
        contact_id: contactId,
    });

    return projectId;
}

async function saveInvoiceAttachment({ userId, auth0Id, invoiceId, originalName, buffer, mimeType }) {
    ensureDir(uploadsRoot);
    const userFolder = safePathSegment(auth0Id || "unknown");
    const invoiceFolder = path.join(uploadsRoot, userFolder, "invoices", String(invoiceId));
    ensureDir(invoiceFolder);

    const storedName = `${Date.now()}_${safeFilename(originalName)}`;
    const storagePath = path.join(invoiceFolder, storedName);
    fs.writeFileSync(storagePath, buffer);

    await AttachmentsModel.create(userId, "invoices", Number(invoiceId), {
        originalname: originalName,
        filename: storedName,
        mimetype: mimeType || "application/pdf",
        size: Number(buffer.length),
        path: storagePath,
    });
}

export async function fetchAndImportInvoicesFromLink({ userId, auth0Id, invoicingLink, year }) {
    const nowYear = new Date().getUTCFullYear();
    const sourceYear = Number(year);
    if (!Number.isInteger(sourceYear) || sourceYear < 2000 || sourceYear > nowYear + 1) {
        throw new Error("Ongeldig jaar opgegeven.");
    }

    const listingUrl = resolveListingUrl(invoicingLink, sourceYear);

    // Special flow for YoungOnes invoicing links: the hash fragment is the auth token
    // and invoices are loaded through a tRPC endpoint.
    const yoHash = isYoungOnesInvoicingLink(invoicingLink)
        ? getYoungOnesHashToken(invoicingLink)
        : null;

    if (yoHash) {
        const { queryUrl, invoices } = await fetchYoungOnesInvoicesByHash(yoHash, sourceYear);

        const summary = {
            listing_url: listingUrl,
            resolved_url: queryUrl,
            year: sourceYear,
            found: 0,
            imported: 0,
            skipped_cached: 0,
            failed: 0,
            errors: [],
        };

        const candidates = (Array.isArray(invoices) ? invoices : []).slice(0, MAX_CANDIDATES).map((item, idx) => {
            const uuid = String(item?.contractor_invoice_uuid || "").trim();
            const invoiceNumberHint = String(item?.new_contractor_invoice_number || "").trim();
            const downloadUrl = uuid
                ? `https://factuurcheck.youngones.works/documents?download=${encodeURIComponent(uuid)}`
                : null;

            let sourceKey = null;
            if (uuid) {
                sourceKey = buildCacheKey("yo_uuid", uuid);
            } else if (invoiceNumberHint) {
                sourceKey = buildCacheKey("yo_invoice", invoiceNumberHint.toLowerCase());
            } else {
                sourceKey = buildCacheKey("yo_row", `${sourceYear}:${idx}`);
            }

            return {
                item,
                sourceKey,
                downloadUrl,
            };
        });

        summary.found = candidates.length;
        if (!candidates.length) return summary;

        const cachedSourceKeys = await InvoiceFetchCacheModel.hasAnyKeys(
            userId,
            candidates.map((c) => c.sourceKey)
        );

        const contactsCache = await ContactsModel.list(userId);
        const projectsCache = await ProjectsModel.list(userId);
        const existingInvoiceIndex = buildExistingInvoiceIndex(await InvoicesModel.list(userId));
        const invoiceAttachmentState = new Map();

        const hasValidAttachmentForInvoice = async (invoiceId) => {
            const id = Number(invoiceId);
            if (!Number.isInteger(id) || id <= 0) return false;

            if (invoiceAttachmentState.has(id)) {
                return invoiceAttachmentState.get(id);
            }

            const hasAttachment = await hasUsableInvoiceAttachment(userId, id);
            invoiceAttachmentState.set(id, hasAttachment);
            return hasAttachment;
        };

        for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            const candidateUuid = String(candidate.item?.contractor_invoice_uuid || "").trim().toLowerCase();
            const candidateHintNumber = String(candidate.item?.new_contractor_invoice_number || "").trim();
            const candidateHintKey = normalizeInvoiceNumber(candidateHintNumber);
            const existingByUuid = candidateUuid
                ? existingInvoiceIndex.invoiceByYoungOnesUuid.get(candidateUuid)
                : null;
            const existingByHint = candidateHintKey
                ? existingInvoiceIndex.invoiceByInvoiceNumber.get(candidateHintKey)
                : null;
            const matchedExistingInvoice = existingByUuid || existingByHint || null;
            const matchedExistingInvoiceId = Number(matchedExistingInvoice?.id);
            const needsAttachmentBackfill = Number.isInteger(matchedExistingInvoiceId) && matchedExistingInvoiceId > 0
                ? !(await hasValidAttachmentForInvoice(matchedExistingInvoiceId))
                : false;

            if (cachedSourceKeys.has(candidate.sourceKey) && !needsAttachmentBackfill) {
                summary.skipped_cached += 1;
                continue;
            }

            if (
                (
                    (candidateUuid && existingInvoiceIndex.byYoungOnesUuid.has(candidateUuid)) ||
                    (candidateHintKey && existingInvoiceIndex.byInvoiceNumber.has(candidateHintKey))
                ) &&
                !needsAttachmentBackfill
            ) {
                await InvoiceFetchCacheModel.markFetched(userId, {
                    sourceKey: candidate.sourceKey,
                    sourceUrl: candidate.downloadUrl,
                    sourceYear,
                    invoiceNumber: candidateHintNumber || null,
                });
                summary.skipped_cached += 1;
                continue;
            }

            try {
                if (!candidate.downloadUrl) {
                    throw new Error("Factuur heeft geen download-id.");
                }

                const downloaded = await downloadPdfCandidate(candidate.downloadUrl);
                const finalUrl = downloaded.finalUrl || candidate.downloadUrl;
                const finalUrlKey = buildCacheKey("url", finalUrl);

                if (finalUrlKey !== candidate.sourceKey && await InvoiceFetchCacheModel.hasKey(userId, finalUrlKey)) {
                    await InvoiceFetchCacheModel.markFetched(userId, {
                        sourceKey: candidate.sourceKey,
                        sourceUrl: finalUrl,
                        sourceYear,
                    });
                    summary.skipped_cached += 1;
                    continue;
                }

                const buffer = downloaded.buffer;
                if (!isPdfBuffer(buffer)) {
                    throw new Error("Gedownloade file is geen geldige PDF.");
                }

                let parsed = null;
                try {
                    const text = await extractPdfTextFromBuffer(buffer);
                    parsed = parseInvoiceTextToJson(text);
                } catch {
                    parsed = null;
                }

                const hintNr = String(candidate.item?.new_contractor_invoice_number || "").trim();
                const parsedNr = String(parsed?.external_invoice_number || "").trim();
                const invoiceNumber = parsedNr || hintNr || buildFallbackInvoiceNumber(sourceYear, buffer);
                const invoiceNrKey = normalizeInvoiceNumber(invoiceNumber);
                const invoiceKey = buildCacheKey("invoice", invoiceNrKey);
                const existingByInvoiceNumber = invoiceNrKey
                    ? existingInvoiceIndex.invoiceByInvoiceNumber.get(invoiceNrKey)
                    : null;
                const existingByInvoiceNumberId = Number(existingByInvoiceNumber?.id);
                const needsAttachmentForInvoiceNumber =
                    Number.isInteger(existingByInvoiceNumberId) && existingByInvoiceNumberId > 0
                        ? !(await hasValidAttachmentForInvoice(existingByInvoiceNumberId))
                        : false;

                if (
                    (
                        existingInvoiceIndex.byInvoiceNumber.has(invoiceNrKey) ||
                        await InvoiceFetchCacheModel.hasKey(userId, invoiceKey)
                    ) &&
                    !needsAttachmentBackfill &&
                    !needsAttachmentForInvoiceNumber
                ) {
                    await InvoiceFetchCacheModel.markFetched(userId, {
                        sourceKey: candidate.sourceKey,
                        sourceUrl: finalUrl,
                        sourceYear,
                        invoiceNumber,
                    });
                    if (finalUrlKey !== candidate.sourceKey) {
                        await InvoiceFetchCacheModel.markFetched(userId, {
                            sourceKey: finalUrlKey,
                            sourceUrl: finalUrl,
                            sourceYear,
                            invoiceNumber,
                        });
                    }
                    if (invoiceNrKey) {
                        existingInvoiceIndex.byInvoiceNumber.add(invoiceNrKey);
                    }
                    if (candidateUuid) {
                        existingInvoiceIndex.byYoungOnesUuid.add(candidateUuid);
                    }
                    summary.skipped_cached += 1;
                    continue;
                }

                const issueDate = issueDateFromYoungOnesItem(candidate.item, parsed || {});
                const dueDate = buildDueDate(issueDate);
                const invoiceStatus = pickStatusFromYoungOnesItem(candidate.item, parsed || {});
                const amount = pickAmountFromYoungOnesItem(candidate.item, parsed || {});

                const clientName = String(parsed?.client_name || "").trim();
                const contactId = clientName
                    ? await findOrCreateContactId(userId, contactsCache, clientName)
                    : null;

                const scanJson = parsed
                    ? { ...parsed, source_provider: "youngones", source_row: candidate.item }
                    : { source_provider: "youngones", source_row: candidate.item };

                const invoiceRow = await InvoicesModel.createOrUpdateByNumber(userId, {
                    invoice_number: invoiceNumber,
                    status: invoiceStatus,
                    amount,
                    issue_date: issueDate,
                    due_date: dueDate,
                    paid_date: invoiceStatus === "paid" ? issueDate : null,
                    notes: null,
                    project_id: null,
                    contact_id: contactId,
                    scan_json: scanJson,
                });

                await ensureProjectForInvoice({
                    userId,
                    invoiceRow,
                    invoiceStatus,
                    parsed: parsed || {
                        client_name: clientName || null,
                        invoice_date: issueDate,
                        invoice_items: [],
                    },
                    contactId,
                    projectsCache,
                });

                let originalName = inferFilename({
                    contentDisposition: downloaded.contentDisposition,
                    sourceUrl: finalUrl,
                    index: index + 1,
                });
                if ((!originalName || /^documents$/i.test(originalName)) && invoiceNumber) {
                    originalName = safeFilename(`${invoiceNumber}.pdf`);
                }

                await saveInvoiceAttachment({
                    userId,
                    auth0Id,
                    invoiceId: invoiceRow.id,
                    originalName,
                    buffer,
                    mimeType: downloaded.contentType,
                });
                invoiceAttachmentState.set(Number(invoiceRow.id), true);

                await InvoiceFetchCacheModel.markFetched(userId, {
                    sourceKey: candidate.sourceKey,
                    sourceUrl: finalUrl,
                    sourceYear,
                    invoiceNumber,
                    invoiceId: invoiceRow.id,
                });

                if (finalUrlKey !== candidate.sourceKey) {
                    await InvoiceFetchCacheModel.markFetched(userId, {
                        sourceKey: finalUrlKey,
                        sourceUrl: finalUrl,
                        sourceYear,
                        invoiceNumber,
                        invoiceId: invoiceRow.id,
                    });
                }

                await InvoiceFetchCacheModel.markFetched(userId, {
                    sourceKey: invoiceKey,
                    sourceUrl: finalUrl,
                    sourceYear,
                    invoiceNumber,
                    invoiceId: invoiceRow.id,
                });

                if (invoiceNrKey) {
                    existingInvoiceIndex.byInvoiceNumber.add(invoiceNrKey);
                    existingInvoiceIndex.invoiceByInvoiceNumber.set(invoiceNrKey, invoiceRow);
                }
                if (candidateUuid) {
                    existingInvoiceIndex.byYoungOnesUuid.add(candidateUuid);
                    existingInvoiceIndex.invoiceByYoungOnesUuid.set(candidateUuid, invoiceRow);
                }

                summary.imported += 1;
            } catch (err) {
                summary.failed += 1;
                summary.errors.push({
                    url: candidate.downloadUrl || listingUrl,
                    message: String(err?.message || err),
                });
            }
        }

        if (summary.errors.length > 25) {
            summary.errors = summary.errors.slice(0, 25);
        }

        return summary;
    }

    const listingResponse = await fetchWithTimeout(listingUrl, { method: "GET" });
    if (!listingResponse.ok) {
        throw new Error(`Invoicing pagina kon niet geladen worden (${listingResponse.status}).`);
    }

    const contentType = String(listingResponse.headers.get("content-type") || "").toLowerCase();
    const listingResultUrl = listingResponse.url || listingUrl;

    let candidates = [];
    if (contentType.includes("application/pdf")) {
        const buffer = Buffer.from(await listingResponse.arrayBuffer());
        if (buffer.length > MAX_PDF_SIZE_BYTES) {
            throw new Error("Directe invoicing PDF is groter dan 15MB.");
        }

        candidates = [{
            url: listingResultUrl,
            preloaded: {
                buffer,
                finalUrl: listingResultUrl,
                contentType,
                contentDisposition: listingResponse.headers.get("content-disposition") || null,
            },
        }];
    } else {
        const html = await listingResponse.text();
        const urls = extractCandidateUrlsFromHtml(html, listingResultUrl);
        candidates = urls.map((url) => ({ url }));
    }

    const summary = {
        listing_url: listingUrl,
        resolved_url: listingResultUrl,
        year: sourceYear,
        found: candidates.length,
        imported: 0,
        skipped_cached: 0,
        failed: 0,
        errors: [],
    };

    if (!candidates.length) {
        return summary;
    }

    const initialUrlKeys = candidates.map((c) => buildCacheKey("url", c.url));
    const cachedUrlKeys = await InvoiceFetchCacheModel.hasAnyKeys(userId, initialUrlKeys);

    const contactsCache = await ContactsModel.list(userId);
    const projectsCache = await ProjectsModel.list(userId);
    const existingInvoiceIndex = buildExistingInvoiceIndex(await InvoicesModel.list(userId));
    const invoiceAttachmentState = new Map();

    const hasValidAttachmentForInvoice = async (invoiceId) => {
        const id = Number(invoiceId);
        if (!Number.isInteger(id) || id <= 0) return false;

        if (invoiceAttachmentState.has(id)) {
            return invoiceAttachmentState.get(id);
        }

        const hasAttachment = await hasUsableInvoiceAttachment(userId, id);
        invoiceAttachmentState.set(id, hasAttachment);
        return hasAttachment;
    };

    for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const baseUrlKey = buildCacheKey("url", candidate.url);

        if (cachedUrlKeys.has(baseUrlKey)) {
            summary.skipped_cached += 1;
            continue;
        }

        try {
            const downloaded = candidate.preloaded || await downloadPdfCandidate(candidate.url);
            const finalUrl = downloaded.finalUrl || candidate.url;
            const finalUrlKey = buildCacheKey("url", finalUrl);

            // Redirected URL can already be cached even when the initial URL wasn't.
            if (finalUrlKey !== baseUrlKey && await InvoiceFetchCacheModel.hasKey(userId, finalUrlKey)) {
                await InvoiceFetchCacheModel.markFetched(userId, {
                    sourceKey: baseUrlKey,
                    sourceUrl: finalUrl,
                    sourceYear,
                });
                summary.skipped_cached += 1;
                continue;
            }

            const buffer = downloaded.buffer;
            if (!isPdfBuffer(buffer)) {
                throw new Error("Gedownloade file is geen geldige PDF.");
            }

            const text = await extractPdfTextFromBuffer(buffer);
            const parsed = parseInvoiceTextToJson(text);

            const externalInvoiceNumber = String(parsed?.external_invoice_number || "").trim();
            const invoiceNumber = externalInvoiceNumber || buildFallbackInvoiceNumber(sourceYear, buffer);
            const invoiceNrKey = normalizeInvoiceNumber(invoiceNumber);
            const invoiceKey = buildCacheKey("invoice", invoiceNrKey);
            const existingByInvoiceNumber = invoiceNrKey
                ? existingInvoiceIndex.invoiceByInvoiceNumber.get(invoiceNrKey)
                : null;
            const existingByInvoiceNumberId = Number(existingByInvoiceNumber?.id);
            const needsAttachmentForInvoiceNumber =
                Number.isInteger(existingByInvoiceNumberId) && existingByInvoiceNumberId > 0
                    ? !(await hasValidAttachmentForInvoice(existingByInvoiceNumberId))
                    : false;

            if (
                (
                    existingInvoiceIndex.byInvoiceNumber.has(invoiceNrKey) ||
                    await InvoiceFetchCacheModel.hasKey(userId, invoiceKey)
                ) &&
                !needsAttachmentForInvoiceNumber
            ) {
                await InvoiceFetchCacheModel.markFetched(userId, {
                    sourceKey: baseUrlKey,
                    sourceUrl: finalUrl,
                    sourceYear,
                    invoiceNumber,
                });
                if (finalUrlKey !== baseUrlKey) {
                    await InvoiceFetchCacheModel.markFetched(userId, {
                        sourceKey: finalUrlKey,
                        sourceUrl: finalUrl,
                        sourceYear,
                        invoiceNumber,
                    });
                }
                if (invoiceNrKey) {
                    existingInvoiceIndex.byInvoiceNumber.add(invoiceNrKey);
                }
                summary.skipped_cached += 1;
                continue;
            }

            const issueDate = toIsoDateOrNull(parsed?.invoice_date) || new Date().toISOString().slice(0, 10);
            const dueDate = buildDueDate(issueDate);
            const invoiceStatus = pickStatusFromParsed(parsed);
            const amount = pickAmountFromParsed(parsed);

            const contactId = await findOrCreateContactId(userId, contactsCache, parsed?.client_name);

            const invoiceRow = await InvoicesModel.createOrUpdateByNumber(userId, {
                invoice_number: invoiceNumber,
                status: invoiceStatus,
                amount,
                issue_date: issueDate,
                due_date: dueDate,
                paid_date: invoiceStatus === "paid" ? issueDate : null,
                notes: null,
                project_id: null,
                contact_id: contactId,
                scan_json: parsed,
            });

            await ensureProjectForInvoice({
                userId,
                invoiceRow,
                invoiceStatus,
                parsed,
                contactId,
                projectsCache,
            });

            const originalName = inferFilename({
                contentDisposition: downloaded.contentDisposition,
                sourceUrl: finalUrl,
                index: index + 1,
            });

            await saveInvoiceAttachment({
                userId,
                auth0Id,
                invoiceId: invoiceRow.id,
                originalName,
                buffer,
                mimeType: downloaded.contentType,
            });
            invoiceAttachmentState.set(Number(invoiceRow.id), true);

            await InvoiceFetchCacheModel.markFetched(userId, {
                sourceKey: baseUrlKey,
                sourceUrl: finalUrl,
                sourceYear,
                invoiceNumber,
                invoiceId: invoiceRow.id,
            });

            if (finalUrlKey !== baseUrlKey) {
                await InvoiceFetchCacheModel.markFetched(userId, {
                    sourceKey: finalUrlKey,
                    sourceUrl: finalUrl,
                    sourceYear,
                    invoiceNumber,
                    invoiceId: invoiceRow.id,
                });
            }

            await InvoiceFetchCacheModel.markFetched(userId, {
                sourceKey: invoiceKey,
                sourceUrl: finalUrl,
                sourceYear,
                invoiceNumber,
                invoiceId: invoiceRow.id,
            });

            if (invoiceNrKey) {
                existingInvoiceIndex.byInvoiceNumber.add(invoiceNrKey);
                existingInvoiceIndex.invoiceByInvoiceNumber.set(invoiceNrKey, invoiceRow);
            }

            summary.imported += 1;
        } catch (err) {
            summary.failed += 1;
            summary.errors.push({
                url: candidate.url,
                message: String(err?.message || err),
            });
        }
    }

    if (summary.errors.length > 25) {
        summary.errors = summary.errors.slice(0, 25);
    }

    return summary;
}
