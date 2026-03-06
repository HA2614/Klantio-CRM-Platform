// src/routes/projects.js
import express from "express";
import multer from "multer";

import { checkJwt } from "../middleware/authMiddleware.js";
import { attachUser } from "../middleware/userContext.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";

import { ProjectsModel } from "../models/Projects.js";
import { uploadScanAndLinkInvoiceToProject } from "../services/projectInvoiceLink.js";

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
});

router.use(checkJwt, attachUser, requireActiveSubscription);

// list
router.get("/", async (req, res) => {
    try {
        res.json(await ProjectsModel.list(req.user.id));
    } catch (e) {
        console.error("projects list error:", e);
        res.status(500).json({ error: "projects_list_failed" });
    }
});

// create
router.post("/", async (req, res) => {
    try {
        if (!req.is("application/json")) {
            return res.status(415).json({ error: "unsupported_media_type" });
        }

        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return res.status(400).json({ error: "invalid_payload" });
        }

        const created = await ProjectsModel.create(req.user.id, body);
        res.status(201).json(created);
    } catch (e) {
        console.error("projects create error:", e);
        if (e?.code === "PROJECT_INVOICE_REQUIRED" || e?.code === "23514") {
            return res.status(400).json({
                error: "invoice_required_for_status",
                message: "Status 'gefactureerd/paid' vereist een geldige invoice_id.",
            });
        }
        res.status(500).json({ error: "projects_create_failed" });
    }
});

// update
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

        const updated = await ProjectsModel.update(req.user.id, id, body);
        if (!updated) return res.status(404).json({ error: "Not found" });
        res.json(updated);
    } catch (e) {
        console.error("projects update error:", e);
        if (e?.code === "PROJECT_INVOICE_REQUIRED" || e?.code === "23514") {
            return res.status(400).json({
                error: "invoice_required_for_status",
                message: "Status 'gefactureerd/paid' vereist een geldige invoice_id.",
            });
        }
        res.status(500).json({ error: "projects_update_failed" });
    }
});

// delete (cascade optioneel)
router.delete("/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: "invalid_id" });
        }

        const cascade = String(req.query.cascade || "0") === "1";

        const deleted = cascade
            ? await ProjectsModel.removeCascade(req.user.id, id)
            : await ProjectsModel.remove(req.user.id, id);

        if (!deleted) return res.status(404).json({ error: "Not found" });
        res.json({ ok: true, ...deleted });
    } catch (e) {
        console.error("projects delete error:", e);
        res.status(500).json({ error: "projects_delete_failed" });
    }
});

// invoice upload + scan + link
router.post("/:id/invoice-upload", upload.single("file"), async (req, res) => {
    try {
        const projectId = Number(req.params.id);
        const file = req.file;
        if (!file) return res.status(400).json({ error: "Missing file field 'file'" });

        const out = await uploadScanAndLinkInvoiceToProject({
            userId: req.user.id,
            auth0Sub: req.user.auth0_sub || req.user.sub || "unknown",
            projectId,
            file,
        });

        res.json(out);
    } catch (e) {
        console.error("invoice-upload error:", e);
        res.status(500).json({ error: "invoice-upload failed", message: e?.message || String(e) });
    }
});

export default router;
