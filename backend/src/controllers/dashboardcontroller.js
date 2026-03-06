// src/controllers/dashboardController.js
import { db } from "../config/database.js";
import { InvoicesModel } from "../models/Invoices.js";

async function queryRecentActivitiesFromActivityLog(userId, limit) {
    try {
        const { rows } = await db.query(
            `
      SELECT activity_type, description, created_at
      FROM activity_log
      WHERE user_id=$1
      ORDER BY created_at DESC
      LIMIT $2
      `,
            [userId, limit]
        );
        return rows;
    } catch (e) {
        if (e?.code === "42P01" || e?.code === "42703") return [];
        throw e;
    }
}

async function queryRecentActivitiesFromActivitiesTable(userId, limit) {
    try {
        const { rows } = await db.query(
            `
      SELECT
        COALESCE(activity_type, 'activity') AS activity_type,
        COALESCE(description, '') AS description,
        created_at
      FROM activities
      WHERE user_id=$1
      ORDER BY created_at DESC
      LIMIT $2
      `,
            [userId, limit]
        );
        return rows;
    } catch (e) {
        if (e?.code === "42P01" || e?.code === "42703") return [];
        throw e;
    }
}

async function queryRecentActivitiesFromProjects(userId, limit) {
    const { rows } = await db.query(
        `
    SELECT
      CASE
        WHEN p.updated_at IS NULL OR p.updated_at <= p.created_at
          THEN 'project_created'
        ELSE 'project_updated'
      END AS activity_type,
      CASE
        WHEN p.updated_at IS NULL OR p.updated_at <= p.created_at
          THEN 'Opdracht aangemaakt: ' || COALESCE(p.name, '(zonder naam)')
        ELSE 'Opdracht bijgewerkt: ' || COALESCE(p.name, '(zonder naam)')
      END AS description,
      GREATEST(COALESCE(p.updated_at, p.created_at), p.created_at) AS created_at
    FROM projects p
    WHERE p.user_id=$1
    ORDER BY GREATEST(COALESCE(p.updated_at, p.created_at), p.created_at) DESC
    LIMIT $2
    `,
        [userId, limit]
    );

    return rows;
}

async function getRecentActivities(userId, limit = 3) {
    const fromActivityLog = await queryRecentActivitiesFromActivityLog(userId, limit);
    if (fromActivityLog.length > 0) return fromActivityLog.slice(0, limit);

    const fromActivities = await queryRecentActivitiesFromActivitiesTable(userId, limit);
    if (fromActivities.length > 0) return fromActivities.slice(0, limit);

    return queryRecentActivitiesFromProjects(userId, limit);
}

export const dashboardController = {
    async getDashboard(req, res) {
        try {
            const userId = req.user.id;

            // user profile (light)
            const user = {
                id: req.user.id,
                name: req.user.name || req.user.email || "Gebruiker",
                email: req.user.email || null,
            };

            // stats
            const [{ rows: contactsRows }, { rows: projectsRows }, { rows: openInvRows }] =
                await Promise.all([
                    db.query(`SELECT COUNT(*)::int AS total_contacts FROM contacts WHERE user_id=$1`, [userId]),
                    db.query(
                        `SELECT COUNT(*)::int AS active_projects FROM projects WHERE user_id=$1 AND status IN ('gepland','uitgevoerd','gefactureerd')`,
                        [userId]
                    ),
                    db.query(
                        `SELECT COUNT(*)::int AS open_invoices FROM invoices WHERE user_id=$1 AND status IN ('sent','overdue')`,
                        [userId]
                    ),
                ]);

            const stats = {
                total_contacts: contactsRows[0]?.total_contacts || 0,
                active_projects: projectsRows[0]?.active_projects || 0,
                open_invoices: openInvRows[0]?.open_invoices || 0,
            };

            // recent activity
            const recent_activities = await getRecentActivities(userId, 3);

            // upcoming shifts (projects)
            const { rows: upcoming_shifts } = await db.query(
                `
        WITH project_dates AS (
          SELECT
            p.id,
            p.name,
            p.status,
            COALESCE(p.period_start, p.start_date) AS period_start,
            COALESCE(p.period_end, p.end_date, p.period_start, p.start_date) AS period_end,
            p.locatie,
            p.tarief,
            p.work_start,
            p.work_end,
            p.user_id,
            p.contact_id,
            p.created_at
          FROM projects p
          WHERE p.user_id=$1
        )
        SELECT
          p.id,
          p.name,
          p.status,
          p.period_start,
          p.period_start AS periode_start,
          p.period_end,
          p.period_end AS periode_end,
          p.locatie,
          p.tarief,
          p.work_start,
          p.work_end,
          (
            SELECT c.name
            FROM contacts c
            WHERE c.user_id=p.user_id AND c.id=p.contact_id
            LIMIT 1
          ) AS opdrachtgever
        FROM project_dates p
        WHERE
          (p.period_start IS NOT NULL AND p.period_end >= (NOW()::date))
          OR (
            p.period_start IS NULL
            AND p.status IN ('gepland', 'uitgevoerd', 'gefactureerd', 'active')
          )
        ORDER BY
          CASE WHEN p.period_start IS NULL THEN 1 ELSE 0 END ASC,
          p.period_start ASC NULLS LAST,
          p.created_at DESC
        LIMIT 5
        `,
                [userId]
            );

            // received this month (paid invoices)
            const fromYear = 2020;
            const monthRows = await InvoicesModel.computeMonthTotals(userId, fromYear);
            await InvoicesModel.upsertMonthCache(userId, monthRows);

            const now = new Date();
            const year = now.getUTCFullYear();
            const month = now.getUTCMonth() + 1;

            const currentMonth = monthRows.find(
                (r) => Number(r.year) === Number(year) && Number(r.month) === Number(month)
            );

            const received_this_month = currentMonth
                ? {
                    year: Number(currentMonth.year),
                    month: Number(currentMonth.month),
                    invoice_count: Number(currentMonth.invoice_count || 0),
                    total_amount: Number(currentMonth.total_amount || 0),
                }
                : {
                    year,
                    month,
                    invoice_count: 0,
                    total_amount: 0,
                };

            res.json({
                ok: true,
                user,
                stats,
                recent_activities,
                vertical: {
                    upcoming_shifts,
                    received_this_month,
                    new_shifts_available: null,
                },
            });
        } catch (e) {
            console.error("dashboard getDashboard error:", e);
            res.status(500).json({ error: "Dashboard failed", message: e?.message || String(e) });
        }
    },
};
