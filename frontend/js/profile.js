let auth0Client = null;
let accessToken = null;
let auth0User = null;
let loadedProfile = null;

window.addEventListener("load", async () => {
    try {
        auth0Client = await initAuth0();

        if (window.location.search.includes("code=") || window.location.search.includes("error=")) {
            await auth0Client.handleRedirectCallback();
            window.history.replaceState({}, document.title, "/profile.html");
        }

        const isAuthenticated = await auth0Client.isAuthenticated();
        if (!isAuthenticated) {
            window.location.href = "index.html";
            return;
        }

        auth0User = await auth0Client.getUser();
        if (!auth0User) {
            window.location.href = "index.html";
            return;
        }

        accessToken = await auth0Client.getTokenSilently({
            authorizationParams: {
                audience: AUTH0_CONFIG.audience,
                scope: "openid profile email"
            }
        });

        wireUi();
        renderTopBarUser(auth0User);
        renderAccountCard(auth0User);

        await loadProfileFromAuth0Metadata();
    } catch (e) {
        console.error("Profile init error:", e);
        alert("Kon profiel niet laden. Check console (F12).");
    }
});

function wireUi() {
    document.getElementById("logoutBtn").addEventListener("click", async (e) => {
        e.preventDefault();
        await logout(auth0Client);
    });

    document.getElementById("reloadBtn").addEventListener("click", async () => {
        await loadProfileFromAuth0Metadata();
    });

    document.getElementById("saveBtn").addEventListener("click", async () => {
        await saveProfileToAuth0Metadata();
    });
    document.getElementById("saveBtn2").addEventListener("click", async () => {
        await saveProfileToAuth0Metadata();
    });

    document.getElementById("cancelBtn").addEventListener("click", async () => {
        fillForm(loadedProfile || {});
    });

    document.getElementById("changePasswordBtn").addEventListener("click", async () => {
        await requestPasswordReset();
    });
}

function renderTopBarUser(user) {
    const userName = user.name || user.email || "Gebruiker";
    document.getElementById("userName").textContent = userName;

    const userAvatar = document.getElementById("userAvatar");
    if (userAvatar && user.picture) {
        userAvatar.src = user.picture;
        userAvatar.style.display = "inline-block";
    } else if (userAvatar) {
        userAvatar.style.display = "none";
    }
}

function renderAccountCard(user) {
    const userName = user.name || user.email || "Gebruiker";
    const email = user.email || "-";
    const sub = user.sub || "-";

    document.getElementById("profileName").textContent = userName;
    document.getElementById("profileEmail").textContent = email;
    document.getElementById("profileUserId").textContent = sub;

    const img = document.getElementById("profileAvatar");
    const initials = document.getElementById("profileInitials");

    if (user.picture) {
        img.src = user.picture;
        img.style.display = "inline-block";
        if (initials) initials.style.display = "none";
    } else {
        img.style.display = "none";
        if (initials) {
            initials.textContent = makeInitials(userName);
            initials.style.display = "inline-flex";
        }
    }
}

function makeInitials(name) {
    return String(name || "?")
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((n) => n[0])
        .join("")
        .toUpperCase() || "?";
}

async function apiJson(endpoint, method, body) {
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
        throw new Error(`${method} ${endpoint} failed: ${res.status} ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

async function loadProfileFromAuth0Metadata() {
    setStatus("Laden...", true);

    const data = await apiJson("/api/profile", "GET");
    loadedProfile = data?.user_metadata || {};

    fillForm(loadedProfile);
    setStatus("Geladen.", false);
}

function fillForm(meta) {
    document.getElementById("firstName").value = meta.first_name || "";
    document.getElementById("lastName").value = meta.last_name || "";
    document.getElementById("phone").value = meta.phone || "";
    document.getElementById("company").value = meta.company || "";
    document.getElementById("address").value = meta.address || "";
    document.getElementById("bio").value = meta.bio || "";
}

async function saveProfileToAuth0Metadata() {
    const payload = {
        first_name: document.getElementById("firstName").value.trim(),
        last_name: document.getElementById("lastName").value.trim(),
        phone: document.getElementById("phone").value.trim(),
        company: document.getElementById("company").value.trim(),
        address: document.getElementById("address").value.trim(),
        bio: document.getElementById("bio").value.trim()
    };

    setStatus("Opslaan...", true);

    const updated = await apiJson("/api/profile", "PUT", { user_metadata: payload });
    loadedProfile = updated?.user_metadata || payload;

    setStatus("Opgeslagen.", false);
}

async function requestPasswordReset() {
    const email = auth0User?.email;
    if (!email) {
        alert("Geen email in je Auth0 profiel gevonden.");
        return;
    }

    setStatus("Reset e-mail aanvragen...", true);

    try {
        await apiJson("/api/profile/change-password", "POST", { email });
        setStatus("", false);
        alert("Reset e-mail verstuurd. Check je inbox.");
    } catch (e) {
        console.error(e);
        setStatus("", false);
        alert("Kon reset e-mail niet versturen. Check console.");
    }
}

function setStatus(text, busy) {
    const el = document.getElementById("statusText");
    if (!el) return;

    if (!text) {
        el.style.display = "none";
        el.textContent = "";
        return;
    }

    el.style.display = "block";
    el.textContent = text;

    document.getElementById("saveBtn").disabled = !!busy;
    document.getElementById("saveBtn2").disabled = !!busy;
    document.getElementById("reloadBtn").disabled = !!busy;
}
