import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import dashboardRoutes from "./routes/dashboardroutes";
import campaignRoutes from "./routes/campaignRoutes";
import whatsappRoutes from "./routes/whatsappRoutes";
import authRoutes from "./routes/authRoutes";
import contactsRoutes from "./routes/contactsRoutes";
import settingsRoutes from "./routes/settingsRoutes";

dotenv.config();
const app = express();

// CORS configuration for desktop app
app.use(cors({
  origin: true, 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });
app.use('/uploads', express.static('uploads'));

app.use("/api/auth", authRoutes);
app.use("/api/contacts", contactsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/settings", settingsRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});