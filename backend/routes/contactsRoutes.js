import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { uploadContacts, getContacts, deleteContact, bulkDeleteContacts, getContactGroups, deleteContactFile, getUploadedFiles, deleteContactGroup } from '../controllers/contactsController.js';
import { authenticateToken } from '../middleware/authMiddleware.js'; // Assuming this exists or we need to create it

const router = express.Router();

// Multer setup for file uploads
const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir });

// Apply authentication to all routes
router.use(authenticateToken);

// Routes
router.post('/upload', upload.single('file'), uploadContacts);
router.get('/', getContacts);
router.get('/groups', getContactGroups);
router.delete('/groups/:groupId', deleteContactGroup);
router.get('/files', getUploadedFiles);
router.delete('/:id', deleteContact);
router.delete('/', bulkDeleteContacts); // Bulk delete via POST body
router.delete('/files/:filename', deleteContactFile);

export default router;
