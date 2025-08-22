const express = require("express");
const app = express();

const connectDB = require("./config/db");
const cors = require("cors");
app.use(cors()); // Enable CORS for all routes
app.use(express.urlencoded({ extended: true })); // Middleware to parse URL-encoded bodies
app.use(express.json()); // Middleware to parse JSON bodies

const PORT = process.env.PORT || 9999;
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
