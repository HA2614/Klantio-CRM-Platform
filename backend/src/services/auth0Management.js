// backend/src/services/auth0Management.js

let cachedToken = null;
let cachedTokenExp = 0;

function mustEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

export async function getManagementToken() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && cachedTokenExp - 30 > now) return cachedToken;

    const domain = mustEnv("AUTH0_DOMAIN");
    const mgmtClientId = mustEnv("AUTH0_MGMT_CLIENT_ID");
    const mgmtClientSecret = mustEnv("AUTH0_MGMT_CLIENT_SECRET");

    const tokenRes = await fetch(`https://${domain}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: mgmtClientId,
            client_secret: mgmtClientSecret,
            audience: `https://${domain}/api/v2/`,
            grant_type: "client_credentials",
        }),
    });

    if (!tokenRes.ok) {
        const txt = await tokenRes.text();
        throw new Error(`Mgmt token failed: ${tokenRes.status} ${txt}`);
    }

    const json = await tokenRes.json();
    cachedToken = json.access_token;
    cachedTokenExp = now + (json.expires_in || 3600);

    return cachedToken;
}

export async function mgmtGetUser(auth0UserId) {
    const domain = mustEnv("AUTH0_DOMAIN");
    const token = await getManagementToken();

    const res = await fetch(
        `https://${domain}/api/v2/users/${encodeURIComponent(auth0UserId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Mgmt get user failed: ${res.status} ${txt}`);
    }

    return res.json();
}

export async function mgmtPatchUser(auth0UserId, body) {
    const domain = mustEnv("AUTH0_DOMAIN");
    const token = await getManagementToken();

    const res = await fetch(
        `https://${domain}/api/v2/users/${encodeURIComponent(auth0UserId)}`,
        {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        }
    );

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Mgmt patch user failed: ${res.status} ${txt}`);
    }

    return res.json();
}

/**
 * Sends a password reset email via Auth0 Authentication API.
 * Works for database connections (Username-Password-Authentication etc).
 *
 * Requires:
 * - AUTH0_DOMAIN
 * - AUTH0_CLIENT_ID (your frontend app client id)
 */
export async function sendPasswordResetEmailForUser(auth0UserId) {
    const domain = mustEnv("AUTH0_DOMAIN");
    const clientId = mustEnv("AUTH0_CLIENT_ID");

    // Get email + connection from Auth0 user
    const u = await mgmtGetUser(auth0UserId);

    const email = u?.email;
    if (!email) throw new Error("Auth0 user has no email");

    // Determine connection (default database connection)
    const connection = u?.identities?.[0]?.connection || "Username-Password-Authentication";

    const res = await fetch(`https://${domain}/dbconnections/change_password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: clientId,
            email,
            connection,
        }),
    });

    // Auth0 returns 200 with a text message (not JSON)
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Password reset email failed: ${res.status} ${txt}`);
    }

    const msg = await res.text();
    return { ok: true, email, connection, message: msg };
}
