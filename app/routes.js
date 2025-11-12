const express = require("express");
const logger = require('../config/logger');
const { requireRoles } = require('./policies/RolePolicity.js')
const validateSchema = require("./middlewares/validateSchema");
const auth = require("./middlewares/auth");
const { roleSchema, idRoleSchema, updateRoleSchema } = require("./middlewares/validations/roleValidations");
const { registerSchema, loginSchema, updateSchema } = require("./middlewares/validations/authValidations");
const RoleController = require("./controllers/RoleController");
const AuthController = require("./controllers/AuthController");
const router = express.Router();


router.get("/", (req, res) => res.json({ hello: "World" }));

router.post("/sign-up", validateSchema(registerSchema), AuthController.signUp);
router.post("/sign-in", validateSchema(loginSchema), AuthController.signIn);
//rutas protegidas
router.use(auth);
router.get("/logout", AuthController.logout);
router.post("/user-update", requireRoles(['admin']), validateSchema(updateSchema), AuthController.update);
router.post("/user-destroy", requireRoles(['admin']), validateSchema(idRoleSchema), AuthController.destroy);
router.get("/get-users", requireRoles(['admin']), AuthController.index);

//Rutas Roles
router.get("/role", requireRoles(['admin']),RoleController.index);
router.post("/role", requireRoles(['admin']), validateSchema(roleSchema), RoleController.store);
router.post("/role-update", requireRoles(['admin']), validateSchema(updateRoleSchema), RoleController.update);
router.post("/role-destroy", requireRoles(['admin']), validateSchema(idRoleSchema), RoleController.destroy);
module.exports = router;