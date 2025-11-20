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

// File filter to accept all common media types
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    // Videos
    'video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv', 'video/mkv', 'video/webm', 'video/quicktime',
    // Images
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml',
    // Documents
    'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv',
    // Audio
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/aac'
  ];

  const fileExt = path.extname(file.originalname).toLowerCase();
  const allowedExts = [
    '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.3gp',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv',
    '.mp3', '.wav', '.ogg', '.aac'
  ];

  if (allowedTypes.includes(file.mimetype) || allowedExts.includes(fileExt)) {
    console.log(`✅ Accepted file: ${file.originalname} (${file.mimetype})`);
    cb(null, true);
  } else {
    console.warn(`⚠️ Rejected file: ${file.originalname} (${file.mimetype})`);
    cb(new Error(`File type not supported. Allowed: videos, images, PDFs, documents, audio. Got: ${file.mimetype}`));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB max file size (will be compressed if needed)
  }
});

router.get("/", getCampaigns);

// Expose combined logs endpoints for Logs page
router.get("/logs", getLogs);
router.get("/logs/export", getAllLogsCSV);

router.get("/:id/logs", getCampaignLogs);
router.get("/:id/logs/export", getCampaignLogsCSV);

router.post("/create", upload.single('attachment'), createCampaign);
router.post("/:id/start", startCampaign);
router.post("/:id/pause", pauseCampaign);
router.post("/:id/resume", resumeCampaign);
router.post("/:id/retry-failed", retryFailed);
router.get("/:id/status", getCampaignStatus);
router.delete("/:id", deleteCampaign);
// Accept optional media when updating campaign
router.put("/:id", upload.single('attachment'), updateCampaign);
// Rerun endpoint with optional updated media/caption
router.post("/:id/rerun", upload.single('attachment'), rerunCampaign);

export default router;
