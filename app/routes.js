const express = require("express");
const logger = require('../config/logger');
const router = express.Router();


router.get("/", (req, res) => res.json({ hello: "World" }));


module.exports = router;