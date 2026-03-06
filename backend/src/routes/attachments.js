// backend/src/routes/attachments.js
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkJwt } from "../middleware/authMiddleware.js";
import { attachUser } from "../middleware/userContext.js";
import { AttachmentsModel } from "../models/Attachments.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

router.use(checkJwt, attachUser, requireActiveSubscription);


// uploads root: backend/uploads (2 levels up from src/routes -> backend)
const uploadsRoot = path.resolve(__dirname, "../../uploads");


router.get("/download/:id", checkJwt, attachUser, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const item = await AttachmentsModel.getById(req.user.id, id);
    if (!item) return res.status(404).json({ error: "Not found" });

    const filePath = item.storage_path;

    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File missing on disk" });
    }

    const downloadName = item.original_name || item.stored_name || "download";

    res.setHeader("Content-Type", item.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(downloadName)}"`);

    fs.createReadStream(filePath).pipe(res);
});


// Windows-safe folder segment (Auth0 sub contains "|", which is invalid on Windows paths)
function safePathSegment(s) {
    return String(s || "unknown").replace(/[<>:"/\\|?*]/g, "_");
}

function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

function normalizeEntityType(t) {
    const allowed = ["contacts", "projects", "invoices", "accounts", "tasks", "milestones"];
    const v = String(t || "").toLowerCase();
    if (!allowed.includes(v)) return null;
    return v;
}

// Ensure root exists once
ensureDir(uploadsRoot);

// Storage per user + entity
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            const entityType = normalizeEntityType(req.params.entityType);
            const entityId = String(req.params.entityId || "");
            const auth0SubRaw = req.auth?.payload?.sub || "unknown";
            const auth0Sub = safePathSegment(auth0SubRaw);

            if (!entityType || !/^\d+$/.test(entityId)) {
                return cb(new Error("Invalid entity"), null);
            }

            const dir = path.join(uploadsRoot, auth0Sub, entityType, entityId);
            ensureDir(dir);
            cb(null, dir);
        } catch (e) {
            cb(e, null);
        }
    },
    filename: (req, file, cb) => {
        const safe = String(file.originalname || "file").replace(/[^\w.\-() ]+/g, "_");
        const stamp = Date.now();
        cb(null, `${stamp}_${safe}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

router.get("/:entityType/:entityId", checkJwt, attachUser, async (req, res) => {
    const entityType = normalizeEntityType(req.params.entityType);
    const entityId = Number(req.params.entityId);
    if (!entityType || !Number.isFinite(entityId)) {
        return res.status(400).json({ error: "Invalid entity" });
    }

    const items = await AttachmentsModel.list(req.user.id, entityType, entityId);
    res.json(items);
});

// multipart upload: field name "file"
router.post(
    "/:entityType/:entityId",
    checkJwt,
    attachUser,
    upload.single("file"),
    async (req, res) => {
        const entityType = normalizeEntityType(req.params.entityType);
        const entityId = Number(req.params.entityId);

        if (!entityType || !Number.isFinite(entityId)) {
            return res.status(400).json({ error: "Invalid entity" });
        }
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const created = await AttachmentsModel.create(req.user.id, entityType, entityId, req.file);
        res.status(201).json(created);
    }
);




router.delete("/:id", checkJwt, attachUser, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    // Make sure your model returns the removed row (incl storage_path)
    const removed = await AttachmentsModel.remove(req.user.id, id);
    if (!removed) return res.status(404).json({ error: "Not found" });

    try {
        if (removed.storage_path && fs.existsSync(removed.storage_path)) {
            fs.unlinkSync(removed.storage_path);
        }
    } catch (e) {
        // file delete fail should not block
    }

    res.json({ ok: true });
});

export default router;


