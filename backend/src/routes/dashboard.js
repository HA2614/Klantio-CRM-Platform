import express from "express";
import { dashboardController } from "../controllers/dashboardController.js";
import { checkJwt, debugAuthHeader } from "../middleware/authMiddleware.js";
import { attachUser } from "../middleware/userContext.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

router.get(
    "/",
    debugAuthHeader,
    checkJwt,
    attachUser,
    requireActiveSubscription,
    dashboardController.getDashboard
);

export default router;