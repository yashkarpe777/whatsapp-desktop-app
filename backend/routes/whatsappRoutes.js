import express from "express";
import { getWhatsAppStatus, logoutWhatsApp, initWhatsApp } from "../src/services/whatsappservice.js";
import fs from 'fs';
import path from 'path';

const router = express.Router();

// Lightweight status endpoint - does NOT initialize
router.get("/status", (req, res) => {
  try {
    res.json(getWhatsAppStatus());
  } catch (error) {
    console.error("Error getting WhatsApp status:", error);
    res.status(500).json({ error: "Failed to get WhatsApp status" });
  }
});

// QR/init endpoint - MAY trigger initialization lazily
router.get("/qr", async (req, res) => {
  try {
    const status = getWhatsAppStatus();
    if (!status.ready && !status.initializing) {
      try {
        await initWhatsApp();
      } catch (e) {
        // swallow here; client will poll until QR/ready
      }
    }
    res.json(getWhatsAppStatus());
  } catch (error) {
    console.error("Error getting WhatsApp status:", error);
    res.status(500).json({ error: "Failed to get WhatsApp status" });
  }
});

// Explicit init endpoint for Settings "Connect" button
router.post("/init", async (req, res) => {
  try {
    await initWhatsApp();
    res.json(getWhatsAppStatus());
  } catch (error) {
    console.error("Error initializing WhatsApp:", error);
    res.status(500).json({ error: "Failed to initialize WhatsApp" });
  }
});

// Clean profile endpoint to remove saved LocalAuth data
router.delete("/profile", async (req, res) => {
  try {
    // Ensure the running client is fully stopped to release file locks
    try { await logoutWhatsApp(); } catch {}

    const candidates = [];
    // WHATSAPP_DATA_PATH (exact)
    if (process.env.WHATSAPP_DATA_PATH) candidates.push(process.env.WHATSAPP_DATA_PATH);
    // CWD default
    candidates.push(path.join(process.cwd(), '.wwebjs_auth'));
    // Backend-root default (in case CWD differs)
    const here = path.dirname(new URL(import.meta.url).pathname);
    candidates.push(path.join(here, '..', '..', '.wwebjs_auth'));

    let deletedAny = false;
    for (const p of candidates) {
      try {
        await fs.promises.rm(p, { recursive: true, force: true });
        deletedAny = true;
      } catch {}
    }

    if (!deletedAny) {
      // Even if nothing existed, treat as success (profile already clean)
      return res.json({ success: true, message: 'No profile data found. You can connect now.' });
    }

    res.json({ success: true, message: 'Profile cleared. You will need to scan QR again.' });
  } catch (error) {
    console.error("Error clearing WhatsApp profile:", error);
    res.status(500).json({ error: "Failed to clear profile" });
  }
});

router.post("/logout", async (req, res) => {
  try {
    await logoutWhatsApp();
    res.json({ success: true, message: "WhatsApp logged out" });
  } catch (error) {
    console.error("Error logging out WhatsApp:", error);
    res.status(500).json({ error: "Failed to logout WhatsApp" });
  }
});

// Alias to match frontend expectation
router.post("/disconnect", async (req, res) => {
  try {
    await logoutWhatsApp();
    res.json({ success: true, message: "WhatsApp disconnected" });
  } catch (error) {
    console.error("Error disconnecting WhatsApp:", error);
    res.status(500).json({ error: "Failed to disconnect WhatsApp" });
  }
});

export default router;
