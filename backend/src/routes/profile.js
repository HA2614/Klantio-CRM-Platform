// backend/src/routes/profile.js
import express from "express";
import { checkJwt } from "../middleware/authMiddleware.js";
import { mgmtGetUser, mgmtPatchUser } from "../services/auth0Management.js";

const router = express.Router();
router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
});

function mustEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

function isMachineTokenSub(sub) {
    return typeof sub === "string" && sub.endsWith("@clients");
}

// GET profile from Auth0 (Management API)
router.get("/", checkJwt, async (req, res) => {
    try {
        const auth0UserId = req.auth?.payload?.sub;
        if (!auth0UserId) return res.status(401).json({ error: "Missing sub" });
        if (isMachineTokenSub(auth0UserId)) {
            return res.status(403).json({ error: "profile_not_available_for_machine_token" });
        }

        const user = await mgmtGetUser(auth0UserId);

        res.json({
            user_id: user.user_id,
            email: user.email,
            name: user.name,
            picture: user.picture,
            user_metadata: user.user_metadata || {}
        });
    } catch (error) {
        console.error("profile GET error:", error);
        res.status(502).json({ error: "profile_fetch_failed" });
    }
});

// PUT update user_metadata in Auth0
router.put("/", checkJwt, async (req, res) => {
    try {
        const auth0UserId = req.auth?.payload?.sub;
        if (!auth0UserId) return res.status(401).json({ error: "Missing sub" });
        if (isMachineTokenSub(auth0UserId)) {
            return res.status(403).json({ error: "profile_not_available_for_machine_token" });
        }

        const user_metadata = req.body?.user_metadata || {};
        if (typeof user_metadata !== "object" || Array.isArray(user_metadata)) {
            return res.status(400).json({ error: "Invalid user_metadata" });
        }

        const updated = await mgmtPatchUser(auth0UserId, { user_metadata });

        res.json({
            user_id: updated.user_id,
            email: updated.email,
            name: updated.name,
            picture: updated.picture,
            user_metadata: updated.user_metadata || {}
        });
    } catch (error) {
        console.error("profile PUT error:", error);
        res.status(502).json({ error: "profile_update_failed" });
    }
});

// POST request password reset email (Auth0 Database users only)
router.post("/change-password", checkJwt, async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim();
        if (!email) return res.status(400).json({ error: "Missing email" });

        const domain = mustEnv("AUTH0_DOMAIN");
        const clientId = mustEnv("AUTH0_CLIENT_ID");
        const connection = mustEnv("AUTH0_DB_CONNECTION");

        const resp = await fetch(`https://${domain}/dbconnections/change_password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: clientId,
                email,
                connection
            })
        });

        if (!resp.ok) {
            return res.status(502).json({ error: "change_password_failed" });
        }

        res.json({ ok: true });
    } catch (error) {
        console.error("profile change-password error:", error);
        res.status(500).json({ error: "change_password_failed" });
    }
});

export default router;
