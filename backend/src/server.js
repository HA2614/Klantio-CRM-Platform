import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";

import pool from "./config/database.js";

import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import dashboardRoutes from "./routes/dashboard.js";
import contactsRoutes from "./routes/contacts.js";
import projectsRoutes from "./routes/projects.js";
import invoicesRoutes from "./routes/invoices.js";
import notesRoutes from "./routes/notes.js";
import attachmentsRoutes from "./routes/attachments.js";
import profileRoutes from "./routes/profile.js";
import adminRoutes from "./routes/admin.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
app.disable("x-powered-by");

// CORS 1 keer, helemaal bovenaan
const corsOptions = {
    origin: ["http://localhost:8080", "http://127.0.0.1:8080"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Body parsers 1 keer, vóór routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static uploads
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// Debug auth header (mag blijven)
app.use((req, res, next) => {
    if (req.headers.authorization) {
        console.log("AUTH HEADER:", req.headers.authorization.slice(0, 30) + "...");
    } else {
        console.log("NO AUTH HEADER for", req.method, req.url);
    }
    next();
});

// Health
app.get("/health", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");
        res.json({
            status: "OK",
            timestamp: new Date().toISOString(),
            database: "connected",
            db_time: result.rows[0].now,
        });
    } catch (error) {
        res.status(500).json({
            status: "ERROR",
            database: "disconnected",
            error: error.message,
        });
    }
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/contacts", contactsRoutes);
app.use("/api/projects", projectsRoutes);
app.use("/api/invoices", invoicesRoutes);
app.use("/api/notes", notesRoutes);
app.use("/api/attachments", attachmentsRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/admin", adminRoutes);

// 404
app.use((req, res) => {
    res.status(404).json({ error: "Not Found" });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error("UNHANDLED ERROR:", err);
    res.status(err.status || 500).json({
        error: err.name || "Internal Server Error",
        message: err?.message || "Unknown error",
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Auth0 Domain: ${process.env.AUTH0_DOMAIN}`);
    console.log(`Auth0 Audience: ${process.env.AUTH0_AUDIENCE}`);
});
