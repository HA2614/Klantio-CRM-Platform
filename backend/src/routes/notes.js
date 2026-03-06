// backend/src/routes/notes.js
import express from "express";
import { checkJwt } from "../middleware/authMiddleware.js";
import { attachUser } from "../middleware/userContext.js";
import { NotesModel } from "../models/Notes.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

router.use(checkJwt, attachUser, requireActiveSubscription);


function normalizeEntityType(t) {
    const allowed = ["contacts", "projects", "invoices", "accounts", "tasks", "milestones"];
    const v = String(t || "").toLowerCase();
    if (!allowed.includes(v)) return null;
    return v;
}

router.get("/:entityType/:entityId", checkJwt, attachUser, async (req, res) => {
    const entityType = normalizeEntityType(req.params.entityType);
    const entityId = Number(req.params.entityId);
    if (!entityType || !Number.isFinite(entityId)) {
        return res.status(400).json({ error: "Invalid entity" });
    }

    const notes = await NotesModel.list(req.user.id, entityType, entityId);
    res.json(notes);
});

router.post("/:entityType/:entityId", checkJwt, attachUser, async (req, res) => {
    const entityType = normalizeEntityType(req.params.entityType);
    const entityId = Number(req.params.entityId);
    const body = String(req.body?.body || "").trim();

    if (!entityType || !Number.isFinite(entityId)) {
        return res.status(400).json({ error: "Invalid entity" });
    }
    if (!body) return res.status(400).json({ error: "Body required" });

    const created = await NotesModel.create(req.user.id, entityType, entityId, body);
    res.status(201).json(created);
});

router.put("/:id", checkJwt, attachUser, async (req, res) => {
    const id = Number(req.params.id);
    const body = String(req.body?.body || "").trim();
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    if (!body) return res.status(400).json({ error: "Body required" });

    const updated = await NotesModel.update(req.user.id, id, body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
});

router.delete("/:id", checkJwt, attachUser, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const ok = await NotesModel.remove(req.user.id, id);
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
});

export default router;
