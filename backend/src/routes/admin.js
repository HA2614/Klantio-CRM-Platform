import express from "express";
import { checkJwt, checkPermissions } from "../middleware/authMiddleware.js";
import { attachUser } from "../middleware/userContext.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";
import { adminController } from "../controllers/adminController.js";

const router = express.Router();

// Alles admin-only
router.use(checkJwt, attachUser, requireActiveSubscription, checkPermissions(["admin:access"]));

router.get("/users", adminController.listUsers);
router.patch("/users/:id/subscription", adminController.extendSubscription);
router.patch("/users/:id/block", adminController.blockUser);
router.patch("/users/:id/profile", adminController.updateProfile);
router.post("/users/:id/password-reset", adminController.sendPasswordReset);

export default router;
