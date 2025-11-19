const express = require("express");
const logger = require('../config/logger');
const { requireRoles } = require('./policies/RolePolicity.js')
const validateSchema = require("./middlewares/validateSchema");
const auth = require("./middlewares/auth");
const RoleController = require("./controllers/RoleController");
const AuthController = require("./controllers/AuthController");
const LogController = require("./controllers/LogController.js");
const InvitationController = require("./controllers/InvitationController.js");
const CompanyController = require("./controllers/CompanyController.js");
const BranchController = require("./controllers/BranchController.js");
const WarehouseController = require("./controllers/WarehouseController.js");
const BusinessTypeController = require("./controllers/BusinessTypeController.js");
const { roleSchema, idRoleSchema, updateRoleSchema } = require("./middlewares/validations/roleValidations");
const { registerSchema, loginSchema, updateSchema } = require("./middlewares/validations/authValidations");
const { updateCompanySchema, byUserIdSchema, storeCompanySchema, idCompanySchema } = require("./middlewares/validations/companyValidations.js");
const { listBranchesSchema, storeBranchSchema, updateBranchSchema, idBranchSchema } = require("./middlewares/validations/branchValidations.js");
const { listWarehouseSchema, storeWarehouseSchema, updateWarehouseSchema, idWarehouseSchema } = require("./middlewares/validations/warehouseValidations.js");
const { businessTypeSchema, updateBusinessTypeSchema, idBusinessTypeSchema } = require("./middlewares/validations/businessTypeValidations.js");
const router = express.Router();


router.get("/", (req, res) => res.json({ hello: "World" }));

router.post("/sign-up", validateSchema(registerSchema), AuthController.signUp);
router.post("/sign-in", validateSchema(loginSchema), AuthController.signIn);
router.get("/verific-invitation", InvitationController.verificInvitation);
//rutas protegidas
router.use(auth);
router.get("/logout", AuthController.logout);
router.post("/user-update", requireRoles(['Admin']), validateSchema(updateSchema), AuthController.update);
router.post("/user-destroy", requireRoles(['Admin']), validateSchema(idRoleSchema), AuthController.destroy);
router.get("/get-users", requireRoles(['Admin']), AuthController.index);
router.post("/send-invitation", requireRoles(['Admin']), validateSchema(updateSchema), InvitationController.sendInvitation);

//Rutas Roles
router.get("/role", requireRoles(['Admin']),RoleController.index);
router.post("/role", requireRoles(['Admin']), validateSchema(roleSchema), RoleController.store);
router.post("/role-update", requireRoles(['Admin']), validateSchema(updateRoleSchema), RoleController.update);
router.post("/role-destroy", requireRoles(['Admin']), validateSchema(idRoleSchema), RoleController.destroy);

// Endpoints BusinessTypes
router.get("/business-type", requireRoles(['Admin']), BusinessTypeController.index);
router.post("/business-type", requireRoles(['Admin']), validateSchema(businessTypeSchema), BusinessTypeController.store);
router.post("/business-type-update", requireRoles(['Admin']), validateSchema(updateBusinessTypeSchema), BusinessTypeController.update);
router.post("/business-type-destroy", requireRoles(['Admin']), validateSchema(idBusinessTypeSchema), BusinessTypeController.destroy);

//Rutas de Companies
router.post("/company-by-user", requireRoles(['Admin']), validateSchema(byUserIdSchema), CompanyController.getCompaniesByUser);
router.post("/company", requireRoles(['Admin']), validateSchema(storeCompanySchema), CompanyController.store);
router.post("/company-update", requireRoles(['Admin']), validateSchema(updateCompanySchema), CompanyController.update);
router.post("/company-destroy", requireRoles(['Admin']), validateSchema(idCompanySchema), CompanyController.destroy);

//Rutas de Sucursales
router.post("/branch-user-company", requireRoles(['Admin']), validateSchema(listBranchesSchema), BranchController.list);
router.post("/branch", requireRoles(['Admin']), validateSchema(storeBranchSchema), BranchController.store);
router.post("/branch-update", requireRoles(['Admin']), validateSchema(updateBranchSchema), BranchController.update);
router.post("/branch-destroy", requireRoles(['Admin']), validateSchema(idBranchSchema), BranchController.destroy);

//Rutas de Almacénes
router.post("/warehouse-branch-company", requireRoles(['Admin']), validateSchema(listWarehouseSchema), WarehouseController.list);
router.post("/warehouse", requireRoles(['Admin']), validateSchema(storeWarehouseSchema), WarehouseController.store);
router.post("/warehouse-update", requireRoles(['Admin']), validateSchema(updateWarehouseSchema), WarehouseController.update);
router.post("/warehouse-destroy", requireRoles(['Admin']), validateSchema(idWarehouseSchema), WarehouseController.destroy);

//Rutas de los logs
router.post("/get-logs", requireRoles(['Admin']), LogController.getLogs);
module.exports = router;