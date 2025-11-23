import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8283;

// Serve static files from the "web" directory
app.use(express.static(path.join(__dirname, "web")));

// Serve index.html for the root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "web", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🌐 Web server started on port ${PORT}`);
});
