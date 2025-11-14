const express = require("express");
const logger = require('../config/logger');
const { requireRoles } = require('./policies/RolePolicity.js')
const validateSchema = require("./middlewares/validateSchema");
const auth = require("./middlewares/auth");
const { roleSchema, idRoleSchema, updateRoleSchema } = require("./middlewares/validations/roleValidations");
const { registerSchema, loginSchema, updateSchema } = require("./middlewares/validations/authValidations");
const RoleController = require("./controllers/RoleController");
const AuthController = require("./controllers/AuthController");
const LogController = require("./controllers/LogController.js");
const router = express.Router();


router.get("/", (req, res) => res.json({ hello: "World" }));

router.post("/sign-up", validateSchema(registerSchema), AuthController.signUp);
router.post("/sign-in", validateSchema(loginSchema), AuthController.signIn);
//rutas protegidas
router.use(auth);
router.get("/logout", AuthController.logout);
router.post("/user-update", requireRoles(['Admin']), validateSchema(updateSchema), AuthController.update);
router.post("/user-destroy", requireRoles(['Admin']), validateSchema(idRoleSchema), AuthController.destroy);
router.get("/get-users", requireRoles(['Admin']), AuthController.index);

//Rutas Roles
router.get("/role", requireRoles(['Admin']),RoleController.index);
router.post("/role", requireRoles(['Admin']), validateSchema(roleSchema), RoleController.store);
router.post("/role-update", requireRoles(['Admin']), validateSchema(updateRoleSchema), RoleController.update);
router.post("/role-destroy", requireRoles(['Admin']), validateSchema(idRoleSchema), RoleController.destroy);

//Rutas de los logs
router.post("/get-logs", requireRoles(['Admin']), LogController.getLogs);
module.exports = router;