import express from "express";
import { checkJwt } from "../middleware/authMiddleware.js";
import { attachUser } from "../middleware/userContext.js";
import { ContactsModel } from "../models/Contacts.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

router.use(checkJwt, attachUser, requireActiveSubscription);

router.get("/", async (req, res) => {
    try {
        res.json(await ContactsModel.list(req.user.id));
    } catch (e) {
        console.error("contacts list error:", e);
        res.status(500).json({ error: "contacts_list_failed" });
    }
});

router.post("/", async (req, res) => {
    try {
        if (!req.is("application/json")) {
            return res.status(415).json({ error: "unsupported_media_type" });
        }

        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return res.status(400).json({ error: "invalid_payload" });
        }

        const name = String(body.name || "").trim();
        if (!name) {
            return res.status(400).json({ error: "name_required" });
        }

        const created = await ContactsModel.create(req.user.id, { ...body, name });
        res.status(201).json(created);
    } catch (e) {
        console.error("contacts create error:", e);
        if (e?.code === "INVALID_CONTACT_NAME" || e?.code === "23502") {
            return res.status(400).json({ error: "name_required" });
        }
        res.status(500).json({ error: "contacts_create_failed" });
    }
});

router.put("/:id", async (req, res) => {
    try {
        if (!req.is("application/json")) {
            return res.status(415).json({ error: "unsupported_media_type" });
        }

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: "invalid_id" });
        }

        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return res.status(400).json({ error: "invalid_payload" });
        }

        const name = String(body.name || "").trim();
        if (!name) {
            return res.status(400).json({ error: "name_required" });
        }

        const updated = await ContactsModel.update(req.user.id, id, { ...body, name });
        if (!updated) return res.status(404).json({ error: "Not found" });
        res.json(updated);
    } catch (e) {
        console.error("contacts update error:", e);
        if (e?.code === "INVALID_CONTACT_NAME" || e?.code === "23502") {
            return res.status(400).json({ error: "name_required" });
        }
        res.status(500).json({ error: "contacts_update_failed" });
    }
});

router.delete("/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: "invalid_id" });
        }

        const deleted = await ContactsModel.remove(req.user.id, id);
        if (!deleted) return res.status(404).json({ error: "Not found" });
        res.json({ ok: true });
    } catch (e) {
        console.error("contacts delete error:", e);
        res.status(500).json({ error: "contacts_delete_failed" });
    }
});

export default router;
