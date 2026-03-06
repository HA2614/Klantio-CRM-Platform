import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

function toNumberEU(raw) {
    if (raw == null) return null;
    const s = String(raw)
        .replace(/\s/g, "")
        .replace("€", "")
        .replace(/\.(?=\d{3}\b)/g, "") // duizendtallen: 1.234,56 -> 1234,56
        .replace(",", "."); // decimaal
    const n = Number(s);
    return Number.isFinite(n) ? round2(n) : null;
}

function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function normalizeCompact(input) {
    return String(input || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

function toISODateFromNL(dmy) {
    // verwacht DD-MM-YYYY
    if (!dmy) return null;
    const m = String(dmy).match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!m) return null;
    const dd = m[1], mm = m[2], yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
}

function normalizeIbanNL(raw) {
    if (!raw) return null;
    const iban = String(raw).toUpperCase().replace(/\s+/g, "");
    // NL + 2 digits + 4 letters + 10 digits
    if (!/^NL\d{2}[A-Z]{4}\d{10}$/.test(iban)) return null;
    return iban;
}

function weekNumberFromISO(iso) {
    if (!iso) return null;
    const d = new Date(iso + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) return null;

    // ISO week number
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return weekNo;
}

export async function extractPdfTextFromBuffer(input) {
    // pdfjs wil een echte Uint8Array, geen Node Buffer
    const data = Buffer.isBuffer(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : (input instanceof Uint8Array ? input : new Uint8Array(input));

    const doc = await pdfjs.getDocument({ data }).promise;

    let out = "";
    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        out += tc.items.map(i => i.str).join(" ") + "\n";
    }
    return out;
}

function computeTotals(items, btwPct) {
    const subtotal = round2((items || []).reduce((s, it) => s + (Number(it.total_excl_btw) || 0), 0));
    const pct = Number.isFinite(btwPct) ? btwPct : 21;
    const btwAmount = round2(subtotal * (pct / 100));
    const total = round2(subtotal + btwAmount);
    return {
        subtotal_excl_btw: subtotal,
        btw_percentage: pct,
        btw_amount: btwAmount,
        total_incl_btw: total
    };
}

// Let op: dit is jouw bestaande factoring rekentje.
// We houden hem, maar sturen type "3_days" alleen als pct-regel in factuur aanwezig is.
function computeFactoring(subtotalExcl, type) {
    let pct = 0;
    if (type === "3_days") pct = 2.9;
    if (type === "1_minute") pct = 0; // placeholder
    const fee = round2(subtotalExcl * (pct / 100));
    const btw = round2(fee * 0.21);
    const total = round2(fee + btw);
    return { percentage: pct, factoring_fee_excl: fee, factoring_btw: btw, factoring_total: total };
}

export function parseInvoiceTextToJson(text) {
    const t = String(text || "");
    const tFlat = t.replace(/\s+/g, " ");
    const tCompact = normalizeCompact(t);

    // -------------------- payment term --------------------
    const termMatch = t.match(/betalingstermijn\s+van\s+(\d{1,3})\s+dagen/i);
    const payment_term_days = termMatch ? Number(termMatch[1]) : null;

    // -------------------- 1minute paid detectie --------------------
    // Jij gaf: "Bedragen op deze factuur zijn reeds betaald via 1minute payment"
    // Soms staat er "1 minute" met spatie, of andere casing.
    const hasOneMinutePayment =
        /1\s*minute\s*payment/i.test(t) ||
        tCompact.includes("1minutepayment") ||
        tCompact.includes("oneminutepayment");
    const hasPaidSignal =
        /reeds\s+betaald/i.test(t) ||
        /already\s+paid/i.test(t) ||
        tCompact.includes("reedsbetaald");
    const isOneMinutePaid = hasOneMinutePayment && hasPaidSignal;

    // -------------------- wait on client detectie --------------------
    // In praktijk is "betalingstermijn van X dagen" al voldoende signaal.
    const isWaitOnClient =
        /wachten?\s+op\s+opdracht\s*gever/i.test(t) ||
        /uitbetalings?\s*methode\s*[:\-]?\s*wachten?\s+op\s+opdracht\s*gever/i.test(t) ||
        /payment\s*method\s*[:\-]?\s*wait(?:ing)?\s+on\s+client/i.test(t) ||
        tCompact.includes("wachtenopopdrachtgever") ||
        (payment_term_days != null && Number.isFinite(payment_term_days) && payment_term_days > 0);

    // -------------------- basic fields --------------------
    const btw_number =
        (t.match(/BTW[-\s]?nummer\s*[:\-]?\s*(NL[0-9A-Z]{9}B[0-9]{2})/i) || [])[1] || null;

    const ibanRaw =
        (t.match(/IBAN[-\s]?nummer\s*[:\-]?\s*([A-Z]{2}\s*\d{2}\s*[A-Z]{4}\s*\d{10})/i) || [])[1] ||
        (t.match(/\bNL\s*\d{2}\s*[A-Z]{4}\s*\d{10}\b/i) || [])[0] ||
        null;

    const iban = normalizeIbanNL(ibanRaw);

    const external_invoice_number =
        (t.match(/Factuurnummer\s*[:\-]?\s*([A-Z0-9\-\/]+)/i) || [])[1] || null;

    const invoiceDateNL =
        (t.match(/Factuurdatum\s*[:\-]?\s*(\d{2}-\d{2}-\d{4})/i) || [])[1] || null;

    const invoice_date = toISODateFromNL(invoiceDateNL);
    const week_number = weekNumberFromISO(invoice_date);

    // client name (na "Aan:" vaak)
    let client_name = null;
    const aan = t.match(/Aan:\s*([^\n]+?)(?=\s+Factuurnummer|\s+Factuurdatum|$)/i);
    if (aan && aan[1]) client_name = aan[1].trim();

    // -------------------- items --------------------
    const invoice_items = [];

    const pushInvoiceItem = ({ quantityRaw, rateRaw, totalRaw, description = "Uren tarief" }) => {
        const quantity = toNumberEU(quantityRaw);
        const rate = toNumberEU(rateRaw);
        const total = toNumberEU(totalRaw);

        const q = Number.isFinite(quantity) ? quantity : null;
        const r = Number.isFinite(rate) ? rate : null;
        let tEx = Number.isFinite(total) ? total : null;
        if (tEx == null && q != null && r != null) tEx = round2(q * r);

        if (q == null && r == null && tEx == null) return;

        invoice_items.push({
            description,
            quantity: q ?? 0,
            unit: "uren",
            rate: r ?? 0,
            total_excl_btw: tEx ?? 0
        });
    };

    // voorbeeld: "Uren tarief 43 21-10-2025 8,00 Uren € 23.00 € 184.00"
    const lineRegex = /Uren\s*tarief\s+(\d+)\s+(\d{2}[-/.]\d{2}[-/.]\d{4})\s+([\d.,]+)\s+(?:Uren|uur|hours?)\s+€?\s*([\d.,]+)\s+€?\s*([\d.,]+)/gi;
    let m;
    while ((m = lineRegex.exec(tFlat)) !== null) {
        pushInvoiceItem({
            quantityRaw: m[3],
            rateRaw: m[4],
            totalRaw: m[5],
            description: "Uren tarief"
        });
    }

    // OCR fallback: sommige PDFs missen "Uren tarief" maar hebben wel datum + qty + rate + total.
    if (invoice_items.length === 0) {
        const looseLineRegex = /\d{2}[-/.]\d{2}[-/.]\d{4}\s+([\d.,]+)\s+(?:Uren|uur|hours?)\s+€?\s*([\d.,]+)\s+€?\s*([\d.,]+)/gi;
        let lm;
        while ((lm = looseLineRegex.exec(tFlat)) !== null) {
            pushInvoiceItem({
                quantityRaw: lm[1],
                rateRaw: lm[2],
                totalRaw: lm[3],
                description: "Uren"
            });
        }
    }

    // fallback als geen items gevonden: probeer subtotal uit samenvatting
    const subtotalRaw = (t.match(/Bedrag\s+excl\.\s*BTW\s*€?\s*([\d.,]+)/i) || [])[1] || null;
    const subtotal = toNumberEU(subtotalRaw);
    const summaryHours = toNumberEU(
        (t.match(/(?:totaal(?:\s+gewerkte)?\s+uren|aantal\s+uren)\s*[:\-]?\s*([\d.,]+)/i) || [])[1] || null
    );
    const summaryRate = toNumberEU(
        (t.match(/(?:uurtarief|tarief\s*per\s*uur)\s*[:\-]?\s*€?\s*([\d.,]+)/i) || [])[1] || null
    );

    if (invoice_items.length === 0) {
        if (subtotal != null) {
            let qty = Number.isFinite(summaryHours) && summaryHours > 0 ? summaryHours : null;
            let rate = Number.isFinite(summaryRate) && summaryRate > 0 ? summaryRate : null;

            if (qty == null && rate != null && rate > 0) {
                qty = round2(subtotal / rate);
            }
            if (rate == null && qty != null && qty > 0) {
                rate = round2(subtotal / qty);
            }

            invoice_items.push({
                description: "Uren tarief (fallback)",
                quantity: qty != null && qty > 0 ? qty : 1,
                unit: "uren",
                rate: rate != null && rate > 0 ? rate : subtotal,
                total_excl_btw: subtotal
            });
        } else {
            invoice_items.push({
                description: null,
                quantity: 0,
                unit: "uren",
                rate: 0,
                total_excl_btw: 0
            });
        }
    }

    // Laatste fallback: als we wel uren hebben, maar geen bruikbaar tarief, leid tarief af uit subtotal.
    const hasPositiveRate = invoice_items.some((it) => Number.isFinite(Number(it?.rate)) && Number(it.rate) > 0);
    const totalHours = invoice_items.reduce((sum, it) => {
        const q = Number(it?.quantity || 0);
        return sum + (Number.isFinite(q) ? q : 0);
    }, 0);
    if (!hasPositiveRate && subtotal != null && Number.isFinite(totalHours) && totalHours > 0) {
        const inferredRate = round2(subtotal / totalHours);
        if (Number.isFinite(inferredRate) && inferredRate > 0) {
            for (const it of invoice_items) {
                const q = Number(it?.quantity || 0);
                it.rate = inferredRate;
                it.total_excl_btw = Number.isFinite(q) && q > 0 ? round2(q * inferredRate) : it.total_excl_btw;
            }
        }
    }

    // -------------------- totals --------------------
    const btwAmountRaw = (t.match(/\bBTW\s*21%?\s*€?\s*([\-\d.,]+)/i) || [])[1] || null;
    const btwAmountMaybe = toNumberEU(btwAmountRaw);

    const totalRaw = (t.match(/Factuurbedrag\s*€?\s*([\-\d.,]+)/i) || [])[1] || null;
    const totalMaybe = toNumberEU(totalRaw);

    // bepaal btw_percentage: als btw bedrag expliciet 0 => 0, anders default 21
    const btw_percentage = btwAmountMaybe === 0 ? 0 : 21;

    const totals = computeTotals(invoice_items, btw_percentage);

    const total_incl_btw = totalMaybe != null ? round2(totalMaybe) : totals.total_incl_btw;
    const subtotal_excl_btw = totals.subtotal_excl_btw;
    const btw_amount = btwAmountMaybe != null ? round2(btwAmountMaybe) : round2(total_incl_btw - subtotal_excl_btw);

    // -------------------- factoring method detectie --------------------
    //
    // mapping naar frontend select values:
    // - one_minute_paid
    // - payout_3days_paid
    // - wait_on_client
    //
    // En we zetten factoringType correct voor computeFactoring:
    // - "3_days" wanneer Percentage X % regel bestaat
    // - anders "no_factoring"
    //
    let factoring_method = "";
    let factoringType = "no_factoring";

    if (isOneMinutePaid) {
        factoring_method = "one_minute_paid";
    } else {
        // 3-days signaal: "Percentage X %"
        const pctMatch = t.match(/Percentage\s*([\d.,]+)\s*%/i);
        const hasThreeDaySignal =
            /\b3\s*(?:dagen|day|days)\b/i.test(t) &&
            /(uitbetaling|betaling|payout)/i.test(t);

        if ((pctMatch && pctMatch[1]) || hasThreeDaySignal) {
            factoring_method = "payout_3days_paid";
            factoringType = "3_days";
        } else if (isWaitOnClient) {
            factoring_method = "wait_on_client";
        } else {
            factoring_method = ""; // onbekend
        }
    }

    // Suggest status (handig voor backend flow)
    const invoice_status_suggested =
        (factoring_method === "one_minute_paid" || factoring_method === "payout_3days_paid")
            ? "paid"
            : "sent";

    // factoring berekening (0 als no_factoring)
    const factoringCalc = computeFactoring(subtotal_excl_btw, factoringType);
    const factoring = {
        type: factoringType,
        percentage: factoringType === "3_days" ? 2.9 : 0,
        factoring_fee_excl: factoringCalc.factoring_fee_excl,
        factoring_btw: factoringCalc.factoring_btw,
        factoring_total: factoringCalc.factoring_total
    };

    // eindbedrag (final payout) prefer uit tekst als gevonden
    const payoutRaw = (t.match(/Eindbedrag\s*€?\s*([\-\d.,]+)/i) || [])[1] || null;
    const payoutMaybe = toNumberEU(payoutRaw);
    const final_payout = payoutMaybe != null
        ? round2(payoutMaybe)
        : round2(total_incl_btw - factoring.factoring_total);

    return {
        external_invoice_number,
        btw_number,
        iban,
        client_name,
        invoice_date,
        week_number,
        currency: "EUR",
        invoice_items,

        subtotal_excl_btw: round2(subtotal_excl_btw),
        btw_percentage,
        btw_amount: round2(btw_amount),
        total_incl_btw: round2(total_incl_btw),

        // nieuw/benodigd voor jouw flow
        payment_term_days,
        factoring_method,
        invoice_status_suggested,

        factoring,
        final_payout: round2(final_payout)
    };
}
