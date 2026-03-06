import { UserModel } from "../models/User.js";

function isMachineTokenSub(sub) {
    return typeof sub === "string" && sub.endsWith("@clients");
}

function deriveFallbackEmail(sub) {
    const safe = String(sub || "")
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return safe ? `${safe}@no-email.local` : null;
}

export async function attachUser(req, res, next) {
    try {
        const auth0Id = req.auth?.payload?.sub;
        if (!auth0Id) return res.status(401).json({ error: "No auth subject" });

        if (isMachineTokenSub(auth0Id)) {
            return res.status(401).json({ error: "Machine token not allowed for user endpoints" });
        }

        const emailClaim = typeof req.auth?.payload?.email === "string"
            ? req.auth.payload.email.trim().toLowerCase()
            : "";
        const email = emailClaim || deriveFallbackEmail(auth0Id);
        const name = req.auth?.payload?.name || null;
        const picture = req.auth?.payload?.picture || null;

        const user = await UserModel.findOrCreate({ sub: auth0Id, email, name, picture });
        req.user = user;

        next();
    } catch (err) {
        console.error("attachUser error:", err);
        res.status(500).json({ error: "Failed to attach user" });
    }
}
