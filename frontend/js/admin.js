// frontend/js/admin.js
let auth0Client = null;
let accessToken = null;

let currentUsers = [];
let selectedUser = null;

const API = (endpoint) => `${API_BASE_URL}${endpoint}`;

function $(id) {
    return document.getElementById(id);
}

function showError(msg) {
    const el = $("adminError");
    if (!el) return;
    if (!msg) {
        el.classList.add("d-none");
        el.textContent = "";
        return;
    }
    el.classList.remove("d-none");
    el.textContent = msg;
}

function showInline(id, msg) {
    const el = $(id);
    if (!el) return;
    if (!msg) {
        el.classList.add("d-none");
        el.textContent = "";
        return;
    }
    el.classList.remove("d-none");
    el.textContent = msg;
}

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c]));
}

async function apiJson(endpoint, method = "GET", body) {
    const res = await fetch(API(endpoint), {
        method,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${method} ${endpoint} failed: ${res.status} ${txt}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

function decodeJwtPayload(token) {
    const part = token.split(".")[1];
    return JSON.parse(atob(part));
}

function setNavbarUser(payload) {
    const name = payload?.name || payload?.nickname || payload?.email || "Admin";
    const pic = payload?.picture || "";

    const nameEl = $("userName");
    if (nameEl) nameEl.textContent = name;

    const avatarEl = $("userAvatar");
    if (avatarEl) {
        if (pic) {
            avatarEl.src = pic;
            avatarEl.style.display = "";
        } else {
            avatarEl.style.display = "none";
        }
    }
}

function isAdminFromToken(token) {
    try {
        const payload = decodeJwtPayload(token);
        const perms = payload.permissions || [];
        return perms.includes("admin:access");
    } catch {
        return false;
    }
}

function formatExpires(ts) {
    if (!ts) return "-";
    try {
        return new Date(ts).toLocaleString("nl-NL");
    } catch {
        return String(ts);
    }
}

function renderUsersTable(users) {
    const tbody = $("usersTbody");
    if (!tbody) return;

    if (!users || users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-muted">Geen resultaten.</td></tr>`;
        return;
    }

    tbody.innerHTML = users.map(u => {
        const blocked = !!u.blocked_at;
        const expires = formatExpires(u.subscription_expires_at);
        const statusLabel = blocked ? "Geblokkeerd" : (u.subscription_status || "active");
        const statusClass = blocked ? "text-danger" : "text-success";

        return `
      <tr>
        <td>${escapeHtml(u.id)}</td>
        <td>${escapeHtml(u.name || "-")}</td>
        <td>${escapeHtml(u.email || "-")}</td>
        <td><span class="${statusClass} fw-semibold">${escapeHtml(statusLabel)}</span></td>
        <td>${escapeHtml(expires)}</td>
        <td class="text-end">
          <button class="btn btn-sm btn-outline-primary" data-user-id="${escapeHtml(u.id)}">Beheer</button>
        </td>
      </tr>
    `;
    }).join("");

    // event delegation
    tbody.querySelectorAll("button[data-user-id]").forEach(btn => {
        btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-user-id");
            openManageUserModal(id);
        });
    });
}

function manageModal() {
    return new bootstrap.Modal($("manageUserModal"));
}
function subModal() {
    return new bootstrap.Modal($("subscriptionModal"));
}
function blockModal() {
    return new bootstrap.Modal($("blockModal"));
}
function profileModal() {
    return new bootstrap.Modal($("profileModal"));
}
function pwModal() {
    return new bootstrap.Modal($("pwModal"));
}

function renderManageUserInfo() {
    const box = $("manageUserInfo");
    if (!box) return;

    if (!selectedUser) {
        box.innerHTML = `<div class="text-muted">Geen gebruiker geselecteerd.</div>`;
        return;
    }

    const u = selectedUser;
    const blocked = !!u.blocked_at;

    const html = `
    <div class="row g-2">
      <div class="col-12">
        <div><strong>Naam:</strong> ${escapeHtml(u.name || "-")}</div>
        <div><strong>Email:</strong> ${escapeHtml(u.email || "-")}</div>
        <div><strong>ID:</strong> ${escapeHtml(u.id)}</div>
        <div><strong>Auth0 ID:</strong> ${escapeHtml(u.auth0_id || "-")}</div>
        <div><strong>Status:</strong> ${escapeHtml(u.subscription_status || "-")}</div>
        <div><strong>Expires:</strong> ${escapeHtml(formatExpires(u.subscription_expires_at))}</div>
        <div><strong>Blocked:</strong> ${blocked ? "Ja" : "Nee"}</div>
        ${blocked ? `<div><strong>Blocked reason:</strong> ${escapeHtml(u.blocked_reason || "-")}</div>` : ""}
        ${blocked ? `<div><strong>Blocked note:</strong> ${escapeHtml(u.blocked_note || "-")}</div>` : ""}
        <div><strong>Profile picture url:</strong> ${escapeHtml(u.profile_picture_url || "-")}</div>
      </div>
    </div>
  `;

    box.innerHTML = html;

    // toggle buttons
    const openBlockBtn = $("openBlockBtn");
    const openUnblockBtn = $("openUnblockBtn");
    if (openBlockBtn) openBlockBtn.classList.toggle("d-none", blocked);
    if (openUnblockBtn) openUnblockBtn.classList.toggle("d-none", !blocked);

    showInline("manageUserError", null);
}

function openManageUserModal(userId) {
    selectedUser = (currentUsers || []).find(u => String(u.id) === String(userId)) || null;
    renderManageUserInfo();
    manageModal().show();
}

function clearAllModalAlerts() {
    showInline("subError", null);
    showInline("subOk", null);

    showInline("blockError", null);
    showInline("blockOk", null);

    showInline("profileError", null);
    showInline("profileOk", null);

    const ok = $("pwOk");
    const err = $("pwErr");
    if (ok) ok.classList.add("d-none");
    if (err) {
        err.classList.add("d-none");
        err.textContent = "";
    }

    showInline("manageUserError", null);
}

async function loadUsers() {
    showError(null);

    const q = String($("userSearchInput")?.value || "").trim();
    const endpoint = q
        ? `/api/admin/users?q=${encodeURIComponent(q)}`
        : `/api/admin/users`;

    const users = await apiJson(endpoint, "GET");
    currentUsers = Array.isArray(users) ? users : [];
    renderUsersTable(currentUsers);
}

function wireEvents() {
    const logoutBtn = $("logoutBtn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            await logout(auth0Client);
        });
    }

    const searchBtn = $("userSearchBtn");
    if (searchBtn) searchBtn.addEventListener("click", loadUsers);

    const searchInput = $("userSearchInput");
    if (searchInput) {
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") loadUsers();
        });
    }

    // manage modal buttons
    const openSubscriptionBtn = $("openSubscriptionBtn");
    if (openSubscriptionBtn) {
        openSubscriptionBtn.addEventListener("click", () => {
            if (!selectedUser) return;
            clearAllModalAlerts();
            $("subDays").value = 30;
            $("subHours").value = 0;
            $("subMinutes").value = 0;
            $("subSeconds").value = 0;
            subModal().show();
        });
    }

    const openBlockBtn = $("openBlockBtn");
    if (openBlockBtn) {
        openBlockBtn.addEventListener("click", () => {
            if (!selectedUser) return;
            clearAllModalAlerts();
            $("blockReason").value = "blocked_by_admin";
            $("blockNote").value = "Je hebt geen toegang. Je abonnement is verlopen of je account is geblokkeerd.";
            blockModal().show();
        });
    }

    const openUnblockBtn = $("openUnblockBtn");
    if (openUnblockBtn) {
        openUnblockBtn.addEventListener("click", async () => {
            if (!selectedUser) return;
            clearAllModalAlerts();
            try {
                const updated = await apiJson(`/api/admin/users/${selectedUser.id}/block`, "PATCH", { blocked: false });
                updateUserInState(updated);
            } catch (e) {
                showInline("manageUserError", String(e.message || e));
            }
        });
    }

    const openProfileBtn = $("openProfileBtn");
    if (openProfileBtn) {
        openProfileBtn.addEventListener("click", () => {
            if (!selectedUser) return;
            clearAllModalAlerts();
            $("profileNameInput").value = selectedUser?.name || "";
            $("profilePicUrlInput").value = selectedUser?.profile_picture_url || "";
            $("profileExpiresAtInput").value = selectedUser?.subscription_expires_at || "";
            $("profileBlockedNoteInput").value = selectedUser?.blocked_note || "";
            profileModal().show();
        });
    }

    const openPwBtn = $("openPwBtn");
    if (openPwBtn) {
        openPwBtn.addEventListener("click", () => {
            if (!selectedUser) return;
            clearAllModalAlerts();
            pwModal().show();
        });
    }

    // modal save buttons
    const subSaveBtn = $("subSaveBtn");
    if (subSaveBtn) {
        subSaveBtn.addEventListener("click", onSaveSubscription);
    }

    const blockSaveBtn = $("blockSaveBtn");
    if (blockSaveBtn) {
        blockSaveBtn.addEventListener("click", onBlockUser);
    }

    const profileSaveBtn = $("profileSaveBtn");
    if (profileSaveBtn) {
        profileSaveBtn.addEventListener("click", onSaveProfile);
    }

    const pwSendBtn = $("pwSendBtn");
    if (pwSendBtn) {
        pwSendBtn.addEventListener("click", onSendPwReset);
    }
}

function updateUserInState(updated) {
    if (!updated) return;
    currentUsers = (currentUsers || []).map(u => String(u.id) === String(updated.id) ? updated : u);
    selectedUser = currentUsers.find(u => String(u.id) === String(updated.id)) || updated;
    renderUsersTable(currentUsers);
    renderManageUserInfo();
}

async function onSaveSubscription() {
    if (!selectedUser) return;
    clearAllModalAlerts();

    try {
        const payload = {
            days: Number($("subDays").value || 0),
            hours: Number($("subHours").value || 0),
            minutes: Number($("subMinutes").value || 0),
            seconds: Number($("subSeconds").value || 0),
        };

        const updated = await apiJson(`/api/admin/users/${selectedUser.id}/subscription`, "PATCH", payload);
        showInline("subOk", "Abonnement bijgewerkt.");
        updateUserInState(updated);

        // modal sluiten na succes (optioneel)
        setTimeout(() => {
            try { subModal().hide(); } catch { }
        }, 300);
    } catch (e) {
        showInline("subError", String(e.message || e));
    }
}

async function onBlockUser() {
    if (!selectedUser) return;
    clearAllModalAlerts();

    try {
        const payload = {
            blocked: true,
            reason: String($("blockReason").value || "blocked_by_admin").trim(),
            note: String($("blockNote").value || "").trim() || null,
        };

        const updated = await apiJson(`/api/admin/users/${selectedUser.id}/block`, "PATCH", payload);
        showInline("blockOk", "Gebruiker geblokkeerd.");
        updateUserInState(updated);

        setTimeout(() => {
            try { blockModal().hide(); } catch { }
        }, 300);
    } catch (e) {
        showInline("blockError", String(e.message || e));
    }
}

async function onSaveProfile() {
    if (!selectedUser) return;
    clearAllModalAlerts();

    try {
        const payload = {
            name: String($("profileNameInput").value || "").trim() || null,
            profile_picture_url: String($("profilePicUrlInput").value || "").trim() || null,
            subscription_expires_at: String($("profileExpiresAtInput").value || "").trim() || null,
            blocked_note: String($("profileBlockedNoteInput").value || "").trim() || null,
        };

        const updated = await apiJson(`/api/admin/users/${selectedUser.id}/profile`, "PATCH", payload);
        showInline("profileOk", "Profiel bijgewerkt.");
        updateUserInState(updated);

        setTimeout(() => {
            try { profileModal().hide(); } catch { }
        }, 300);
    } catch (e) {
        showInline("profileError", String(e.message || e));
    }
}

async function onSendPwReset() {
    if (!selectedUser) return;
    clearAllModalAlerts();

    const ok = $("pwOk");
    const err = $("pwErr");
    if (ok) ok.classList.add("d-none");
    if (err) { err.classList.add("d-none"); err.textContent = ""; }

    try {
        await apiJson(`/api/admin/users/${selectedUser.id}/password-reset`, "POST");
        if (ok) ok.classList.remove("d-none");
    } catch (e) {
        if (err) {
            err.classList.remove("d-none");
            err.textContent = String(e.message || e);
        }
    }
}

window.addEventListener("DOMContentLoaded", async () => {
    try {
        wireEvents();

        auth0Client = await initAuth0();

        if (window.location.search.includes("code=") || window.location.search.includes("error=")) {
            await auth0Client.handleRedirectCallback();
            window.history.replaceState({}, document.title, "/admin.html");
        }

        const isAuthenticated = await auth0Client.isAuthenticated();
        if (!isAuthenticated) {
            window.location.href = "index.html";
            return;
        }

        accessToken = await auth0Client.getTokenSilently({
            authorizationParams: {
                audience: AUTH0_CONFIG.audience,
                scope: "openid profile email read:dashboard admin:access",
            },
        });

        const payload = decodeJwtPayload(accessToken);
        setNavbarUser(payload);

        if (!isAdminFromToken(accessToken)) {
            showError("Geen toegang. Je bent geen admin.");
            renderUsersTable([]);
            return;
        }

        await loadUsers();
    } catch (e) {
        console.error(e);
        showError(String(e.message || e));
    }
});
