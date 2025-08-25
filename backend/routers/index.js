const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const chatRouter = require("./chatRouter");

// Routes cho đăng ký và đăng nhập
router.post("/register", authController.register);
router.post("/login", authController.login);

router.use("/chat", chatRouter);

module.exports = router;
