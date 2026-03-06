let auth0Client = null;
let currentUser = null;
let accessToken = null;

let dashboardData = null;
let contactsCache = [];
let projectsCache = [];
let invoicesCache = [];

// Manage modal context
let manageEntityType = null;
let manageEntityId = null;
let attachmentsContext = { entityType: null, entityId: null };


const contactModal = () => new bootstrap.Modal(document.getElementById("contactModal"));
const projectModal = () => new bootstrap.Modal(document.getElementById("projectModal"));
const invoiceModal = () => new bootstrap.Modal(document.getElementById("invoiceModal"));
const manageModal = () => new bootstrap.Modal(document.getElementById("manageModal"));
const quickClientModal = () => new bootstrap.Modal(document.getElementById("quickClientModal"));

let quickClientContext = {
    selectId: null,
    suggestedName: null
};

let invoiceFlowState = {
    scannedUpload: false,
    requireProjectBeforeSave: false,
    pendingProjectFromScan: null,
    projectModalOverInvoice: false
};

let bulkInvoiceState = {
    active: false,
    files: [],
    total: 0,
    processed: 0,
    error: null
};

let invoicingSettings = {
    invoicing_link: ""
};

let fetchInvoicingState = {
    active: false
};

let deleteAllState = {
    active: false
};

function resetInvoiceFlowState() {
    invoiceFlowState = {
        scannedUpload: false,
        requireProjectBeforeSave: false,
        pendingProjectFromScan: null,
        projectModalOverInvoice: false
    };
}

function isInvoiceCreateMode() {
    const id = String(document.getElementById("invoiceId")?.value || "").trim();
    return !id;
}

function isProjectCreateFromInvoiceFlow() {
    return invoiceFlowState.requireProjectBeforeSave && invoiceFlowState.scannedUpload;
}

function updateProjectInvoiceUploadVisibility() {
    const wrap = document.getElementById("projectInvoiceUploadWrap");
    if (!wrap) return;
    wrap.style.display = isProjectCreateFromInvoiceFlow() ? "none" : "";
}

function updateBulkInvoiceProgress() {
    const el = document.getElementById("bulkInvoiceProgress");
    if (!el) return;

    if (!bulkInvoiceState.total) {
        el.classList.add("d-none");
        el.textContent = "";
        return;
    }

    let txt = `${bulkInvoiceState.processed} van ${bulkInvoiceState.total} facturen verwerkt`;
    if (!bulkInvoiceState.active && bulkInvoiceState.processed >= bulkInvoiceState.total) {
        txt += " (klaar)";
    }
    if (bulkInvoiceState.error) {
        txt += ` - ${bulkInvoiceState.error}`;
    }

    el.textContent = txt;
    el.classList.remove("d-none");
}

async function processNextBulkInvoice() {
    if (!bulkInvoiceState.active) return;

    if (bulkInvoiceState.processed >= bulkInvoiceState.total) {
        bulkInvoiceState.active = false;
        updateBulkInvoiceProgress();
        return;
    }

    const file = bulkInvoiceState.files[bulkInvoiceState.processed];
    if (!file) {
        bulkInvoiceState.active = false;
        bulkInvoiceState.error = "Bestand ontbreekt";
        updateBulkInvoiceProgress();
        return;
    }

    await openInvoiceModalForCreate();
    await waitForModalShown("invoiceModal", 450);

    const hint = document.getElementById("invoiceScanHint");
    if (hint) {
        hint.textContent = `Scannen ${bulkInvoiceState.processed + 1}/${bulkInvoiceState.total}: ${file.name}`;
    }

    try {
        await processInvoiceScanFile(file);
    } catch (e) {
        bulkInvoiceState.active = false;
        bulkInvoiceState.error = String(e?.message || e);
        updateBulkInvoiceProgress();
        throw e;
    }
}

async function onBulkInvoiceFilesSelected(e) {
    const input = e?.target;
    const files = Array.from(input?.files || []).filter((f) =>
        String(f?.type || "").toLowerCase().includes("pdf") ||
        String(f?.name || "").toLowerCase().endsWith(".pdf")
    );

    if (input) input.value = "";
    if (!files.length) return;
    if (bulkInvoiceState.active) return;

    bulkInvoiceState = {
        active: true,
        files,
        total: files.length,
        processed: 0,
        error: null
    };
    updateBulkInvoiceProgress();

    try {
        await processNextBulkInvoice();
    } catch (err) {
        console.error("bulk invoice scan error:", err);
    }
}

function populateFetchInvoicingYearOptions() {
    const select = document.getElementById("fetchInvoicingYear");
    if (!select) return;

    const currentYear = new Date().getUTCFullYear();
    const years = [];
    for (let y = currentYear; y >= currentYear - 6; y -= 1) {
        years.push(y);
    }

    const existing = Number(select.value);
    select.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
    select.value = years.includes(existing) ? String(existing) : String(currentYear);
}

function setInvoicingSettingsStatus(message, isError = false) {
    const el = document.getElementById("invoicingSettingsStatus");
    if (!el) return;

    if (!message) {
        el.classList.add("d-none");
        el.classList.remove("text-danger");
        el.textContent = "";
        return;
    }

    el.textContent = message;
    el.classList.remove("d-none");
    el.classList.toggle("text-danger", !!isError);
}

function setFetchInvoicingStatus(message, isError = false) {
    const el = document.getElementById("fetchInvoicingStatus");
    if (!el) return;

    if (!message) {
        el.classList.add("d-none");
        el.classList.remove("text-danger");
        el.textContent = "";
        return;
    }

    el.textContent = message;
    el.classList.remove("d-none");
    el.classList.toggle("text-danger", !!isError);
}

function setDeleteAllStatus(message, isError = false) {
    const el = document.getElementById("deleteAllStatus");
    if (!el) return;

    if (!message) {
        el.classList.add("d-none");
        el.classList.remove("text-danger");
        el.textContent = "";
        return;
    }

    el.textContent = message;
    el.classList.remove("d-none");
    el.classList.toggle("text-danger", !!isError);
}

async function loadInvoicingSettings() {
    const input = document.getElementById("invoicingLinkInput");
    if (!input) return;

    try {
        setInvoicingSettingsStatus("Invoicing instellingen laden...");
        const res = await apiGet("/api/invoices/invoicing-settings");
        invoicingSettings = {
            invoicing_link: String(res?.invoicing_link || "").trim()
        };
        input.value = invoicingSettings.invoicing_link || "";
        setInvoicingSettingsStatus("Invoicing instellingen geladen.");
    } catch (e) {
        console.error("loadInvoicingSettings error:", e);
        setInvoicingSettingsStatus(String(e?.message || e), true);
    }
}

async function saveInvoicingSettingsFromDashboard() {
    const input = document.getElementById("invoicingLinkInput");
    if (!input) return;

    const invoicingLink = String(input.value || "").trim();

    try {
        setInvoicingSettingsStatus("Invoicing link opslaan...");
        const res = await apiJson("/api/invoices/invoicing-settings", "PUT", {
            invoicing_link: invoicingLink || null
        });

        invoicingSettings = {
            invoicing_link: String(res?.invoicing_link || "").trim()
        };
        input.value = invoicingSettings.invoicing_link || "";

        setInvoicingSettingsStatus("Invoicing link opgeslagen.");
    } catch (e) {
        console.error("saveInvoicingSettingsFromDashboard error:", e);
        setInvoicingSettingsStatus(String(e?.message || e), true);
    }
}

async function fetchInvoicingForYear() {
    if (fetchInvoicingState.active) return;

    const select = document.getElementById("fetchInvoicingYear");
    const btn = document.getElementById("fetchInvoicingBtn");
    const year = Number(select?.value || new Date().getUTCFullYear());

    if (!Number.isInteger(year)) {
        setFetchInvoicingStatus("Kies eerst een geldig jaar.", true);
        return;
    }

    fetchInvoicingState.active = true;
    if (btn) btn.disabled = true;
    setFetchInvoicingStatus(`Facturen ophalen voor ${year}...`);

    try {
        const out = await apiJson("/api/invoices/fetch-invoicing", "POST", { year });
        const imported = Number(out?.imported || 0);
        const skipped = Number(out?.skipped_cached || 0);
        const failed = Number(out?.failed || 0);
        const found = Number(out?.found || 0);

        const statusText = `${found} gevonden, ${imported} geïmporteerd, ${skipped} overgeslagen, ${failed} fouten`;
        setFetchInvoicingStatus(statusText, failed > 0);
        await loadAll();
    } catch (e) {
        console.error("fetchInvoicingForYear error:", e);
        setFetchInvoicingStatus(String(e?.message || e), true);
    } finally {
        fetchInvoicingState.active = false;
        if (btn) btn.disabled = false;
    }
}

async function deleteAllTestDataFromDashboard() {
    if (deleteAllState.active) return;

    const btn = document.getElementById("qaDeleteAllTestData");
    const ok = await uiConfirm({
        title: "Alles verwijderen (test)",
        body: "Dit verwijdert ALLE opdrachtgevers, opdrachten en facturen (inclusief notes/bijlagen voor deze entities). Doorgaan?",
        okText: "Ja, alles verwijderen",
        okClass: "btn btn-danger"
    });

    if (!ok) return;

    deleteAllState.active = true;
    if (btn) btn.disabled = true;
    setDeleteAllStatus("Alles verwijderen...");

    try {
        const out = await apiJson("/api/invoices/delete-all-test-data", "POST", {
            confirm: "DELETE_ALL"
        });

        const deleted = out?.deleted || {};
        const contacts = Number(deleted.contacts || 0);
        const projects = Number(deleted.projects || 0);
        const invoices = Number(deleted.invoices || 0);
        setDeleteAllStatus(`${contacts} opdrachtgevers, ${projects} opdrachten, ${invoices} facturen verwijderd.`);

        await loadAll();
    } catch (e) {
        console.error("deleteAllTestDataFromDashboard error:", e);
        setDeleteAllStatus(String(e?.message || e), true);
    } finally {
        deleteAllState.active = false;
        if (btn) btn.disabled = false;
    }
}

function setInvoiceDateFieldsVisibility(isCreateMode) {
    const issueWrap = document.getElementById("invoiceIssueDateWrap");
    const dueWrap = document.getElementById("invoiceDueDateWrap");
    const note = document.getElementById("invoiceHiddenDatesNote");

    if (issueWrap) issueWrap.classList.toggle("d-none", !!isCreateMode);
    if (dueWrap) dueWrap.classList.toggle("d-none", !!isCreateMode);
    if (note) note.classList.toggle("d-none", !isCreateMode);
}

function buildProjectNameFromInvoiceScan(parsed = {}) {
    const client = String(parsed?.client_name || "").trim();
    const invoiceNr = String(parsed?.external_invoice_number || "").trim();
    if (client && invoiceNr) return `${client} - ${invoiceNr}`;
    if (client) return `Opdracht ${client}`;
    if (invoiceNr) return `Opdracht ${invoiceNr}`;
    return "Nieuwe opdracht";
}

function cleanupModalArtifactsIfNoneOpen() {
    const openModals = document.querySelectorAll(".modal.show").length;
    if (openModals > 0) return;

    document.querySelectorAll(".modal-backdrop").forEach((el) => el.remove());
    document.body.classList.remove("modal-open");
    document.body.style.removeProperty("padding-right");
    document.body.style.removeProperty("overflow");
}

async function waitForModalShown(modalId, timeoutMs = 400) {
    const modalEl = document.getElementById(modalId);
    if (!modalEl) return;
    if (modalEl.classList.contains("show")) return;

    await new Promise((resolve) => {
        const onShown = () => {
            modalEl.removeEventListener("shown.bs.modal", onShown);
            resolve();
        };
        modalEl.addEventListener("shown.bs.modal", onShown, { once: true });
        setTimeout(() => {
            modalEl.removeEventListener("shown.bs.modal", onShown);
            resolve();
        }, Math.max(150, Number(timeoutMs) || 400));
    });
}

async function hideModalAndWait(modalId) {
    const modalEl = document.getElementById(modalId);
    if (!modalEl) return;

    const modalInstance = bootstrap.Modal.getInstance(modalEl);
    if (!modalInstance) {
        cleanupModalArtifactsIfNoneOpen();
        return;
    }

    if (!modalEl.classList.contains("show")) {
        modalInstance.hide();
        cleanupModalArtifactsIfNoneOpen();
        return;
    }

    await new Promise((resolve) => {
        const onHidden = () => {
            modalEl.removeEventListener("hidden.bs.modal", onHidden);
            resolve();
        };
        modalEl.addEventListener("hidden.bs.modal", onHidden, { once: true });
        modalInstance.hide();
    });

    cleanupModalArtifactsIfNoneOpen();
}

function showModalAbove(modalId, baseModalId) {
    const modalEl = document.getElementById(modalId);
    if (!modalEl) return;

    modalEl.style.removeProperty("z-index");

    const baseEl = baseModalId ? document.getElementById(baseModalId) : null;
    const baseIsShown = !!(baseEl && baseEl.classList.contains("show"));

    if (!baseIsShown) {
        const inst = bootstrap.Modal.getOrCreateInstance(modalEl);
        inst.show();
        return;
    }

    const rawBaseZ = window.getComputedStyle(baseEl).zIndex;
    const parsedBaseZ = Number.parseInt(rawBaseZ || "1055", 10);
    const stackedZ = Number.isFinite(parsedBaseZ) ? parsedBaseZ + 20 : 1075;

    modalEl.style.zIndex = String(stackedZ);
    modalEl.addEventListener(
        "shown.bs.modal",
        () => {
            const backdrops = document.querySelectorAll(".modal-backdrop");
            const topBackdrop = backdrops[backdrops.length - 1];
            if (topBackdrop) {
                topBackdrop.style.zIndex = String(stackedZ - 5);
            }
            document.body.classList.add("modal-open");
        },
        { once: true }
    );
    modalEl.addEventListener(
        "hidden.bs.modal",
        () => {
            modalEl.style.removeProperty("z-index");
        },
        { once: true }
    );

    const inst = bootstrap.Modal.getOrCreateInstance(modalEl);
    inst.show();
}

function getFirstRateFromParsedInvoice(parsed) {
    const items = Array.isArray(parsed?.invoice_items) ? parsed.invoice_items : [];
    const it = items.find((x) => Number.isFinite(Number(x?.rate)));
    return it ? Number(it.rate) : null;
}

function getTotalHoursFromParsedInvoice(parsed) {
    const items = Array.isArray(parsed?.invoice_items) ? parsed.invoice_items : [];
    return items.reduce((s, it) => {
        const unit = String(it?.unit || "").toLowerCase();
        if (unit !== "uren" && unit !== "uur" && unit !== "hours") return s;
        const q = Number(it?.quantity || 0);
        return s + (Number.isFinite(q) ? q : 0);
    }, 0);
}

function applyParsedInvoiceToProjectForm(parsed = {}, options = {}) {
    const {
        setStatusTo = null,
        setNameFromScan = false
    } = options;

    const parsedSafe = parsed || {};

    if (setNameFromScan) {
        const nameEl = document.getElementById("projectName");
        if (nameEl && !String(nameEl.value || "").trim()) {
            nameEl.value = buildProjectNameFromInvoiceScan(parsedSafe);
        }
    }

    const dateEl = document.getElementById("projectWorkDate");
    const invoiceDate = String(parsedSafe?.invoice_date || "").trim();
    if (dateEl && invoiceDate && !String(dateEl.value || "").trim()) {
        dateEl.value = invoiceDate;
    }

    const fmEl = document.getElementById("projectFactoringMethod");
    if (fmEl && String(parsedSafe?.factoring_method || "").trim()) {
        fmEl.value = String(parsedSafe.factoring_method).trim();
    }

    const firstRate = getFirstRateFromParsedInvoice(parsedSafe);
    const rateEl = document.getElementById("projectRate");
    if (rateEl && (!rateEl.value || rateEl.value === "") && firstRate != null) {
        rateEl.value = firstRate;
    }

    if (firstRate != null) {
        const rateTypeEl = document.getElementById("projectRateType");
        if (rateTypeEl && !String(rateTypeEl.value || "").trim()) {
            rateTypeEl.value = "hourly";
        }
    }

    const statusEl = document.getElementById("projectStatus");
    if (statusEl && setStatusTo) {
        statusEl.value = setStatusTo;
    }

    renderProjectScanJson(parsedSafe);
    autoLinkProjectContactFromScan(parsedSafe);
}

async function promptProjectCreationForScannedInvoice(parsed = null) {
    invoiceFlowState.requireProjectBeforeSave = true;
    invoiceFlowState.pendingProjectFromScan = parsed || invoiceFlowState.pendingProjectFromScan || null;
    invoiceFlowState.projectModalOverInvoice = !!bulkInvoiceState.active;

    if (!invoiceFlowState.projectModalOverInvoice) {
        await hideModalAndWait("invoiceModal");
    }

    await openProjectModalForCreate({
        showAboveModalId: invoiceFlowState.projectModalOverInvoice ? "invoiceModal" : null
    });

    const parsedSafe = invoiceFlowState.pendingProjectFromScan || {};
    applyParsedInvoiceToProjectForm(parsedSafe, {
        setStatusTo: "betaald",
        setNameFromScan: true
    });

    const totalHours = getTotalHoursFromParsedInvoice(parsedSafe);
    setProjectScanHint(
        `Data overgenomen uit factuurscan. Herkende uren: ${Number(totalHours || 0).toLocaleString("nl-NL")} uur.`
    );
    setFormError("projectFormError", "Maak eerst de opdracht aan. Daarna kun je de factuur opslaan.");
}

window.addEventListener("load", async () => {
    try {
        auth0Client = await initAuth0();

        if (window.location.search.includes("code=") || window.location.search.includes("error=")) {
            await auth0Client.handleRedirectCallback();
            window.history.replaceState({}, document.title, "/dashboard.html");
        }

        const isAuthenticated = await auth0Client.isAuthenticated();
        if (!isAuthenticated) {
            window.location.href = "index.html";
            return;
        }

        currentUser = await auth0Client.getUser();
        if (!currentUser) {
            window.location.href = "index.html";
            return;
        }

        displayUserInfoFromAuth0(currentUser);

        accessToken = await auth0Client.getTokenSilently({
            authorizationParams: {
                audience: AUTH0_CONFIG.audience,
            }
        });

        function isAdminFromToken(token) {
            try {
                const payload = JSON.parse(atob(token.split(".")[1]));
                const perms = payload.permissions || [];
                return perms.includes("admin:access");
            } catch {
                return false;
            }
        }

        function toggleAdminLink(token) {
            const el = document.getElementById("adminLink");
            if (!el) return;
            if (isAdminFromToken(token)) el.classList.remove("d-none");
            else el.classList.add("d-none");
        }

        // Na accessToken ophalen:
        toggleAdminLink(accessToken);


        const header = safeJwtHeader(accessToken);
        console.log("TOKEN HEADER USED:", header);
        if (!header || header.alg !== "RS256") {
            alert("Token type is niet correct. Log uit en opnieuw in zodat je een RS256 JWT krijgt.");
            return;
        }

        document.getElementById("logoutBtn").addEventListener("click", async (e) => {
            e.preventDefault();
            await logout(auth0Client);
        });

        wireActions();
        wireQuickActions();

        await loadInvoicingSettings();
        await loadAll();

    } catch (err) {
        console.error("Dashboard init error:", err);
        alert("Kon dashboard niet laden. Check de console (F12).");
    }
});

function safeJwtHeader(token) {
    try {
        return JSON.parse(atob(token.split(".")[0]));
    } catch {
        return null;
    }
}

async function loadAll() {
    dashboardData = await apiGet("/api/dashboard");
    renderUser(dashboardData.user);
    renderStats(dashboardData.stats);
    renderActivities(dashboardData.recent_activities);
    renderVerticalPanels(dashboardData?.vertical || {});

    contactsCache = await apiGet("/api/contacts");
    projectsCache = await apiGet("/api/projects");
    invoicesCache = await apiGet("/api/invoices");

    renderContacts(contactsCache);
    renderProjects(projectsCache);
    renderInvoices(invoicesCache);

    renderMonthRevenue(invoicesCache);

    console.log("[monthRevenue] DOM after loadAll =", document.getElementById("monthRevenue")?.textContent);
    setTimeout(() => {
        console.log("[monthRevenue] DOM after 500ms =", document.getElementById("monthRevenue")?.textContent);
    }, 500);

}

function renderMonthRevenue(invoices) {
    const monthSum = computeCurrentMonthInvoiceRevenue(invoices, new Date());

    const monthRevenueEl = document.getElementById("monthRevenue");
    if (monthRevenueEl) {
        monthRevenueEl.textContent =
            "€" + Number(monthSum || 0).toLocaleString("nl-NL", {
                minimumFractionDigits: 0,
                maximumFractionDigits: 2
            });
    }

    console.log("[monthRevenue] computed sum =", monthSum, "set text =", monthRevenueEl?.textContent);
}


async function ensureLookupsLoaded() {
    // zorg dat caches er zijn voor dropdowns
    if (!contactsCache || contactsCache.length === 0) {
        contactsCache = await apiGet("/api/contacts");
    }
    if (!projectsCache || projectsCache.length === 0) {
        projectsCache = await apiGet("/api/projects");
    }
}

function fillContactSelect(selectEl, contacts, selectedId) {
    if (!selectEl) return;
    const sel = selectedId == null ? "" : String(selectedId);

    const options = [
        `<option value="">Geen</option>`,
        ...(contacts || []).map(c => {
            const v = String(c.id);
            const label = escapeHtml(c.name || c.email || `Contact ${c.id}`);
            const selected = v === sel ? "selected" : "";
            return `<option value="${v}" ${selected}>${label}</option>`;
        })
    ];

    selectEl.innerHTML = options.join("");
}

function fillProjectSelect(selectEl, projects, selectedId) {
    if (!selectEl) return;
    const sel = selectedId == null ? "" : String(selectedId);

    const options = [
        `<option value="">Geen</option>`,
        ...(projects || []).map(p => {
            const v = String(p.id);
            const label = escapeHtml(p.name || `Project ${p.id}`);
            const selected = v === sel ? "selected" : "";
            return `<option value="${v}" ${selected}>${label}</option>`;
        })
    ];

    selectEl.innerHTML = options.join("");
}


function wireQuickActions() {
    document.getElementById("qaNewContact").addEventListener("click", () => openContactModalForCreate());
    document.getElementById("qaNewProject").addEventListener("click", () => openProjectModalForCreate());
    document.getElementById("qaNewInvoice").addEventListener("click", () => openInvoiceModalForCreate());
    const deleteAllBtn = document.getElementById("qaDeleteAllTestData");
    if (deleteAllBtn) {
        deleteAllBtn.addEventListener("click", deleteAllTestDataFromDashboard);
    }
}

function wireActions() {
    document.getElementById("addContactBtn").addEventListener("click", () => openContactModalForCreate());
    document.getElementById("addProjectBtn").addEventListener("click", () => openProjectModalForCreate());
    document.getElementById("addInvoiceBtn").addEventListener("click", () => openInvoiceModalForCreate());
    document.getElementById("projectInvoiceScanBtn").addEventListener("click", scanProjectInvoicePdfFromModal);
    document.getElementById("contactSaveBtn").addEventListener("click", saveContactFromModal);
    document.getElementById("projectSaveBtn").addEventListener("click", saveProjectFromModal);
    document.getElementById("invoiceSaveBtn").addEventListener("click", saveInvoiceFromModal);

    document.getElementById("uploadAttachmentBtn").addEventListener("click", uploadAttachmentFromManage);
    document.getElementById("addNoteBtn").addEventListener("click", addNoteFromManage);

    const mhBtn = document.getElementById("monthHistoryBtn");
    if (mhBtn) mhBtn.addEventListener("click", openMonthHistory);

    document.getElementById("invoiceScanBtn").addEventListener("click", scanInvoicePdfFromModal);
    document.getElementById("invoiceStatus").value = "sent";
    const bulkBtn = document.getElementById("bulkInvoiceBtn");
    const bulkInput = document.getElementById("bulkInvoiceFiles");
    if (bulkBtn && bulkInput) {
        bulkBtn.addEventListener("click", () => bulkInput.click());
        bulkInput.addEventListener("change", onBulkInvoiceFilesSelected);
    }
    const fetchBtn = document.getElementById("fetchInvoicingBtn");
    if (fetchBtn) {
        fetchBtn.addEventListener("click", fetchInvoicingForYear);
    }

    const saveInvoicingSettingsBtn = document.getElementById("saveInvoicingSettingsBtn");
    if (saveInvoicingSettingsBtn) {
        saveInvoicingSettingsBtn.addEventListener("click", saveInvoicingSettingsFromDashboard);
    }

    populateFetchInvoicingYearOptions();
    updateBulkInvoiceProgress();
    const quickBtn = document.getElementById("quickClientSaveBtn");
    if (quickBtn) quickBtn.addEventListener("click", saveQuickClientAndLink);
    document.getElementById("projectStatus").addEventListener("change", updateProjectInvoiceUploadVisibility);


}

// -------------------- API HELPERS --------------------

async function apiGet(endpoint) {
    return apiJson(endpoint, "GET");
}

async function apiJson(endpoint, method, body) {
    if (!accessToken) throw new Error("No accessToken set");

    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        method,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
    });

    if (!res.ok) {
        const text = await res.text();

        // probeer JSON voor blocked
        try {
            const j = JSON.parse(text);
            if (res.status === 403 && j?.blocked) {
                localStorage.setItem("blocked_note", j.note || "");
                window.location.href = "blocked.html";
                return;
            }
        } catch { }

        throw new Error(`${method} ${endpoint} failed: ${res.status} ${text}`);
    }


    if (res.status === 401) {
        const txt = await res.text();
        console.error("401 Unauthorized from", endpoint, txt);
        throw new Error(`401 Unauthorized from ${endpoint}: ${txt}`);
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${method} ${endpoint} failed: ${res.status} ${text}`);
    }

    if (res.status === 204) return null;
    return res.json();


}



async function apiUpload(endpoint, file) {
    if (!accessToken) throw new Error("No accessToken set");

    const fd = new FormData();
    fd.append("file", file);

    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`
            // IMPORTANT: geen Content-Type zetten, browser doet boundary zelf
        },
        body: fd
    });

    if (res.status === 401) {
        const txt = await res.text();
        console.error("401 Unauthorized from", endpoint, txt);
        throw new Error(`401 Unauthorized from ${endpoint}: ${txt}`);
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`POST ${endpoint} failed: ${res.status} ${text}`);
    }

    return res.json();
}

async function apiUploadScan(endpoint, file) {
    if (!accessToken) throw new Error("No accessToken set");

    const fd = new FormData();
    fd.append("file", file);

    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: fd
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`POST ${endpoint} failed: ${res.status} ${txt}`);
    }

    return res.json();
}

async function processInvoiceScanFile(file) {
    const hint = document.getElementById("invoiceScanHint");
    if (hint) hint.textContent = "Scannen...";

    const res = await apiUploadScan("/api/invoices/scan", file);
    if (!res?.ok) {
        throw new Error("Scan response is ongeldig");
    }

    const p = res.parsed || {};
    const createMode = isInvoiceCreateMode();
    invoiceFlowState.scannedUpload = true;
    invoiceFlowState.pendingProjectFromScan = p;

    // vul invoice velden
    if (p.external_invoice_number) document.getElementById("invoiceNumber").value = p.external_invoice_number;
    if (p.invoice_date) {
        document.getElementById("invoiceIssueDate").value = p.invoice_date;
        document.getElementById("invoicePaidDate").value = p.invoice_date;
    }

    // due date: als niet aanwezig, 14 dagen na issue
    if (p.invoice_date) {
        const due = new Date(p.invoice_date + "T00:00:00Z");
        due.setUTCDate(due.getUTCDate() + 14);
        document.getElementById("invoiceDueDate").value = due.toISOString().slice(0, 10);
    }

    // Voor freelancer-flow: gescande factuur is betaald
    if (createMode) {
        document.getElementById("invoiceStatus").value = "paid";
    }

    // amount = total incl btw
    // amount = wat jij echt ontvangt (final_payout)
    const payout = Number(p.final_payout);
    const fallback = Number(p.total_incl_btw);

    if (Number.isFinite(payout)) {
        document.getElementById("invoiceAmount").value = payout;
    } else if (Number.isFinite(fallback)) {
        document.getElementById("invoiceAmount").value = fallback;
    }

    // notes: store full JSON so we keep all scan details without schema changes
    const existingNotes = document.getElementById("invoiceNotes").value.trim();
    const scanJson = JSON.stringify(p, null, 2);

    document.getElementById("invoiceNotes").value =
        existingNotes
            ? `${existingNotes}\n\n[SCAN_JSON]\n${scanJson}`
            : `[SCAN_JSON]\n${scanJson}`;

    await ensureLookupsLoaded();

    const okContact = autoLinkInvoiceContactFromScan(p);
    if (!okContact && !createMode && String(p?.client_name || "").trim()) {
        openQuickClientCreate({
            selectId: "invoiceContactId",
            suggestedName: String(p.client_name).trim()
        });
    }

    if (typeof autoLinkInvoiceContactAndProject === "function") {
        autoLinkInvoiceContactAndProject(p);
    }

    if (createMode) {
        if (hint) hint.textContent = "Scan klaar. Maak eerst de gekoppelde opdracht aan.";
        await promptProjectCreationForScannedInvoice(p);
        return;
    }

    if (hint) hint.textContent = "Scan klaar. Controleer velden en klik Opslaan.";
}

async function scanInvoicePdfFromModal() {
    try {
        setFormError("invoiceFormError", null);

        const input = document.getElementById("invoiceScanFile");
        const file = input?.files?.[0];
        if (!file) {
            setFormError("invoiceFormError", "Kies eerst een PDF bestand om te scannen.");
            return;
        }

        await processInvoiceScanFile(file);
    } catch (e) {
        console.error(e);
        setFormError("invoiceFormError", String(e.message || e));
        const hint = document.getElementById("invoiceScanHint");
        if (hint) hint.textContent = "Scan mislukt. Check console.";
    }
}

function setProjectScanHint(msg) {
    const el = document.getElementById("projectInvoiceScanHint");
    if (el) el.textContent = msg || "";
}

function renderProjectScanJson(obj) {
    const el = document.getElementById("projectInvoiceScanJson");
    if (!el) return;

    if (!obj) {
        el.value = "";
        return;
    }
    el.value = JSON.stringify(obj, null, 2);
}

const monthHistoryModal = () => new bootstrap.Modal(document.getElementById("monthHistoryModal"));


// Handmatig scan voor Project PDF
async function scanProjectInvoicePdfFromModal() {
    try {
        setFormError("projectFormError", null);

        const input = document.getElementById("projectInvoicePdf");
        const file = input?.files?.[0];
        if (!file) {
            setFormError("projectFormError", "Kies eerst een PDF bestand om te scannen.");
            return;
        }

        setProjectScanHint("Scannen...");
        renderProjectScanJson(null);

        const res = await apiUploadScan("/api/invoices/scan", file);
        if (!res?.ok) throw new Error("Scan response is ongeldig");

        const parsed = res.parsed || {};
        await ensureLookupsLoaded();
        applyParsedInvoiceToProjectForm(parsed, {
            setStatusTo: "uitgevoerd",
            setNameFromScan: false
        });

        const totalHours = getTotalHoursFromParsedInvoice(parsed);

        setProjectScanHint(
            `Scan klaar. Status op uitgevoerd gezet. Herkende uren: ${Number(totalHours || 0).toLocaleString("nl-NL")} uur. Controleer velden en klik Opslaan.`
        );
    } catch (e) {
        console.error(e);
        setFormError("projectFormError", String(e.message || e));
        setProjectScanHint("Scan mislukt. Check console.");
        renderProjectScanJson(null);
    }
}




function normalizeName(s) {
    return String(s || "")
        .trim()
        .toLowerCase()
        .replace(/[\s\-_.]+/g, " ")
        .replace(/[^\p{L}\p{N} ]/gu, ""); // verwijder punctuatie (unicode safe)
}

function autoLinkProjectContactFromScan(parsed) {
    const clientNameRaw = String(parsed?.client_name || "").trim();
    const clientNameN = normalizeName(clientNameRaw);
    if (!clientNameN) return;

    let match = (contactsCache || []).find(c => normalizeName(c.name) === clientNameN);

    if (!match) {
        match = (contactsCache || []).find(c => normalizeName(c.company) === clientNameN);
    }

    if (!match) {
        match = (contactsCache || []).find(c => {
            const n = normalizeName(c.name);
            const co = normalizeName(c.company);
            return (n && (n.includes(clientNameN) || clientNameN.includes(n))) ||
                (co && (co.includes(clientNameN) || clientNameN.includes(co)));
        });
    }

    if (!match) {
        // Geen match, quick create opdrachtgever
        openQuickClientCreate({
            selectId: "projectContactId",
            suggestedName: clientNameRaw
        });
        return;
    }

    const projectContactSelect = document.getElementById("projectContactId");
    if (projectContactSelect) projectContactSelect.value = String(match.id);
}


function autoLinkInvoiceContactFromScan(parsed) {
    const clientNameRaw = String(parsed?.client_name || "").trim();
    const clientNameN = normalizeName(clientNameRaw);
    if (!clientNameN) return false;

    let match = (contactsCache || []).find(c => normalizeName(c.name) === clientNameN);
    if (!match) match = (contactsCache || []).find(c => normalizeName(c.company) === clientNameN);

    if (!match) {
        match = (contactsCache || []).find(c => {
            const n = normalizeName(c.name);
            const co = normalizeName(c.company);
            return (n && (n.includes(clientNameN) || clientNameN.includes(n))) ||
                (co && (co.includes(clientNameN) || clientNameN.includes(co)));
        });
    }

    if (!match) return false;

    const sel = document.getElementById("invoiceContactId");
    if (sel) sel.value = String(match.id);

    return true;
}


function setValueById(id, value) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.value = value ?? "";
    return true;
}

function setCheckedById(id, checked) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.checked = !!checked;
    return true;
}






function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[c]));
}

function parseMetaBlock(notes, tag = "META_JSON") {
    const t = String(notes || "");
    const m = t.match(new RegExp(`\\[${tag}\\]\\s*\\n([\\s\\S]*)$`));
    if (!m || !m[1]) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

function upsertMetaBlock(existingNotes, metaObj, tag = "META_JSON") {
    const clean = String(existingNotes || "").replace(new RegExp(`\\n?\\[${tag}\\][\\s\\S]*$`), "").trim();
    const block = `\n\n[${tag}]\n${JSON.stringify(metaObj || {}, null, 2)}`;
    return (clean ? clean : "") + block;
}


// -------------------- RENDER: USER + STATS + ACTIVITY --------------------

function getInvoiceScanJson(inv) {
    if (!inv) return null;
    const sj = inv.scan_json;
    if (!sj) return null;

    // backend kan json of string teruggeven
    if (typeof sj === "object") return sj;

    if (typeof sj === "string") {
        try { return JSON.parse(sj); } catch { return null; }
    }
    return null;
}

function getInvoiceNetTotal(inv) {
    const scan = getInvoiceScanJson(inv);

    // 1) JOUW waarheid: final_payout (wat jij ontvangt)
    const payout = Number(scan?.final_payout);
    if (Number.isFinite(payout)) return payout;

    // 2) fallback: amount kolom (bij upload zetten we amount = final_payout, bij handmatig invullen ook)
    const amount = Number(inv?.amount);
    if (Number.isFinite(amount)) return amount;

    return 0;
}

function parseInvoiceDateForRevenue(raw) {
    const value = String(raw || "").trim();
    if (!value) return null;

    const datePart = value.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
        const y = Number(datePart.slice(0, 4));
        const m = Number(datePart.slice(5, 7));
        const d = Number(datePart.slice(8, 10));
        return new Date(Date.UTC(y, m - 1, d));
    }

    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
}

function getInvoiceMonthDateForRevenue(inv) {
    // Gebruik factuurmaand (issue_date) en niet importmoment (created_at),
    // zodat oudere facturen die nu pas geïmporteerd zijn niet in deze maand tellen.
    return (
        parseInvoiceDateForRevenue(inv?.issue_date) ||
        parseInvoiceDateForRevenue(inv?.paid_date) ||
        null
    );
}

function computeCurrentMonthInvoiceRevenue(invoices, now = new Date()) {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // 0-11

    return (Array.isArray(invoices) ? invoices : []).reduce((sum, inv) => {
        const st = String(inv?.status || "").toLowerCase();
        if (st === "draft" || st === "cancelled") return sum;

        const dt = getInvoiceMonthDateForRevenue(inv);
        if (!dt) return sum;
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m) return sum;

        return sum + getInvoiceNetTotal(inv);
    }, 0);
}





function renderUser(user) {
    const userName = user?.name || user?.email || "Gebruiker";
    document.getElementById("userName").textContent = userName;
    document.getElementById("welcomeName").textContent = userName.split(" ")[0];
    document.getElementById("profileName").textContent = userName;
    document.getElementById("profileEmail").textContent = user?.email || "-";
}

function renderStats(stats) {
    const statCards = document.querySelectorAll(".card-title.mb-0");
    statCards[0].textContent = stats.total_contacts ?? 0;
    statCards[1].textContent = stats.active_projects ?? 0;
    statCards[2].textContent = stats.open_invoices ?? 0;
    // NIET monthRevenue hier zetten
}

function getLatestActivities(activities, limit = 3) {
    if (!Array.isArray(activities)) return [];
    return [...activities]
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, limit);
}



function renderActivities(activities) {
    const el = document.getElementById("activityList");
    const latest = getLatestActivities(activities, 3);
    if (latest.length === 0) {
        el.innerHTML = `<div class="list-group-item text-muted">Nog geen activiteiten</div>`;
        return;
    }

    el.innerHTML = latest.map(a => `
    <div class="list-group-item">
      <div class="d-flex w-100 justify-content-between">
        <h6 class="mb-1">${escapeHtml(a.activity_type || "")}</h6>
        <small class="text-muted">${new Date(a.created_at).toLocaleString("nl-NL")}</small>
      </div>
      <p class="mb-1 small">${escapeHtml(a.description || "")}</p>
    </div>
  `).join("");
}

// -------------------- TABLES: CONTACTS / PROJECTS / INVOICES --------------------

function renderContacts(items) {
    const tbody = document.getElementById("contactsTbody");
    if (!items || items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-muted">Nog geen Opdrachtgevers</td></tr>`;
        return;
    }

    tbody.innerHTML = items.map(c => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.email || "")}</td>
      <td>${escapeHtml(c.phone || "")}</td>
      <td>${escapeHtml(c.company || "")}</td>
      <td class="text-end">
        <div class="btn-group crm-actions" role="group">
          <button class="btn btn-sm btn-outline-primary" onclick="window.__edit('contacts', ${c.id})">
            <i class="bi bi-pencil"></i>
          </button>
          <button class="btn btn-sm btn-outline-secondary" onclick="window.__manage('contacts', ${c.id})" title="Bijlagen en notities">
            <i class="bi bi-paperclip"></i>
          </button>
          <button class="btn btn-sm btn-outline-danger" onclick="window.__del('contacts', ${c.id})">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderProjects(items) {
    const tbody = document.getElementById("projectsTbody");
    if (!items || items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Nog geen Opdrachten</td></tr>`;
        return;
    }

    tbody.innerHTML = items.map(p => `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${projectStatusBadge(p.status)}</td>
      <td>${escapeHtml(p.contact_name || "")}</td>
      <td>${p.budget == null ? "" : "€" + Number(p.budget).toLocaleString("nl-NL")}</td>
      <td>${p.spent == null ? "" : "€" + Number(p.spent).toLocaleString("nl-NL")}</td>
      <td class="text-end">
        <div class="btn-group crm-actions" role="group">
          <button class="btn btn-sm btn-outline-primary" onclick="window.__edit('projects', ${p.id})">
            <i class="bi bi-pencil"></i>
          </button>
          <button class="btn btn-sm btn-outline-secondary" onclick="window.__manage('projects', ${p.id})" title="Bijlagen en notities">
            <i class="bi bi-paperclip"></i>
          </button>
          <button class="btn btn-sm btn-outline-danger" onclick="window.__del('projects', ${p.id})">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderInvoices(items) {
    const tbody = document.getElementById("invoicesTbody");
    if (!items || items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-muted">Nog geen facturen</td></tr>`;
        return;
    }

    tbody.innerHTML = items.map(i => `
    <tr>
      <td>${escapeHtml(i.invoice_number)}</td>
      <td>${invoiceStatusBadge(i.status)}</td>
      <td>€${Number(getInvoiceNetTotal(i) || 0).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td>${escapeHtml(i.project_name || "")}</td>
      <td>${escapeHtml(i.contact_name || "")}</td>
      <td>${i.due_date ? escapeHtml(String(i.due_date).slice(0, 10)) : ""}</td>
      <td class="text-end">
        <div class="btn-group crm-actions" role="group">
          <button class="btn btn-sm btn-outline-primary" onclick="window.__edit('invoices', ${i.id})">
            <i class="bi bi-pencil"></i>
          </button>
          <button class="btn btn-sm btn-outline-secondary" onclick="window.__manage('invoices', ${i.id})" title="Bijlagen en notities">
            <i class="bi bi-paperclip"></i>
          </button>
          <button class="btn btn-sm btn-outline-danger" onclick="window.__del('invoices', ${i.id})">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

function projectStatusBadge(status) {
    const s = String(status || "").toLowerCase();
    let cls = "bg-secondary";
    if (s === "gepland") cls = "bg-secondary";
    if (s === "uitgevoerd") cls = "bg-primary";
    if (s === "gefactureerd") cls = "bg-warning text-dark";
    if (s === "betaald") cls = "bg-success";
    return `<span class="badge badge-status ${cls}">${escapeHtml(s || "-")}</span>`;
}


function invoiceStatusBadge(status) {
    const s = String(status || "").toLowerCase();
    let cls = "bg-secondary";
    if (s === "draft") cls = "bg-secondary";
    if (s === "sent") cls = "bg-primary";
    if (s === "paid") cls = "bg-success";
    if (s === "overdue") cls = "bg-danger";
    if (s === "cancelled") cls = "bg-dark";
    return `<span class="badge badge-status ${cls}">${escapeHtml(s || "-")}</span>`;
}

function uiConfirm({ title = "Bevestigen", body = "Weet je het zeker?", okText = "OK", okClass = "btn-danger" } = {}) {
    return new Promise((resolve) => {
        const modalEl = document.getElementById("confirmModal");
        if (!modalEl) {
            // Fallback (zou eigenlijk niet gebeuren als je modal toevoegt)
            resolve(window.confirm(body));
            return;
        }

        const titleEl = document.getElementById("confirmModalTitle");
        const bodyEl = document.getElementById("confirmModalBody");
        const okBtn = document.getElementById("confirmModalOk");

        if (titleEl) titleEl.textContent = title;
        if (bodyEl) bodyEl.textContent = body;

        // reset classes (houden basis btn)
        okBtn.className = "btn";
        okBtn.classList.add(...String(okClass || "btn-danger").split(" "));
        okBtn.textContent = okText;

        const bsModal = new bootstrap.Modal(modalEl, { backdrop: "static", keyboard: true });

        let decided = false;

        const cleanup = () => {
            okBtn.removeEventListener("click", onOk);
            modalEl.removeEventListener("hidden.bs.modal", onHidden);
        };

        const onOk = () => {
            decided = true;
            cleanup();
            bsModal.hide();
            resolve(true);
        };

        const onHidden = () => {
            // Als user sluit via X / cancel / backdrop => false
            if (!decided) {
                cleanup();
                resolve(false);
            }
        };

        okBtn.addEventListener("click", onOk);
        modalEl.addEventListener("hidden.bs.modal", onHidden);

        bsModal.show();
    });
}

// -------------------- CRUD: DELETE --------------------




async function deleteEntity(type, id) {
    const isProject = type === "projects";
    const isInvoice = type === "invoices";

    const ok = await uiConfirm({
        title: "Verwijderen",
        body: isProject
            ? "Opdracht verwijderen? De gekoppelde factuur wordt ook verwijderd."
            : isInvoice
                ? "Factuur verwijderen? De gekoppelde opdracht wordt ook verwijderd."
                : "Weet je zeker dat je dit wilt verwijderen?",
        okText: "Verwijderen",
        okClass: "btn btn-danger"
    });

    if (!ok) return;

    // cascade delete via query param
    const url = (isProject || isInvoice)
        ? `/api/${type}/${id}?cascade=1`
        : `/api/${type}/${id}`;

    await apiJson(url, "DELETE");
    await loadAll();
}

window.__del = async (type, id) => {
    try {
        await deleteEntity(type, id);
    } catch (e) {
        console.error(e);
        // geen browser alert meer: toon netjes in console + eventueel in UI later
        // Voor nu: simpele fallback in UI (kan je ook in een toast zetten)
        alert("Verwijderen mislukt. Check console.");
    }
};

// -------------------- CRUD: EDIT/CREATE MODALS --------------------

window.__edit = async (type, id) => {
    if (type === "contacts") {
        const c = contactsCache.find(x => x.id === id);
        openContactModalForEdit(c);
        return;
    }
    if (type === "projects") {
        const p = projectsCache.find(x => x.id === id);
        openProjectModalForEdit(p);
        return;
    }
    if (type === "invoices") {
        const i = invoicesCache.find(x => x.id === id);
        openInvoiceModalForEdit(i);
        return;
    }
};

function openContactModalForCreate() {
    setContactForm({ id: "", name: "", email: "", phone: "", company: "" });
    document.getElementById("contactModalTitle").textContent = "Nieuwe opdrachtgever";
    setFormError("contactFormError", null);
    contactModal().show();
}

function openContactModalForEdit(c) {
    if (!c) return;
    setContactForm(c);
    document.getElementById("contactModalTitle").textContent = "Contact bewerken";
    setFormError("contactFormError", null);
    contactModal().show();
}

function setContactForm(c) {
    const meta = parseMetaBlock(c.notes, "CONTACT_META") || {};

    document.getElementById("contactId").value = c.id || "";

    // Bedrijfsnaam -> we gebruiken bestaande kolom `name`
    document.getElementById("contactName").value = c.name || "";

    document.getElementById("contactEmail").value = c.email || "";
    document.getElementById("contactPhone").value = c.phone || "";

    // bestaand veld (optioneel)
    const companyEl = document.getElementById("contactCompany");
    if (companyEl) companyEl.value = c.company || "";

    // nieuw
    const typeEl = document.getElementById("contactType");
    if (typeEl) typeEl.value = meta.type || "";

    const personEl = document.getElementById("contactPerson");
    if (personEl) personEl.value = meta.contact_person || "";

    const vatEl = document.getElementById("contactVat");
    if (vatEl) vatEl.value = meta.vat || "";

    const kvkEl = document.getElementById("contactKvk");
    if (kvkEl) kvkEl.value = meta.kvk || "";

    const payEl = document.getElementById("contactPaymentTerm");
    if (payEl) payEl.value = meta.payment_term_days ?? "";

    const rateEl = document.getElementById("contactDefaultRate");
    if (rateEl) rateEl.value = meta.default_rate ?? "";

    const notesEl = document.getElementById("contactNotes");
    if (notesEl) notesEl.value = meta.notes || "";
}


async function saveContactFromModal() {
    try {
        setFormError("contactFormError", null);

        const id = document.getElementById("contactId").value;

        const name = document.getElementById("contactName").value.trim();
        const email = document.getElementById("contactEmail").value.trim();
        const phone = document.getElementById("contactPhone").value.trim();
        const company = (document.getElementById("contactCompany")?.value || "").trim();

        if (!name) {
            setFormError("contactFormError", "Bedrijfsnaam is verplicht.");
            return;
        }

        // nieuw (uit modal)
        const meta = {
            type: (document.getElementById("contactType")?.value || "").trim(),
            contact_person: (document.getElementById("contactPerson")?.value || "").trim(),
            vat: (document.getElementById("contactVat")?.value || "").trim(),
            kvk: (document.getElementById("contactKvk")?.value || "").trim(),
            payment_term_days: (() => {
                const v = document.getElementById("contactPaymentTerm")?.value;
                return v === "" || v == null ? null : Number(v);
            })(),
            default_rate: (() => {
                const v = document.getElementById("contactDefaultRate")?.value;
                return v === "" || v == null ? null : Number(v);
            })(),
            notes: (document.getElementById("contactNotes")?.value || "").trim()
        };

        if (meta.payment_term_days != null && !Number.isFinite(meta.payment_term_days)) meta.payment_term_days = null;
        if (meta.default_rate != null && !Number.isFinite(meta.default_rate)) meta.default_rate = null;

        // opslaan in contacts.notes als CONTACT_META blok
        const existing = id ? (contactsCache.find(x => String(x.id) === String(id))?.notes || "") : "";
        const notes = upsertMetaBlock(existing, meta, "CONTACT_META");

        // we gebruiken bestaande schema velden
        const payload = {
            name,
            email: email || null,
            phone: phone || null,
            company: company || null,
            position: null, // niet gebruikt nu
            notes
        };

        if (id) {
            await apiJson(`/api/contacts/${id}`, "PUT", payload);
        } else {
            await apiJson(`/api/contacts`, "POST", payload);
        }

        bootstrap.Modal.getInstance(document.getElementById("contactModal")).hide();
        await loadAll();

    } catch (e) {
        console.error(e);
        setFormError("contactFormError", String(e.message || e));
    }
}


async function openProjectModalForCreate(options = {}) {
    const { showAboveModalId = null } = options || {};
    await ensureLookupsLoaded();

    setProjectForm({
        id: "",
        name: "",
        status: "active",
        budget: "",
        spent: "",
        contact_id: ""
    });

    document.getElementById("projectModalTitle").textContent = "Nieuwe opdracht";
    updateProjectInvoiceUploadVisibility();
    setFormError("projectFormError", null);
    if (showAboveModalId) {
        showModalAbove("projectModal", showAboveModalId);
    } else {
        projectModal().show();
    }
}

async function openProjectModalForEdit(p) {
    if (!p) return;
    await ensureLookupsLoaded();

    setProjectForm(p);
    document.getElementById("projectModalTitle").textContent = "Opdracht Bewerken";
    updateProjectInvoiceUploadVisibility();
    setFormError("projectFormError", null);
    const projectEl = document.getElementById("projectModal");
    if (projectEl) projectEl.style.removeProperty("z-index");
    projectModal().show();
}

function setProjectForm(p) {
    const meta = parseMetaBlock(p.description, "OPDRACHT_META") || {};
    const scanRaw = p.invoice_scan_json || meta.invoice_scan || null;
    const scan = (() => {
        if (!scanRaw) return null;
        if (typeof scanRaw === "object") return scanRaw;
        if (typeof scanRaw === "string") {
            try {
                return JSON.parse(scanRaw);
            } catch {
                return null;
            }
        }
        return null;
    })();

    document.getElementById("projectId").value = p.id || "";
    document.getElementById("projectName").value = p.name || "";

    const statusEl = document.getElementById("projectStatus");
    statusEl.value = p.status || "gepland";

    const contactSelect = document.getElementById("projectContactId");
    fillContactSelect(contactSelect, contactsCache, p.contact_id || "");

    const locEl = document.getElementById("projectLocation");
    if (locEl) locEl.value = meta.location || "";

    const rtEl = document.getElementById("projectRateType");
    if (rtEl) rtEl.value = meta.rate_type || p.tarief_type || "hourly";

    const rEl = document.getElementById("projectRate");
    if (rEl) rEl.value = meta.rate ?? (p.tarief ?? "");

    const fmEl = document.getElementById("projectFactoringMethod");
    if (fmEl) {
        const fm = String(meta.factoring_method || scan?.factoring_method || "").trim();
        fmEl.value = fm;
    }

    const wdEl = document.getElementById("projectWorkDate");
    if (wdEl) {
        const dt =
            meta.period_start ||
            p.period_start ||
            p.periode_start ||
            (p.start_date ? String(p.start_date).slice(0, 10) : "");
        wdEl.value = dt ? String(dt).slice(0, 10) : "";
    }

    const descEl = document.getElementById("projectDescription");
    if (descEl) descEl.value = meta.notes || "";

    const wsEl = document.getElementById("projectWorkStart");
    if (wsEl) wsEl.value = p.work_start ? String(p.work_start).slice(0, 5) : "";

    const weEl = document.getElementById("projectWorkEnd");
    if (weEl) weEl.value = p.work_end ? String(p.work_end).slice(0, 5) : "";

    // invoice link (DB veld)
    const invIdEl = document.getElementById("projectInvoiceId");
    if (invIdEl) invIdEl.value = p.invoice_id ? String(p.invoice_id) : "";

    // scan json tonen (voorkeur: DB invoice_scan_json, fallback: meta.invoice_scan)
    renderProjectScanJson(scan);

    // reset file input (altijd)
    const pdf = document.getElementById("projectInvoicePdf");
    if (pdf) pdf.value = "";

    setProjectScanHint("");
}




async function saveProjectFromModal() {
    try {
        setFormError("projectFormError", null);

        const getVal = (id) => {
            const el = document.getElementById(id);
            return el ? String(el.value || "") : "";
        };

        const setVal = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value ?? "";
        };

        const id = getVal("projectId").trim();
        const name = getVal("projectName").trim();

        if (!name) {
            setFormError("projectFormError", "Opdrachtnaam is verplicht.");
            return;
        }

        const status = getVal("projectStatus").trim() || "gepland";
        const st = status.toLowerCase();
        const needsInvoice = (st === "gefactureerd" || st === "betaald");
        const isLinkedInvoiceFlow = isProjectCreateFromInvoiceFlow();

        let invoiceId = getVal("projectInvoiceId").trim();

        // scan json uit textarea
        let scanObj = null;
        const scanText = getVal("projectInvoiceScanJson").trim();
        if (scanText) {
            try { scanObj = JSON.parse(scanText); } catch { scanObj = null; }
        }

        // Validatie bij factuurstatus
        if (needsInvoice && !invoiceId && !isLinkedInvoiceFlow) {
            const pdfInput = document.getElementById("projectInvoicePdf");
            const file = pdfInput?.files?.[0];

            if (!file) {
                setFormError("projectFormError", "Factuur PDF is verplicht bij gefactureerd/betaald.");
                return;
            }
            if (!scanObj) {
                setFormError("projectFormError", "Klik eerst op 'Scan factuur' zodat de factuurdata wordt ingelezen.");
                return;
            }
        }

        const contactIdRaw = getVal("projectContactId").trim();

        const workDate = getVal("projectWorkDate").trim() || null;
        const periodStart = getVal("projectPeriodStart").trim() || workDate || null;
        const periodEnd = getVal("projectPeriodEnd").trim() || periodStart || null;

        const meta = {
            location: getVal("projectLocation").trim(),
            rate_type: getVal("projectRateType").trim() || "hourly",
            rate: (() => {
                const v = getVal("projectRate");
                return v === "" ? null : Number(v);
            })(),
            period_start: periodStart,
            period_end: periodEnd,
            notes: getVal("projectDescription").trim(),
            invoice_scan: scanObj,
            factoring_method: getVal("projectFactoringMethod").trim() || null
        };

        if (meta.rate != null && !Number.isFinite(meta.rate)) meta.rate = null;

        const existing = id
            ? (projectsCache.find(x => String(x.id) === String(id))?.description || "")
            : "";

        const description = upsertMetaBlock(existing, meta, "OPDRACHT_META");

        const workStart = getVal("projectWorkStart").trim() || null;
        const workEnd = getVal("projectWorkEnd").trim() || null;

        const basePayload = {
            name,
            description: description || null,
            status: needsInvoice ? "uitgevoerd" : status,

            // oude kolommen (mag blijven)
            start_date: meta.period_start,
            end_date: meta.period_end,

            // nieuwe kolommen in projects tabel
            locatie: meta.location || null,
            tarief_type: meta.rate_type || "hourly",
            tarief: meta.rate,

            periode_start: meta.period_start,
            periode_end: meta.period_end,

            budget: null,
            spent: 0,
            contact_id: contactIdRaw === "" ? null : Number(contactIdRaw),
            work_start: workStart,
            work_end: workEnd,
            invoice_id: invoiceId ? Number(invoiceId) : null
        };

        if (basePayload.contact_id != null && !Number.isFinite(basePayload.contact_id)) {
            setFormError("projectFormError", "Opdrachtgever selectie is ongeldig.");
            return;
        }

        if (basePayload.invoice_id != null && !Number.isFinite(basePayload.invoice_id)) {
            basePayload.invoice_id = null;
        }

        let projectRow;
        if (id)
            projectRow = await apiJson(`/api/projects/${id}`, "PUT", basePayload);
        else
            projectRow = await apiJson(`/api/projects`, "POST", basePayload);

        // Upload factuur indien nodig
        if (needsInvoice && !invoiceId && !isLinkedInvoiceFlow) {
            const pdfInput = document.getElementById("projectInvoicePdf");
            const file = pdfInput?.files?.[0];

            const out = await apiUploadProjectInvoice(
                `/api/projects/${projectRow.id}/invoice-upload`,
                file
            );

            const newInvoiceId = out?.project?.invoice_id || out?.invoice?.id || null;

            if (!newInvoiceId) {
                throw new Error("Upload gelukt maar geen invoice_id teruggekregen.");
            }

            invoiceId = String(newInvoiceId);
            setVal("projectInvoiceId", invoiceId);

            if (out?.parsed) renderProjectScanJson(out.parsed);
        }

        // Definitieve status update
        if (needsInvoice && (!isLinkedInvoiceFlow || invoiceId)) {
            await apiJson(`/api/projects/${projectRow.id}`, "PUT", {
                ...basePayload,
                status,
                invoice_id: invoiceId ? Number(invoiceId) : null
            });
        }

        const continueInvoiceFlow =
            invoiceFlowState.requireProjectBeforeSave && invoiceFlowState.scannedUpload;
        const keepInvoiceOpen = continueInvoiceFlow && invoiceFlowState.projectModalOverInvoice;
        if (continueInvoiceFlow) {
            invoiceFlowState.requireProjectBeforeSave = false;
        }

        await hideModalAndWait("projectModal");
        await loadAll();

        if (continueInvoiceFlow) {
            const invoiceProjectSelect = document.getElementById("invoiceProjectId");
            if (invoiceProjectSelect) {
                fillProjectSelect(invoiceProjectSelect, projectsCache, projectRow.id);
                invoiceProjectSelect.value = String(projectRow.id);
            }

            const invoiceContactSelect = document.getElementById("invoiceContactId");
            if (invoiceContactSelect && projectRow?.contact_id != null) {
                fillContactSelect(invoiceContactSelect, contactsCache, projectRow.contact_id);
                invoiceContactSelect.value = String(projectRow.contact_id);
            }

            const hint = document.getElementById("invoiceScanHint");
            if (hint) hint.textContent = "Opdracht gekoppeld. Je kunt nu de factuur opslaan.";

            setFormError("invoiceFormError", null);
            const invoiceEl = document.getElementById("invoiceModal");
            const invoiceAlreadyOpen = !!(invoiceEl && invoiceEl.classList.contains("show"));
            if (!keepInvoiceOpen || !invoiceAlreadyOpen) {
                invoiceModal().show();
            } else {
                document.body.classList.add("modal-open");
            }
        }
        invoiceFlowState.projectModalOverInvoice = false;

    } catch (e) {
        console.error(e);
        setFormError("projectFormError", String(e.message || e));
    }
}



async function apiUploadProjectInvoice(endpoint, file) {
    if (!accessToken) throw new Error("No accessToken set");

    const fd = new FormData();
    fd.append("file", file);

    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: fd
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`POST ${endpoint} failed: ${res.status} ${txt}`);
    }

    return res.json();
}





async function openInvoiceModalForCreate() {
    await ensureLookupsLoaded();
    resetInvoiceFlowState();

    const today = new Date().toISOString().slice(0, 10);
    const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

    setInvoiceForm({
        id: "",
        invoice_number: "",
        status: "draft",
        amount: "",
        issue_date: today,
        due_date: due,
        paid_date: "",
        notes: "",
        project_id: "",
        contact_id: ""
    });

    document.getElementById("invoiceModalTitle").textContent = "Nieuwe factuur";
    const createHint = document.getElementById("invoiceScanHint");
    if (createHint) createHint.textContent = "Upload een PDF en klik scan. Velden worden automatisch ingevuld.";
    setInvoiceDateFieldsVisibility(true);
    setFormError("invoiceFormError", null);
    invoiceModal().show();
}

async function openInvoiceModalForEdit(i) {
    if (!i) return;
    await ensureLookupsLoaded();
    resetInvoiceFlowState();

    setInvoiceForm(i);
    document.getElementById("invoiceModalTitle").textContent = "Factuur bewerken";
    const editHint = document.getElementById("invoiceScanHint");
    if (editHint) editHint.textContent = "Upload een PDF en klik scan. Velden worden automatisch ingevuld.";
    setInvoiceDateFieldsVisibility(false);
    setFormError("invoiceFormError", null);
    invoiceModal().show();
}

function setInvoiceForm(i) {
    document.getElementById("invoiceId").value = i.id || "";
    document.getElementById("invoiceNumber").value = i.invoice_number || "";
    document.getElementById("invoiceStatus").value = i.status || "draft";
    document.getElementById("invoiceAmount").value = i.amount == null ? "" : Number(i.amount);

    document.getElementById("invoiceIssueDate").value =
        i.issue_date ? String(i.issue_date).slice(0, 10) : new Date().toISOString().slice(0, 10);

    document.getElementById("invoiceDueDate").value =
        i.due_date ? String(i.due_date).slice(0, 10) : new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

    document.getElementById("invoicePaidDate").value =
        i.paid_date ? String(i.paid_date).slice(0, 10) : "";

    document.getElementById("invoiceNotes").value = i.notes || "";

    const projectSelect = document.getElementById("invoiceProjectId");
    const contactSelect = document.getElementById("invoiceContactId");

    fillProjectSelect(projectSelect, projectsCache, i.project_id || "");
    fillContactSelect(contactSelect, contactsCache, i.contact_id || "");
}

async function saveInvoiceFromModal() {
    try {
        setFormError("invoiceFormError", null);

        const id = document.getElementById("invoiceId").value;
        const createMode = !String(id || "").trim();

        const amountRaw = document.getElementById("invoiceAmount").value;
        const projectIdRaw = document.getElementById("invoiceProjectId").value;
        const contactIdRaw = document.getElementById("invoiceContactId").value;

        let status = document.getElementById("invoiceStatus").value;
        if (createMode && invoiceFlowState.scannedUpload) {
            status = "paid";
            document.getElementById("invoiceStatus").value = "paid";
        }

        if (createMode && invoiceFlowState.scannedUpload && invoiceFlowState.requireProjectBeforeSave) {
            setFormError("invoiceFormError", "Maak eerst een opdracht aan voor deze gescande factuur.");
            await promptProjectCreationForScannedInvoice(invoiceFlowState.pendingProjectFromScan);
            return;
        }
        if (createMode && invoiceFlowState.scannedUpload && !String(projectIdRaw || "").trim()) {
            setFormError("invoiceFormError", "Koppel eerst een opdracht aan deze gescande factuur.");
            return;
        }

        let paidDate = document.getElementById("invoicePaidDate").value;
        if (status === "paid" && !paidDate) {
            paidDate = new Date().toISOString().slice(0, 10);
        }
        if (status !== "paid") {
            paidDate = null;
        }

        const issueDateInput = document.getElementById("invoiceIssueDate").value || paidDate || new Date().toISOString().slice(0, 10);
        const dueDateInput = document.getElementById("invoiceDueDate").value || issueDateInput;

        const payload = {
            invoice_number: document.getElementById("invoiceNumber").value.trim(),
            status,
            amount: Number(amountRaw),
            issue_date: issueDateInput,
            due_date: dueDateInput,
            paid_date: paidDate,
            notes: document.getElementById("invoiceNotes").value.trim() || null,
            project_id: projectIdRaw === "" ? null : Number(projectIdRaw),
            contact_id: contactIdRaw === "" ? null : Number(contactIdRaw)
        };

        if (!payload.invoice_number) {
            setFormError("invoiceFormError", "Factuurnummer is verplicht.");
            return;
        }
        if (!Number.isFinite(payload.amount)) {
            setFormError("invoiceFormError", "Bedrag is ongeldig.");
            return;
        }
        if (!payload.issue_date || !payload.due_date) {
            setFormError("invoiceFormError", "Issue date en due date zijn verplicht.");
            return;
        }
        if (payload.project_id != null && !Number.isFinite(payload.project_id)) {
            setFormError("invoiceFormError", "Project selectie is ongeldig.");
            return;
        }
        if (payload.contact_id != null && !Number.isFinite(payload.contact_id)) {
            setFormError("invoiceFormError", "Contact selectie is ongeldig.");
            return;
        }

        let savedInvoice = null;
        if (id) {
            savedInvoice = await apiJson(`/api/invoices/${id}`, "PUT", payload);
        } else {
            savedInvoice = await apiJson(`/api/invoices`, "POST", payload);
        }

        if (createMode && invoiceFlowState.scannedUpload && payload.project_id != null) {
            const savedInvoiceId = Number(savedInvoice?.id || 0);
            if (!Number.isFinite(savedInvoiceId) || savedInvoiceId <= 0) {
                throw new Error("Factuur opgeslagen, maar gekoppelde factuur-ID ontbreekt.");
            }

            await apiJson(`/api/projects/${payload.project_id}`, "PUT", {
                status: "betaald",
                invoice_id: savedInvoiceId
            });
        }

        if (createMode && bulkInvoiceState.active) {
            bulkInvoiceState.processed += 1;
            updateBulkInvoiceProgress();
        }

        resetInvoiceFlowState();
        await hideModalAndWait("invoiceModal");
        await loadAll();

        if (createMode && bulkInvoiceState.active) {
            await processNextBulkInvoice();
        }

    } catch (e) {
        console.error(e);
        setFormError("invoiceFormError", String(e.message || e));
    }
}


function setFormError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!msg) {
        el.classList.add("d-none");
        el.textContent = "";
        return;
    }
    el.classList.remove("d-none");
    el.textContent = msg;
}

function setQuickClientError(msg) {
    const el = document.getElementById("quickClientError");
    if (!el) return;
    if (!msg) {
        el.classList.add("d-none");
        el.textContent = "";
        return;
    }
    el.classList.remove("d-none");
    el.textContent = msg;
}

function openQuickClientCreate({ selectId, suggestedName }) {
    quickClientContext = {
        selectId: selectId || null,
        suggestedName: suggestedName || null
    };

    setQuickClientError(null);

    const nameEl = document.getElementById("quickClientName");
    const personEl = document.getElementById("quickClientPerson");

    if (nameEl) nameEl.value = suggestedName || "";
    if (personEl) personEl.value = "";

    quickClientModal().show();
}

async function saveQuickClientAndLink() {
    try {
        setQuickClientError(null);

        const name = (document.getElementById("quickClientName")?.value || "").trim();
        const contactpersoon = (document.getElementById("quickClientPerson")?.value || "").trim();

        if (!name) {
            setQuickClientError("Bedrijfsnaam is verplicht.");
            return;
        }

        const payload = {
            name,
            contactpersoon: contactpersoon || null,

            // rest mag leeg, maar schema accepteert dit
            opdrachtgever_type: null,
            email: null,
            phone: null,
            company: null,
            notes: null,
            btw_nummer: null,
            kvk_nummer: null,
            betaaltermijn_dagen: null,
            standaard_uurtarief: null
        };

        const created = await apiJson("/api/contacts", "POST", payload);

        // refresh cache
        contactsCache = await apiGet("/api/contacts");

        // refresh dropdown en selecteer
        if (quickClientContext.selectId) {
            const sel = document.getElementById(quickClientContext.selectId);
            if (sel) {
                fillContactSelect(sel, contactsCache, created.id);
                sel.value = String(created.id);
            }
        }

        bootstrap.Modal.getInstance(document.getElementById("quickClientModal"))?.hide();
    } catch (e) {
        console.error(e);
        setQuickClientError(String(e.message || e));
    }
}

// -------------------- MANAGE: ATTACHMENTS + NOTES --------------------

window.__manage = async (type, id) => {
    manageEntityType = type;
    manageEntityId = id;

    const title = buildManageTitle(type, id);
    document.getElementById("manageModalTitle").textContent = title;

    document.getElementById("manageError").classList.add("d-none");
    document.getElementById("attachmentFile").value = "";
    document.getElementById("noteBody").value = "";

    await refreshManageData();
    manageModal().show();
};

function buildManageTitle(type, id) {
    if (type === "contacts") {
        const c = contactsCache.find(x => x.id === id);
        return c ? `Beheren: ${c.name}` : "Beheren";
    }
    if (type === "projects") {
        const p = projectsCache.find(x => x.id === id);
        return p ? `Beheren: ${p.name}` : "Beheren";
    }
    if (type === "invoices") {
        const i = invoicesCache.find(x => x.id === id);
        return i ? `Beheren: ${i.invoice_number}` : "Beheren";
    }
    return "Beheren";
}

async function refreshManageData() {
    try {
        setManageError(null);

        const [attachments, notes] = await Promise.all([
            apiGet(`/api/attachments/${manageEntityType}/${manageEntityId}`),
            apiGet(`/api/notes/${manageEntityType}/${manageEntityId}`)
        ]);

        renderAttachments(attachments || []);
        renderNotes(notes || []);

        document.getElementById("manageAttachmentsCount").textContent = String((attachments || []).length);
        document.getElementById("manageNotesCount").textContent = String((notes || []).length);

    } catch (e) {
        console.error(e);
        setManageError(String(e.message || e));
    }
}

function setManageError(msg) {
    const el = document.getElementById("manageError");
    if (!msg) {
        el.classList.add("d-none");
        el.textContent = "";
        return;
    }
    el.classList.remove("d-none");
    el.textContent = msg;
}

function bytesToHuman(n) {
    const b = Number(n || 0);
    if (!Number.isFinite(b) || b <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let v = b;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v = v / 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function euro(n) {
    const v = Number(n || 0);
    return "€" + v.toLocaleString("nl-NL", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatMonthLabel(year, month) {
    const d = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
    return d.toLocaleDateString("nl-NL", { year: "numeric", month: "long" });
}

function formatWorkTimeRange(workStart, workEnd) {
    const ws = String(workStart || "").trim().slice(0, 5);
    const we = String(workEnd || "").trim().slice(0, 5);
    if (ws && we) return `${ws} - ${we}`;
    if (ws) return `${ws} - ?`;
    if (we) return `? - ${we}`;
    return "Tijd n.n.b.";
}

function renderVerticalPanels(vertical) {
    renderUpcomingShifts(vertical?.upcoming_shifts || []);
    renderReceivedThisMonth(vertical?.received_this_month || null);
    // new_shifts_available blijft placeholder
}

function renderUpcomingShifts(items) {
    const el = document.getElementById("upcomingShiftsList");
    if (!el) return;

    if (!items || items.length === 0) {
        el.innerHTML = `<div class="text-muted small">Geen opkomende shifts</div>`;
        return;
    }

    el.innerHTML = items.map(x => {
        const date = x.periode_start ? String(x.periode_start).slice(0, 10) : "";
        const opdrachtgever = x.opdrachtgever ? escapeHtml(x.opdrachtgever) : "-";
        const locatie = x.locatie ? escapeHtml(x.locatie) : "-";
        const tarief = x.tarief != null ? euro(x.tarief) : "-";
        const timeRange = escapeHtml(formatWorkTimeRange(x.work_start, x.work_end));

        return `
      <div class="border rounded p-2 mb-2">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div>
            <div class="fw-semibold">${escapeHtml(x.name || "")}</div>
            <div class="small text-muted">${opdrachtgever}</div>
          </div>
          <div class="text-end">
            <div class="small text-muted">${escapeHtml(date)}</div>
            <div class="small fw-semibold">${timeRange}</div>
          </div>
        </div>
        <div class="small">${locatie} · ${tarief}</div>
      </div>
    `;
    }).join("");
}

function renderReceivedThisMonth(monthTotals) {
    const amountEl = document.getElementById("receivedMonthAmount");
    const metaEl = document.getElementById("receivedMonthMeta");
    const labelEl = document.getElementById("monthLabel");

    if (!amountEl || !metaEl || !labelEl) return;

    if (!monthTotals) {
        labelEl.textContent = "";
        amountEl.textContent = "€0";
        metaEl.textContent = "Geen data";
        return;
    }

    const { year, month, invoice_count, total_amount } = monthTotals;

    labelEl.textContent = formatMonthLabel(year, month);
    amountEl.textContent = euro(total_amount);
    metaEl.textContent = `${Number(invoice_count || 0)} facturen`;
}


function setMonthHistoryError(msg) {
    const el = document.getElementById("monthHistoryError");
    if (!el) return;
    if (!msg) {
        el.classList.add("d-none");
        el.textContent = "";
        return;
    }
    el.classList.remove("d-none");
    el.textContent = msg;
}

let monthHistoryState = {
    rows: [],
    selectedYear: null,
    selectedMonth: null
};

async function openMonthHistory() {
    try {
        setMonthHistoryError(null);

        const res = await apiGet("/api/invoices/month-history?fromYear=2020");
        const rows = res?.rows || [];

        monthHistoryState.rows = rows;

        const years = Array.from(new Set(rows.map(r => Number(r.year)))).sort((a, b) => b - a);

        renderHistoryYears(years);

        // preselect: current year
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth() + 1;

        const pickYear = years.includes(y) ? y : (years[0] || y);
        monthHistoryState.selectedYear = pickYear;

        renderHistoryMonthsForYear(pickYear);

        // preselect month if exists
        const monthsForYear = rows.filter(r => Number(r.year) === pickYear).map(r => Number(r.month));
        const pickMonth = monthsForYear.includes(m) ? m : (monthsForYear[0] || m);
        monthHistoryState.selectedMonth = pickMonth;

        await loadHistoryMonthDetails(pickYear, pickMonth);

        monthHistoryModal().show();
    } catch (e) {
        console.error(e);
        setMonthHistoryError(String(e.message || e));
        monthHistoryModal().show();
    }
}

function renderHistoryYears(years) {
    const el = document.getElementById("historyYearsList");
    if (!el) return;

    el.innerHTML = (years || []).map(y => {
        return `
      <button type="button"
        class="list-group-item list-group-item-action"
        onclick="window.__selectHistoryYear(${Number(y)})">
        ${Number(y)}
      </button>
    `;
    }).join("");
}

function renderHistoryMonthsForYear(year) {
    const el = document.getElementById("historyMonthsList");
    if (!el) return;

    const rows = monthHistoryState.rows.filter(r => Number(r.year) === Number(year));
    const months = rows.map(r => Number(r.month)).sort((a, b) => b - a);

    el.innerHTML = months.map(m => {
        const label = formatMonthLabel(year, m);
        return `
      <button type="button"
        class="list-group-item list-group-item-action"
        onclick="window.__selectHistoryMonth(${Number(year)}, ${Number(m)})">
        ${escapeHtml(label)}
      </button>
    `;
    }).join("");
}

function resetHistoryDetailPanel(year, month) {
    const labelEl = document.getElementById("historySelectedLabel");
    const totalEl = document.getElementById("historySelectedTotal");
    const countEl = document.getElementById("historySelectedCount");
    const listEl = document.getElementById("historyInvoicesList");

    if (labelEl) labelEl.textContent = formatMonthLabel(year, month);
    if (totalEl) totalEl.textContent = euro(0);
    if (countEl) countEl.textContent = "0 facturen";
    if (listEl) listEl.innerHTML = `<div class="text-muted small">Geen facturen gevonden</div>`;
}

async function loadHistoryMonthDetails(year, month) {
    setMonthHistoryError(null);

    const labelEl = document.getElementById("historySelectedLabel");
    const totalEl = document.getElementById("historySelectedTotal");
    const countEl = document.getElementById("historySelectedCount");
    const listEl = document.getElementById("historyInvoicesList");

    if (labelEl) labelEl.textContent = formatMonthLabel(year, month);

    const row = monthHistoryState.rows.find(r => Number(r.year) === Number(year) && Number(r.month) === Number(month));
    const total = row ? Number(row.total_amount || 0) : 0;
    const count = row ? Number(row.invoice_count || 0) : 0;

    if (totalEl) totalEl.textContent = euro(total);
    if (countEl) countEl.textContent = `${count} facturen`;

    if (listEl) {
        listEl.innerHTML = `<div class="text-muted small">Laden...</div>`;
    }

    const details = await apiGet(`/api/invoices/by-month?year=${Number(year)}&month=${Number(month)}`);
    const items = details?.items || [];

    if (!listEl) return;

    if (!items.length) {
        listEl.innerHTML = `<div class="text-muted small">Geen facturen gevonden</div>`;
        return;
    }

    listEl.innerHTML = items.slice(0, 30).map(inv => {
        const nr = escapeHtml(inv.invoice_number || "");
        const amt = euro(inv.amount || 0);
        const st = escapeHtml(String(inv.status || ""));
        const dt = inv.issue_date ? escapeHtml(String(inv.issue_date).slice(0, 10)) : "";
        const cl = escapeHtml(inv.contact_name || "");
        return `
      <div class="list-group-item">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div class="fw-semibold">${nr}</div>
          <div class="small text-muted">${dt}</div>
        </div>
        <div class="small text-muted">${cl}</div>
        <div class="small">${amt} · ${st}</div>
      </div>
    `;
    }).join("");
}

window.__selectHistoryYear = async (year) => {
    monthHistoryState.selectedYear = Number(year);
    renderHistoryMonthsForYear(year);

    // auto select first month in that year if exists
    const rows = monthHistoryState.rows.filter(r => Number(r.year) === Number(year));
    const months = rows.map(r => Number(r.month)).sort((a, b) => b - a);
    if (months.length) {
        monthHistoryState.selectedMonth = months[0];
        await loadHistoryMonthDetails(year, months[0]);
        return;
    }

    const fallbackMonth = new Date().getUTCMonth() + 1;
    monthHistoryState.selectedMonth = fallbackMonth;
    resetHistoryDetailPanel(Number(year), fallbackMonth);
};

window.__selectHistoryMonth = async (year, month) => {
    monthHistoryState.selectedYear = Number(year);
    monthHistoryState.selectedMonth = Number(month);
    await loadHistoryMonthDetails(year, month);
};


function renderAttachments(items) {
    const tbody = document.getElementById("attachmentsTbody");
    const empty = document.getElementById("attachmentsEmptyHint");

    if (!items || items.length === 0) {
        tbody.innerHTML = "";
        if (empty) empty.style.display = "block";
        return;
    }

    if (empty) empty.style.display = "none";

    tbody.innerHTML = items.map(item => {
        const name = item.original_name || item.stored_name || "";
        const safeName = escapeHtml(name).replace(/'/g, "&#39;");

        return `
<tr>
  <td>${escapeHtml(name)}</td>
  <td class="text-end">
    <div class="btn-group btn-group-sm" role="group">
      <button class="btn btn-outline-primary"
        onclick="window.__downloadAtt(${item.id}, '${safeName}')">
        Download
      </button>
      <button class="btn btn-outline-danger"
        onclick="window.__deleteAtt(${item.id})">
        Verwijder
      </button>
    </div>
  </td>
</tr>`;
    }).join("");
}


window.__downloadAtt = async (id, name) => {
    try {
        await downloadAttachment(id, name || "download");
    } catch (e) {
        console.error(e);
        alert("Download mislukt. Check console.");
    }
};


window.__deleteAtt = async (id, entityType, entityId) => {
    if (!confirm("Bestand verwijderen?")) return;

    try {
        await deleteAttachment(id);

        // Refresh alleen de bijlagen van de huidige entity (zodat je niet alles opnieuw hoeft te laden)
        await refreshAttachmentsList(entityType, entityId);
    } catch (e) {
        console.error(e);
        alert("Verwijderen mislukt. Check console.");
    }
};



async function uploadAttachmentFromManage() {
    try {
        const input = document.getElementById("attachmentFile");
        const file = input.files && input.files[0];
        if (!file) {
            setManageError("Kies eerst een bestand om te uploaden.");
            return;
        }

        setManageError(null);
        await apiUpload(`/api/attachments/${manageEntityType}/${manageEntityId}`, file);

        input.value = "";
        await refreshManageData();

    } catch (e) {
        console.error(e);
        setManageError(String(e.message || e));
    }
}

function renderNotes(items) {
    const list = document.getElementById("notesList");
    const empty = document.getElementById("notesEmptyHint");

    if (!items || items.length === 0) {
        list.innerHTML = "";
        empty.style.display = "block";
        return;
    }

    empty.style.display = "none";

    list.innerHTML = items.map(n => `
    <div class="list-group-item">
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div class="flex-grow-1">
          <div class="small text-muted mb-1">${new Date(n.created_at).toLocaleString("nl-NL")}</div>
          <div class="note-body" data-note-id="${n.id}">${escapeHtml(n.body)}</div>
        </div>
        <div class="btn-group">
          <button class="btn btn-sm btn-outline-primary" onclick="window.__editNote(${n.id})" title="Bewerken">
            <i class="bi bi-pencil"></i>
          </button>
          <button class="btn btn-sm btn-outline-danger" onclick="window.__delNote(${n.id})" title="Verwijderen">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </div>
    </div>
  `).join("");
}

async function addNoteFromManage() {
    try {
        const body = document.getElementById("noteBody").value.trim();
        if (!body) {
            setManageError("Notitie tekst is leeg.");
            return;
        }
        setManageError(null);

        await apiJson(`/api/notes/${manageEntityType}/${manageEntityId}`, "POST", { body });
        document.getElementById("noteBody").value = "";
        await refreshManageData();

    } catch (e) {
        console.error(e);
        setManageError(String(e.message || e));
    }
}

window.__delNote = async (id) => {
    try {
        await apiJson(`/api/notes/${id}`, "DELETE");
        await refreshManageData();
    } catch (e) {
        console.error(e);
        alert("Notitie verwijderen mislukt");
    }
};

window.__editNote = async (id) => {
    try {
        const node = document.querySelector(`.note-body[data-note-id="${id}"]`);
        if (!node) return;

        const current = node.textContent || "";
        const next = prompt("Notitie bewerken:", current);
        if (next == null) return;

        const body = String(next).trim();
        if (!body) {
            alert("Notitie kan niet leeg zijn.");
            return;
        }

        await apiJson(`/api/notes/${id}`, "PUT", { body });
        await refreshManageData();

    } catch (e) {
        console.error(e);
        alert("Notitie bewerken mislukt");
    }
};

// -------------------- AUTH0 USER UI FIXES --------------------

function displayUserInfoFromAuth0(u) {
    const userName = u.name || u.email || "Gebruiker";
    const userEmail = u.email || "-";
    const userPicture = u.picture;

    const userNameEl = document.getElementById("userName");
    if (userNameEl) userNameEl.textContent = userName;

    const userAvatar = document.getElementById("userAvatar");
    if (userAvatar && userPicture) {
        userAvatar.src = userPicture;
        userAvatar.style.display = "inline-block";
    }

    const welcomeNameEl = document.getElementById("welcomeName");
    if (welcomeNameEl) welcomeNameEl.textContent = userName.split(" ")[0];

    const profileNameEl = document.getElementById("profileName");
    if (profileNameEl) profileNameEl.textContent = userName;

    const profileEmailEl = document.getElementById("profileEmail");
    if (profileEmailEl) profileEmailEl.textContent = userEmail;

    const profileUserIdEl = document.getElementById("profileUserId");
    if (profileUserIdEl) profileUserIdEl.textContent = u.sub || "-";

    const profileAvatar = document.getElementById("profileAvatar");
    const profileInitials = document.getElementById("profileInitials");

    if (profileAvatar && userPicture) {
        profileAvatar.src = userPicture;
        profileAvatar.style.display = "block";

        // Placeholder weg zodra echte avatar zichtbaar is
        if (profileInitials) {
            profileInitials.style.display = "none";
            profileInitials.textContent = "";
        }
    } else if (profileInitials) {
        const initials = userName
            .split(" ")
            .filter(Boolean)
            .slice(0, 2)
            .map(n => n[0])
            .join("")
            .toUpperCase();

        profileInitials.textContent = initials || "?";
        profileInitials.style.display = "inline-flex";
        if (profileAvatar) profileAvatar.style.display = "none";
    }
}

async function downloadAttachment(id, filenameHint = "download") {
    if (!accessToken) throw new Error("No accessToken set");

    const res = await fetch(`${API_BASE_URL}/api/attachments/download/${id}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Download failed: ${res.status} ${txt}`);
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filenameHint;
    document.body.appendChild(a);
    a.click();
    a.remove();

    window.URL.revokeObjectURL(url);

    // 🔁 refresh alleen de lijst
    await refreshAttachmentsList();
}


async function deleteAttachment(id) {
    const res = await fetch(`${API_BASE_URL}/api/attachments/${id}`, {
        method: "DELETE",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        }
    });

    if (res.status === 401) {
        const txt = await res.text();
        throw new Error(`Unauthorized delete: ${txt}`);
    }
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Delete failed: ${res.status} ${txt}`);
    }

    return res.json();
}


async function refreshAttachmentsList() {
    console.log("[attachments] refresh start", attachmentsContext);

    if (!attachmentsContext?.entityType || !attachmentsContext?.entityId) {
        console.warn("[attachments] NO CONTEXT set -> not refreshing");
        return;
    }

    const url = `/api/attachments/${attachmentsContext.entityType}/${attachmentsContext.entityId}`;
    console.log("[attachments] fetching", url);

    try {
        const items = await apiGet(url);
        console.log("[attachments] fetched", items);

        const tbody = document.getElementById("attachmentsTbody");
        if (!tbody) {
            console.error("[attachments] #attachmentsTbody not found in DOM");
            return;
        }

        renderAttachments(items);
        console.log("[attachments] render done");
    } catch (e) {
        console.error("[attachments] refresh failed", e);
        alert("Bijlagen refresh faalde. Check console: [attachments] refresh failed");
    }
}


window.__openAttachments = async (entityType, entityId) => {
    attachmentsContext = { entityType, entityId };
    console.log("[attachments] context set", attachmentsContext);

    await refreshAttachmentsList();

    // Als je een modal gebruikt, open hem hier:
    // const modal = new bootstrap.Modal(document.getElementById("attachmentsModal"));
    // modal.show();
};


async function fetchAttachments(entityType, entityId) {
    return apiGet(`/api/attachments/${entityType}/${entityId}`);
}
