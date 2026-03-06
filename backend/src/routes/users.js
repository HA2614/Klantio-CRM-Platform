import express from "express";
import { checkJwt, checkPermissions } from "../middleware/authMiddleware.js";
import { attachUser } from "../middleware/userContext.js";
import { requireActiveSubscription } from "../middleware/subscriptionMiddleware.js";


const router = express.Router();

router.use(checkJwt, attachUser, requireActiveSubscription);

// Voorbeeld: Protected route met permissions
router.get('/profile',
    checkJwt,
    checkPermissions(['read:profile']),
    (req, res) => {
        res.json({
            message: 'User profile',
            userId: req.auth.payload.sub,
            permissions: req.auth.payload.permissions
        });
    }
);

export default router;