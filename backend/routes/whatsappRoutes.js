import express from "express";
import { getWhatsAppStatus, logoutWhatsApp, disconnectWhatsApp, initWhatsApp } from "../src/services/whatsappservice.js";
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
    // This should only be called when user explicitly wants to logout
    // Use the logout function instead for proper cleanup
    const result = await logoutWhatsApp();
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Profile cleared. You will need to scan QR again to reconnect.' 
      });
    } else {
      res.status(500).json({ 
        error: "Failed to clear profile: " + result.message 
      });
    }
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
    const result = await disconnectWhatsApp();
    res.json({ success: true, message: result.message, session: result.session });
  } catch (error) {
    console.error("Error disconnecting WhatsApp:", error);
    res.status(500).json({ error: "Failed to disconnect WhatsApp" });
  }
});

export default router;
