import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { authenticateToken } from "../middleware/authMiddleware.js";
import { getSettings, updateSettings, testDbConfig, saveDbConfig, testDbConfigSetup, saveDbConfigSetup, checkDbStatus } from "../controllers/settingsController.js";

const router = express.Router();

const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext);
    const name = `${Date.now()}-${baseName}${ext}`;
    cb(null, name);
  }
});

const upload = multer({ storage });

router.post('/db/test', testDbConfig);
router.post('/test-db-config', testDbConfigSetup);
router.post('/save-db-config', saveDbConfigSetup);

router.use(authenticateToken);
router.get('/', getSettings);
router.put('/', upload.single('app_icon'), updateSettings);
router.put('/db', saveDbConfig);
router.get('/db/status', checkDbStatus);

export default router;
