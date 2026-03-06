import fs from "node:fs";
import path from "node:path";
import multer from "multer";

function safeSegment(s) {
    return String(s || "")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 120);
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

export function makeUploadMiddleware() {
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const auth0Sub = req.auth?.payload?.sub; // express-oauth2-jwt-bearer payload
            const entityType = req.params.entityType;

            const userFolder = safeSegment(auth0Sub || "unknown");
            const entityFolder = safeSegment(entityType);

            const dest = path.join(process.cwd(), "uploads", userFolder, entityFolder);
            ensureDir(dest);
            cb(null, dest);
        },
        filename: (req, file, cb) => {
            const ts = Date.now();
            const base = safeSegment(file.originalname);
            cb(null, `${ts}_${base}`);
        },
    });

    return multer({ storage });
}
