// backend/src/services/auth0PasswordReset.js

function mustEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

export async function sendPasswordResetEmailOrTicket(email) {
    const domain = mustEnv("AUTH0_DOMAIN");
    const clientId = mustEnv("AUTH0_CLIENT_ID");

    const connection = process.env.AUTH0_DB_CONNECTION; // zet dit in .env

    if (!connection) {
        throw new Error("AUTH0_DB_CONNECTION ontbreekt. Zet dit in .env om reset mails te versturen.");
    }

    const res = await fetch(`https://${domain}/dbconnections/change_password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: clientId,
            email,
            connection
        })
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Auth0 change_password failed: ${res.status} ${txt}`);
    }

    return true;
}
