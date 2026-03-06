import pool from '../config/database.js';

export const DashboardModel = {
    // Get dashboard statistics
    async getStats(userId) {
        try {
            const stats = await pool.query(
                `SELECT 
          (SELECT COUNT(*) FROM contacts WHERE user_id = $1) as total_contacts,
          (SELECT COUNT(*) FROM projects WHERE user_id = $1 AND status = 'active') as active_projects,
          (SELECT COUNT(*) FROM invoices WHERE user_id = $1 AND status IN ('draft', 'sent')) as open_invoices,
          (SELECT COALESCE(SUM(amount), 0) FROM invoices 
           WHERE user_id = $1 
           AND status = 'paid' 
           AND EXTRACT(MONTH FROM paid_date) = EXTRACT(MONTH FROM CURRENT_DATE)
           AND EXTRACT(YEAR FROM paid_date) = EXTRACT(YEAR FROM CURRENT_DATE)) as month_revenue`,
                [userId]
            );

            return stats.rows[0];
        } catch (error) {
            console.error('Error getting dashboard stats:', error);
            throw error;
        }
    },

    // Get recent activities
    async getRecentActivities(userId, limit = 10) {
        try {
            const r = await pool.query(
                `SELECT activity_type, description, created_at
             FROM activity_log
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
                [userId, limit]
            );
            return r.rows;
        } catch (e) {
            // 42P01 = relation does not exist
            if (e?.code === "42P01") {
                return [];
            } else {
                throw e;
            }
        }
    }

    // Get recent projects
    async getRecentProjects(userId, limit = 5) {
        try {
            const projects = await pool.query(
                `SELECT p.*, c.name as contact_name 
         FROM projects p
         LEFT JOIN contacts c ON p.contact_id = c.id
         WHERE p.user_id = $1 
         ORDER BY p.updated_at DESC 
         LIMIT $2`,
                [userId, limit]
            );

            return projects.rows;
        } catch (error) {
            console.error('Error getting projects:', error);
            throw error;
        }
    }
};