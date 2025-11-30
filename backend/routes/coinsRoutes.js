import express from "express";
import { authenticateToken } from "../middleware/authMiddleware.js";
import {
  getUserCoins,
  reserveCampaignCoins,
  refundCampaignCoins,
} from "../src/services/coinService.js";

const router = express.Router();
router.use(authenticateToken);

router.get("/balance", async (req, res) => {
  try {
    const userId = req.user.id;
    const coins = await getUserCoins(userId);
    res.json({ success: true, coins });
  } catch (e) {
    console.error("Balance error:", e);
    res.status(500).json({ success: false, message: "Failed to get balance" });
  }
});

router.post("/authorize", async (req, res) => {
  const userId = req.user.id;
  const required = parseInt(req.body?.required);
  if (!required || required <= 0) {
    return res.status(400).json({ success: false, message: "required must be > 0" });
  }

  try {
    await reserveCampaignCoins(userId, null, required);
    res.json({ success: true, reserved: required });
  } catch (e) {
    console.error("Authorize coins error:", e);
    res.status(400).json({ success: false, message: e.message || "Failed to authorize coins" });
  }
});

router.post("/refund", async (req, res) => {
  const userId = req.user.id;
  const amount = parseInt(req.body?.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, message: "amount must be > 0" });
  }
  try {
    await refundCampaignCoins(userId, amount, null, "manual_refund");
    res.json({ success: true, refunded: amount });
  } catch (e) {
    console.error("Refund coins error:", e);
    res.status(500).json({ success: false, message: e.message || "Failed to refund coins" });
  }
});

export default router;