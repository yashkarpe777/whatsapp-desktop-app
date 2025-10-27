import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { authenticateToken } from "../middleware/authMiddleware.js";
import {
  createCampaign,
  startCampaign,
  deleteCampaign,
  updateCampaign,
  pauseCampaign,
  resumeCampaign,
  getCampaigns,
  getLogs,
  getCampaignStatus,
  getCampaignLogs,
  rerunCampaign,
  retryFailed,
  getCampaignLogsCSV,
  getAllLogsCSV
} from '../controllers/campaignController.js';

const router = express.Router();
router.use(authenticateToken);

const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext);
    const name = `${Date.now()}-${baseName}${ext}`;
    console.log('Saving uploaded file as:', name);
    cb(null, name);
  }
});

const upload = multer({ storage });

router.get("/", getCampaigns);

// Expose combined logs endpoints for Logs page
router.get("/logs", getLogs);
router.get("/logs/export", getAllLogsCSV);

router.get("/:id/logs", getCampaignLogs);
router.get("/:id/logs/export", getCampaignLogsCSV);

router.post("/create", upload.single('video'), createCampaign);
router.post("/:id/start", startCampaign);
router.post("/:id/pause", pauseCampaign);
router.post("/:id/resume", resumeCampaign);
router.post("/:id/retry-failed", retryFailed);
router.get("/:id/status", getCampaignStatus);
router.delete("/:id", deleteCampaign);
// Accept optional media when updating campaign
router.put("/:id", upload.single('video'), updateCampaign);
// Rerun endpoint with optional updated media/caption
router.post("/:id/rerun", upload.single('video'), rerunCampaign);

export default router;
