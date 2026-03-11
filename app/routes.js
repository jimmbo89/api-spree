const express = require("express");
const logger = require('../config/logger');
const fs = require("fs");
const path = require("path");
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
const { registerSchema, loginSchema, updateSchema, createUserSchema, updateUserSchema } = require("./middlewares/validations/authValidations");
const { updateCompanySchema, byUserIdSchema, storeCompanySchema, idCompanySchema, companyIdSchema } = require("./middlewares/validations/companyValidations.js");
const { listBranchesSchema, storeBranchSchema, updateBranchSchema, idBranchSchema } = require("./middlewares/validations/branchValidations.js");
const { listWarehouseSchema, storeWarehouseSchema, updateWarehouseSchema, idWarehouseSchema } = require("./middlewares/validations/warehouseValidations.js");
const { businessTypeSchema, updateBusinessTypeSchema, idBusinessTypeSchema } = require("./middlewares/validations/businessTypeValidations.js");
const ProductCategoryController = require("./controllers/ProductCategoryController.js");
const { productCategorySchema, updateProductCategorySchema, idProductCategorySchema } = require("./middlewares/validations/productCategoryValidations.js");
const { listProductsSchema, storeProductSchema, updateProductSchema, idProductSchema, listByWarehouseIdsSchema, assignWarehouseSchema } = require("./middlewares/validations/productValidations.js");
const ProductController = require("./controllers/ProductController.js");
const { listWarehouseProductSchema, storeWarehouseProductSchema, updateWarehouseProductSchema, idWarehouseProductSchema, transferSchema, bulkUploadSchema, bulkTransferSchema } = require("./middlewares/validations/warehouseProductValidations.js");
const WarehouseProductController = require("./controllers/WarehouseProductController.js");
const multerImage = require("./middlewares/multerImage.js");
const multerGeneric = require("./middlewares/multerGeneric.js");
const multerFieldFolders = require("./middlewares/multerFieldFolders.js");
const { storeMarketplaceSchema, updateMarketplaceSchema, idMarketplaceSchema } = require("./middlewares/validations/marketplaceValidations.js");
const MarketplaceController = require("./controllers/MarketplaceController.js");
const { createProductFieldMappingSchema, updateProductFieldMappingSchema, idProductFieldMappingSchema, listProductFieldMappingSchema, bulkCreateProductFieldMappingSchema } = require("./middlewares/validations/productFieldMappingValidations.js");
const ProductFieldMappingController = require("./controllers/ProductFieldMappingController.js");
const { storeProductPublishingTaskSchema, updateProductPublishingTaskStatusSchema, listProductPublishingTaskSchema, retryProductPublishingTaskSchema, publishDraftSchema } = require("./middlewares/validations/productPublishingTaskValidations.js");
const ProductPublishingTaskController = require("./controllers/ProductPublishingTaskController.js");
const { storeMarketplaceCredentialSchema, findByMarketplaceCredentialSchema, updateMarketplaceCredentialSchema, idMarketplaceCredentialSchema } = require("./middlewares/validations/marketplaceCredentialValidations.js");
const MarketplaceCredentialController = require("./controllers/MarketplaceCredentialController.js");
const OAuthController = require("./controllers/OAuthController.js");
const { listPoolsSchema, updatePoolSchema, storePoolSchema, idPoolSchema } = require("./middlewares/validations/poolValidations.js");
const PoolController = require("./controllers/PoolController.js");
const { getMovementsSchema } = require("./middlewares/validations/inventoryMovementValidation.js");
const InventoryMovementController = require("./controllers/InventoryMovementController.js");
const ProductVariantController = require("./controllers/ProductVariantController.js");
const PlanController = require("./controllers/PlanController.js");
const { planSchema, updatePlanSchema, idPlanSchema } = require("./middlewares/validations/planValidation.js");
const PermissionController = require("./controllers/PermissionController.js");
const { permissionSchema, updatePermissionSchema, idPermissionSchema } = require("./middlewares/validations/permissionValidation.js");
const { roleIdSchema, assignPermissionToRoleSchema, assignMultiplePermissionsToRoleSchema, updateRolePermissionSchema, idRolePermissionSchema, availablePermissionsForRoleSchema } = require("./middlewares/validations/rolePermissionValidation.js");
const RolePermissionController = require("./controllers/RolePermissionController.js");
const { idSubscriptionSchema, listSubscriptionsSchema, storeSubscriptionSchema, updateSubscriptionSchema } = require("./middlewares/validations/subscriptionValidation.js");
const SubscriptionController = require("./controllers/SubscriptionController.js");
const UserCompanyController = require("./controllers/UserCompanyController.js");
const { createUserCompanySchema, updateUserCompanyStatusSchema, userCompanyIdSchema, userCompanyByUserAndCompanySchema, userCompanyByTokenSchema, listUserCompanySchema, updateUserCompanyRoleSchema, createMembershipRequestSchema } = require("./middlewares/validations/userCompanyValidation.js");
const UserAclScopeController = require("./controllers/UserAclScopeController.js");
const { createUserAclScopeSchema, userAclScopeIdSchema, userAclScopesByUserAndCompanySchema } = require("./middlewares/validations/userAclScopeValidation.js");
const AttributeController = require("./controllers/AttributeController.js");
const { attributeSchema, updateAttributeSchema, idAttributeSchema } = require("./middlewares/validations/attributeValidation.js");
const { checkPlanLimit } = require("./policies/PlanLimitsPolicity.js");
const { storeUpgradeRequestSchema, listUpgradeRequestsSchema, updateUpgradeRequestSchema, idUpgradeRequestSchema } = require("./middlewares/validations/upgradeRequestValidation.js");
const UpgradeRequestController = require("./controllers/UpgradeRequestController.js");
const { listBillingOrdersSchema, storeBillingOrderSchema, updateBillingOrderSchema, idBillingOrderSchema } = require("./middlewares/validations/billingOrderValidation.js");
const BillingOrderController = require("./controllers/BillingOrderController.js");
const { listNotificationsSchema, idNotificationSchema, markAsReadSchema } = require("./middlewares/validations/notificationValidation.js");
const NotificationController = require("./controllers/NotificationController.js");
const multerDisk = require("./middlewares/multerDisk.js");
const { UPLOAD_BASE_PATH } = require("../config/upload.js");
const { getMimeTypeFromExtension } = require("./util/fileUtils.js");
const { companyPreferenceSchema } = require("./middlewares/validations/companyPreferenceValidation.js");
const CompanyPreferenceController = require("./controllers/CompanyPreferenceController.js");
const { siiConfigSchema } = require("./middlewares/validations/siiConfigurationValidation.js");
const SiiConfigurationController = require("./controllers/SiiConfigurationController.js");
const { siiCertificateSchema } = require("./middlewares/validations/siiCertificateValidation.js");
const SiiCertificateController = require("./controllers/SiiCertificateController.js");
const Joi = require("joi");
const FeatureFlagController = require("./controllers/FeatureFlagController.js");
const SiiCafController = require("./controllers/SiiCafController.js");
const DteDocumentController = require("./controllers/DteDocumentController.js");
const { createCafSchema, updateCafSchema, listCafsSchema } = require("./middlewares/validations/siiCafValidation.js");
const cafXmlUpload = require("./middlewares/siiCafUpload.js");
const { createDteSchema, checkStatusSchema } = require("./middlewares/validations/dteDocumentValidation.js");
const JobController = require("./controllers/JobController.js");
const router = express.Router();


router.get("/", (req, res) => res.json({ hello: "World" }));

router.post("/user-register", validateSchema(registerSchema), AuthController.register);
router.post("/sign-in", validateSchema(loginSchema), AuthController.signIn);
router.get("/verific-invitation", AuthController.verifyInvitation);
router.post('/forgot-password', AuthController.forgotPassword);
router.post('/verify-code-password', AuthController.verifyCode);
router.post('/reset-password', AuthController.resetPassword);
router.get('/validate-requests/:id/approve', UserCompanyController.handleMembershipRequest);
router.get('/validate-requests/:id/reject', UserCompanyController.handleMembershipRequest);

router.post('/ml-callback', OAuthController.mercadoLibreCallback);
router.get("/images/:foldername/:filename", (req, res) => {
  const { foldername, filename } = req.params;
  const safeFoldername = path.basename(foldername); // prevención de path traversal
  const safeFile = path.basename(filename);
  const imagePath = path.join(UPLOAD_BASE_PATH, safeFoldername, safeFile);

  if (!fs.existsSync(imagePath)) {
    return res.status(404).send("Imagen no encontrada");
  }

  const contentType = getMimeTypeFromExtension(safeFile);

  fs.readFile(imagePath, (err, file) => {
    if (err) {
      return res.status(500).send("Error al leer la imagen");
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(file);
  });
});
//rutas protegidas
router.use(auth);

router.get("/images-protect/:foldername/:filename", (req, res) => {
  const { foldername, filename } = req.params;
  const safeFoldername = path.basename(foldername);
  const safeFile = path.basename(filename);
  const imagePath = path.join(UPLOAD_BASE_PATH, safeFoldername, safeFile);

  if (!fs.existsSync(imagePath)) {
    return res.status(404).send("Imagen no encontrada");
  }

 const contentType = getMimeTypeFromExtension(safeFile);

  fs.readFile(imagePath, (err, file) => {
    if (err) {
      return res.status(500).send("Error al leer la imagen");
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(file);
  });
});

router.get("/logout", AuthController.logout);
router.post('/user-create', requireRoles(['Admin', 'Seller Manager']), multerImage("image", "users"), validateSchema(createUserSchema), AuthController.associateUserToCompany);
router.post("/user-update", requireRoles(['Admin', 'Seller Manager']), multerImage("image", "users"), validateSchema(updateUserSchema), AuthController.updateUserInCompany);
router.post("/user-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateBranchSchema), AuthController.destroy);
router.post("/get-users", requireRoles(['Admin', 'Seller Manager']), AuthController.index);
router.post("/get-pool-warehouse-roles", requireRoles(['Admin', 'Seller Manager']), AuthController.getPoolWarehouseRole);
router.post("/send-invitation", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateSchema), InvitationController.sendInvitation);
router.post('/change-password', AuthController.changePassword);

//Rutas Roles
router.get("/roles", requireRoles(['Admin', 'Seller Manager']),RoleController.index);
router.post("/role", requireRoles(['Admin', 'Seller Manager']), validateSchema(roleSchema), RoleController.store);
router.post("/role-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateRoleSchema), RoleController.update);
router.post("/role-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idRoleSchema), RoleController.destroy);

// PLANES
router.post("/plans", requireRoles(['Admin', 'Seller Manager']), PlanController.index);
router.post("/plan", requireRoles(['Admin', 'Seller Manager']), validateSchema(planSchema), PlanController.store);
router.post("/plan-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updatePlanSchema), PlanController.update);
router.post("/plan-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idPlanSchema), PlanController.destroy);

// PERMISOS
router.get("/permissions", requireRoles(['Admin', 'Seller Manager']), PermissionController.index);
router.post("/permission", requireRoles(['Admin', 'Seller Manager']), validateSchema(permissionSchema), PermissionController.store);
router.post("/permission-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updatePermissionSchema), PermissionController.update);
router.post("/permission-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idPermissionSchema), PermissionController.destroy);

// Role Permissions
router.post('/role-permissions', requireRoles(['Admin', 'Seller Manager']), validateSchema(roleIdSchema), RolePermissionController.index);
router.post('/role-permission', requireRoles(['Admin', 'Seller Manager']), validateSchema(assignPermissionToRoleSchema), RolePermissionController.assign);
router.post('/role-permission-bulk', requireRoles(['Admin', 'Seller Manager']), validateSchema(assignMultiplePermissionsToRoleSchema), RolePermissionController.assignMultiple);
router.post('/role-permission-update', requireRoles(['Admin', 'Seller Manager']), validateSchema(updateRolePermissionSchema), RolePermissionController.updateStatus);
router.post('/role-permission-destroy', requireRoles(['Admin', 'Seller Manager']), validateSchema(idRolePermissionSchema), RolePermissionController.destroy);
router.post('/role-permissions-available', requireRoles(['Admin', 'Seller Manager']), validateSchema(availablePermissionsForRoleSchema), RolePermissionController.available);

// Endpoints BusinessTypes
router.post("/business-types", BusinessTypeController.index);
router.post("/business-type", requireRoles(['Admin', 'Seller Manager']), validateSchema(businessTypeSchema), BusinessTypeController.store);
router.post("/business-type-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateBusinessTypeSchema), BusinessTypeController.update);
router.post("/business-type-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idBusinessTypeSchema), BusinessTypeController.destroy);

//Rutas de Companies
router.post("/companies", CompanyController.index);
router.post("/company-by-user", requireRoles(['Admin', 'Seller Manager']), validateSchema(byUserIdSchema), CompanyController.getCompaniesByUser);
router.post("/company", requireRoles(['Admin', 'Seller Manager']), multerImage("image", "companies"), validateSchema(storeCompanySchema), CompanyController.store);
router.post("/company-update", requireRoles(['Admin', 'Seller Manager']), multerImage("image", "companies"), validateSchema(updateCompanySchema), CompanyController.update);
router.post("/company-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idCompanySchema), CompanyController.destroy);
router.post('/company-users', requireRoles(['Admin', 'Seller Manager']), validateSchema(companyIdSchema), AuthController.getUsers);
router.post("/company-login", validateSchema(storeCompanySchema), CompanyController.storeLogin);
router.post("/joint-invitation-token", CompanyController.joinInvitation);

//UserCompany
router.post('/user-company', requireRoles(['Admin', 'Seller Manager']), validateSchema(createUserCompanySchema), UserCompanyController.create);
router.post('/user-company-status', requireRoles(['Admin', 'Seller Manager']), validateSchema(updateUserCompanyStatusSchema), UserCompanyController.updateStatus);
router.post('/user-company-role', requireRoles(['Admin', 'Seller Manager']), validateSchema(updateUserCompanyRoleSchema), UserCompanyController.updateRole);
router.post('/user-company-destroy', requireRoles(['Admin', 'Seller Manager']), validateSchema(userCompanyIdSchema), UserCompanyController.destroy);
router.post('/user-company-find', requireRoles(['Admin', 'Seller Manager']), validateSchema(userCompanyByUserAndCompanySchema), UserCompanyController.findByUserAndCompany);
router.post('/user-company-token', validateSchema(userCompanyByTokenSchema), UserCompanyController.findByToken); // Sin requireRoles: aceptación pública de invitación
router.post('/user-company-list', requireRoles(['Admin', 'Seller Manager']), validateSchema(listUserCompanySchema), UserCompanyController.list);
router.post('/available-for-request', UserCompanyController.listAvailableCompanies);
router.post('/membership-requests', validateSchema(createMembershipRequestSchema), UserCompanyController.createMembershipRequest);

//UserAclScope
router.post('/user-acl-scope', requireRoles(['Admin', 'Seller Manager']), validateSchema(createUserAclScopeSchema), UserAclScopeController.create);
router.post('/user-acl-scope-destroy', requireRoles(['Admin', 'Seller Manager']), validateSchema(userAclScopeIdSchema), UserAclScopeController.destroy);
router.post('/user-acl-scopes', requireRoles(['Admin', 'Seller Manager']), validateSchema(userAclScopesByUserAndCompanySchema), UserAclScopeController.listByUserAndCompany);
router.post('/user-acl-scopes-clear', requireRoles(['Admin', 'Seller Manager']), validateSchema(userAclScopesByUserAndCompanySchema), UserAclScopeController.clearByUserAndCompany);

//Rutas de Sucursales
router.post("/branch-user-company", requireRoles(['Admin', 'Seller Manager']), validateSchema(listBranchesSchema), BranchController.list);
router.post("/branch", requireRoles(['Admin', 'Seller Manager']), checkPlanLimit('branch'), multerImage("image", "branches"), validateSchema(storeBranchSchema), BranchController.store);
router.post("/branch-update", requireRoles(['Admin', 'Seller Manager']), multerImage("image", "branches"), validateSchema(updateBranchSchema), BranchController.update);
router.post("/branch-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idBranchSchema), BranchController.destroy);

//Rutas de Almacénes
router.post("/warehouse-branch-company", requireRoles(['Admin', 'Seller Manager']), validateSchema(listWarehouseSchema), WarehouseController.list);
router.post("/warehouse", requireRoles(['Admin', 'Seller Manager']), checkPlanLimit('warehouse'), multerImage("image", "warehouses"), validateSchema(storeWarehouseSchema), WarehouseController.store);
router.post("/warehouse-update", requireRoles(['Admin', 'Seller Manager']), multerImage("image", "warehouses"), validateSchema(updateWarehouseSchema), WarehouseController.update);
router.post("/warehouse-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idWarehouseSchema), WarehouseController.destroy);
router.post("/warehouse-metadata", requireRoles(['Admin', 'Seller Manager']), WarehouseController.getWarehouseMetadata);

//Rutas de categoria de productos
router.get("/product-category", requireRoles(['Admin', 'Seller Manager']), ProductCategoryController.index);
router.post("/product-category", requireRoles(['Admin', 'Seller Manager']), validateSchema(productCategorySchema), ProductCategoryController.store);
router.post("/product-category-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateProductCategorySchema), ProductCategoryController.update);
router.post("/product-category-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idProductCategorySchema), ProductCategoryController.destroy);

// Rutas de atributos de productos
router.post("/attributes", requireRoles(['Admin', 'Seller Manager']), AttributeController.index);
router.post("/attribute", requireRoles(['Admin', 'Seller Manager']), validateSchema(attributeSchema), AttributeController.store);
router.post("/attribute-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateAttributeSchema), AttributeController.update);
router.post("/attribute-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idAttributeSchema), AttributeController.destroy);

const productImageFields = {
  images: {
    folder: 'products',
    multiple: true,
    maxCount: 10  // o el límite que desees
  }
};

// Rutas de Productos
router.post("/product-user-company", requireRoles(['Admin', 'Seller Manager']), validateSchema(listProductsSchema), ProductController.list);
router.post("/product", requireRoles(['Admin', 'Seller Manager']), multerFieldFolders(productImageFields), validateSchema(storeProductSchema), ProductController.store);
router.post("/product-update", requireRoles(['Admin', 'Seller Manager']), multerFieldFolders(productImageFields), validateSchema(updateProductSchema), ProductController.update);
router.post("/product-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idProductSchema), ProductController.destroy);
router.post("/product-state", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateProductSchema), ProductController.updateState);
router.post("/products-transform", requireRoles(['Admin', 'Seller Manager']), ProductController.transformForMarketplace);
router.post("/product-category-status", requireRoles(['Admin', 'Seller Manager']), ProductController.getProductMetadata);
router.post("/product-update-attributes", ProductController.updateAttributes);
router.post('/product-assign-warehouse', requireRoles(['Admin', 'Seller Manager']), validateSchema(assignWarehouseSchema), ProductController.assignWarehouse);

//Product Varinants
router.post("/variant-create", ProductVariantController.create);
router.post("/product-variant-update", requireRoles(['Admin', 'Seller Manager']), ProductVariantController.update);
router.post("/variant-delete", requireRoles(['Admin', 'Seller Manager']), ProductVariantController.delete);

// Mismo patrón que branches y products
router.post("/warehouse-product-user-company", requireRoles(['Admin', 'Seller Manager']), validateSchema(listWarehouseProductSchema), WarehouseProductController.list);
router.post('/warehouse-products-not-in-warehouse', requireRoles(['Admin', 'Seller Manager']), validateSchema(listWarehouseProductSchema), WarehouseProductController.getProductsNotInWarehouse);
router.post("/warehouse-product", requireRoles(['Admin', 'Seller Manager']), validateSchema(storeWarehouseProductSchema), WarehouseProductController.store);
router.post("/warehouse-product-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateWarehouseProductSchema), WarehouseProductController.update);
router.post("/warehouse-product-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idWarehouseProductSchema), WarehouseProductController.destroy);
router.post("/warehouse-movement-stock", requireRoles(['Admin', 'Seller Manager']), validateSchema(transferSchema), WarehouseProductController.createMovement );
router.post("/warehouse-bulk-movement", requireRoles(['Admin', 'Seller Manager']), validateSchema(bulkTransferSchema), WarehouseProductController.createBulkMovement );
router.post("/warehouse-products-by-ids", requireRoles(['Admin', 'Seller Manager']), validateSchema(listByWarehouseIdsSchema), WarehouseProductController.listByWarehouseIds);

//Inventario de movimientos
router.post("/movements", requireRoles(['Admin', 'Seller Manager']), validateSchema(getMovementsSchema), InventoryMovementController.getMovements);
router.post("/inventory-products", requireRoles(['Admin', 'Seller Manager']), validateSchema(getMovementsSchema), InventoryMovementController.list);
//router.post("/warehouse-product-bulk-confirm", requireRoles(['Admin', 'Seller Manager']), WarehouseProductController.bulkUploadConfirm);

// Marketplaces
router.post("/marketplace", requireRoles(['Admin', 'Seller Manager']), validateSchema(storeMarketplaceSchema), MarketplaceController.store);
router.post("/marketplace-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateMarketplaceSchema), MarketplaceController.update);
router.post("/marketplace-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idMarketplaceSchema), MarketplaceController.destroy);
router.post("/marketplace-show", requireRoles(['Admin', 'Seller Manager']), validateSchema(idMarketplaceSchema), MarketplaceController.show);
router.post("/marketplace-list", requireRoles(['Admin', 'Seller Manager']), MarketplaceController.list); // list no necesita schema (validación manual de company_id)
router.post('/mercado-libre-suggested-categories', OAuthController.mercadoLibreSuggestedCategoriesWithAttributes);
router.post("/mercado-libre-category", OAuthController.mercadoLibreCategory);
router.post("/mercado-libre-attributes", OAuthController.mercadoLibreAttributes);
router.post("/falabella-suggested-categories", OAuthController.falabellaSuggestedCategoriesWithAttributes);
router.post("/falabella-categories", OAuthController.falabellaCategories);
router.post("/falabella-category-attributes", OAuthController.falabellaAttributes);
router.post("/falabella-product-status", OAuthController.falabellaProductStatus);
router.post("/falabella-feed-status", OAuthController.falabellaFeedStatus);

//Marketplace Credentiales
//router.post('/marketplace-credentials-by-context', validateSchema(findByMarketplaceCredentialSchema), MarketplaceCredentialController.index);
router.post("/marketplace-credential", requireRoles(['Admin', 'Seller Manager']), checkPlanLimit('marketplaces'), validateSchema(storeMarketplaceCredentialSchema), MarketplaceCredentialController.store);
router.post("/marketplace-credential-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateMarketplaceCredentialSchema), MarketplaceCredentialController.update);
router.post("/marketplace-credential-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idMarketplaceCredentialSchema), MarketplaceCredentialController.destroy);
router.post('/marketplace-credentials-by-user', MarketplaceCredentialController.getByUser);
router.post('/marketplace-refresh-token', validateSchema(idMarketplaceCredentialSchema), MarketplaceCredentialController.refreshToken);

// Metadatos de los marketplaces
router.post("/product-field-mapping", requireRoles(['Admin', 'Seller Manager']), validateSchema(createProductFieldMappingSchema), ProductFieldMappingController.store);
router.post("/product-field-mapping-bulk", requireRoles(['Admin', 'Seller Manager']), validateSchema(bulkCreateProductFieldMappingSchema), ProductFieldMappingController.storeBulk);
router.post("/product-field-mapping-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateProductFieldMappingSchema), ProductFieldMappingController.update);
router.post("/product-field-mapping-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idProductFieldMappingSchema), ProductFieldMappingController.destroy);
router.post("/product-field-mapping-show", requireRoles(['Admin', 'Seller Manager']), validateSchema(idProductFieldMappingSchema), ProductFieldMappingController.show);
router.post("/product-field-mapping-list", requireRoles(['Admin', 'Seller Manager']), validateSchema(listProductFieldMappingSchema), ProductFieldMappingController.list);

//rutas de pools
router.post("/pool-list", requireRoles(['Admin', 'Seller Manager']), validateSchema(listPoolsSchema), PoolController.list);
router.post("/pool", requireRoles(['Admin', 'Seller Manager']), checkPlanLimit('pools'), validateSchema(storePoolSchema), PoolController.store);
router.post("/pool-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updatePoolSchema), PoolController.update);
router.post("/pool-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idPoolSchema), PoolController.destroy);
//Rutas de publicaciones de productos
router.post("/marketplaces-pools", requireRoles(['Admin', 'Seller Manager']), validateSchema(listProductPublishingTaskSchema), ProductPublishingTaskController.warehouseMarketplaces);
router.post("/publishing-task", requireRoles(['Admin', 'Seller Manager']), validateSchema(storeProductPublishingTaskSchema), ProductPublishingTaskController.store);
router.post("/publishing-task-update-status", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateProductPublishingTaskStatusSchema), ProductPublishingTaskController.updateStatus);
router.post("/publishing-task-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateProductPublishingTaskStatusSchema), ProductPublishingTaskController.updatePayload);
router.post("/publishing-tasks-list", requireRoles(['Admin', 'Seller Manager']), validateSchema(listProductPublishingTaskSchema), ProductPublishingTaskController.list);
router.post("/publishing-task-retry", requireRoles(['Admin', 'Seller Manager']), validateSchema(retryProductPublishingTaskSchema), ProductPublishingTaskController.retryBatch);
router.post("/publishing-draft", requireRoles(['Admin', 'Seller Manager']), validateSchema(publishDraftSchema), ProductPublishingTaskController.publishDraft);
router.post("/publishing-task-delete", requireRoles(['Admin', 'Seller Manager']), validateSchema(idCompanySchema), ProductPublishingTaskController.destroy);

// Notificaciones
router.post("/get-user-notifications", requireRoles(['Admin', 'Seller Manager', 'Editor', 'Viewer']), validateSchema(listNotificationsSchema), NotificationController.getUserNotifications);
router.post("/notification-mark-as-read", requireRoles(['Admin', 'Seller Manager', 'Editor', 'Viewer']), validateSchema(markAsReadSchema), NotificationController.markAsRead);
router.post("/notification-destroy", requireRoles(['Admin', 'Seller Manager', 'Editor', 'Viewer']), validateSchema(idNotificationSchema), NotificationController.destroy);
router.get('/unread-count', requireRoles(['Admin', 'Seller Manager', 'Editor', 'Viewer']), NotificationController.getUnreadCount); 
//Subcripciones
router.post("/subscriptions", requireRoles(['Admin', 'Seller Manager']), validateSchema(listSubscriptionsSchema), SubscriptionController.index);
router.post("/subscription", requireRoles(['Admin', 'Seller Manager']), validateSchema(storeSubscriptionSchema), SubscriptionController.store);
router.post("/subscription-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateSubscriptionSchema), SubscriptionController.update);
router.post("/subscription-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idSubscriptionSchema), SubscriptionController.destroy);

//updaterequest
router.post("/upgrade-requests", requireRoles(['Admin', 'Seller Manager']), validateSchema(listUpgradeRequestsSchema), UpgradeRequestController.index);
router.post("/upgrade-request", validateSchema(storeUpgradeRequestSchema), UpgradeRequestController.store);

// upgrade-request
router.post("/upgrade-request-update", requireRoles(['Admin', 'Seller Manager']), validateSchema(updateUpgradeRequestSchema), UpgradeRequestController.update);
router.post("/upgrade-request-destroy", requireRoles(['Admin', 'Seller Manager']), validateSchema(idUpgradeRequestSchema), UpgradeRequestController.destroy);

//billing-orders
router.post("/billing-orders", requireRoles(['Admin']), validateSchema(listBillingOrdersSchema), BillingOrderController.index);
router.post("/billing-order", requireRoles(['Admin']), multerDisk({ proof_url: 'billingorders' }), validateSchema(storeBillingOrderSchema), BillingOrderController.store);
router.post("/billing-order-update", requireRoles(['Admin']), validateSchema(updateBillingOrderSchema), BillingOrderController.update);
router.post("/billing-order-status", requireRoles(['Admin']), validateSchema(updateBillingOrderSchema),  BillingOrderController.updateStatus );
router.post("/billing-order-destroy", requireRoles(['Admin']), validateSchema(idBillingOrderSchema), BillingOrderController.destroy);

//Ruta de configuraciones
router.post("/preferences", requireRoles(['Admin']), validateSchema(companyPreferenceSchema), CompanyPreferenceController.store);
router.post("/preferences-show", requireRoles(['Admin']), validateSchema(Joi.object({ company_id: Joi.number().required() })), CompanyPreferenceController.show);

//Rutas Sii-configurations
router.post('/configurations', requireRoles(['Admin', 'Seller Manager']), SiiConfigurationController.show);
router.post('/configuration', SiiConfigurationController.store);
router.post('/configuration-connect', SiiConfigurationController.connect);
router.post('/configuration-disconnect', SiiConfigurationController.disconnect);
//router.post("/sii-config", requireRoles(['Admin']), validateSchema(siiConfigSchema), SiiConfigurationController.store);
//router.post("/sii-config-show", requireRoles(['Admin']), validateSchema(Joi.object({ company_id: Joi.number().required() })), SiiConfigurationController.show);
//router.post("/sii-connect", requireRoles(['Admin']), validateSchema(Joi.object({ company_id: Joi.number().required() })), SiiConfigurationController.connect);
//router.post("/sii-disconnect", requireRoles(['Admin']), validateSchema(Joi.object({ company_id: Joi.number().required() })), SiiConfigurationController.disconnect);

// Certificados

const certificatePpath = {
  certificate_path: {
    folder: 'certificates', multiple: false}
};
router.post('/sii-certificates-list', requireRoles(['Admin', 'Seller Manager']), validateSchema(idCompanySchema), SiiCertificateController.list);
router.post('/certificate-upload', requireRoles(['Admin', 'Seller Manager']), multerFieldFolders(certificatePpath), validateSchema(siiCertificateSchema), SiiCertificateController.createOrUpdate);
router.get('/certificates', SiiCertificateController.show);
router.post('/certificate-destroy', requireRoles(['Admin', 'Seller Manager']), validateSchema(idRoleSchema), SiiCertificateController.destroy);
// Feature flags (solo lectura)
router.post("/feature-flags", requireRoles(['Admin', 'User']), validateSchema(Joi.object({ company_id: Joi.number().required() })), FeatureFlagController.index);
//Rutas de los logs
router.post("/get-logs", requireRoles(['Admin', 'Seller Manager']), LogController.getLogs);

// CAF
const cafXml = {
  caf_xml: {
    folder: 'cafs', multiple: false}
};
router.post('/sii-cafs-list', requireRoles(['Admin', 'Seller Manager']), validateSchema(listCafsSchema), SiiCafController.list);
router.post('/caf-store', requireRoles(['Admin', 'Seller Manager']), cafXmlUpload, validateSchema(createCafSchema), SiiCafController.create);
router.post('/caf-update', requireRoles(['Admin', 'Seller Manager']), cafXmlUpload, validateSchema(updateCafSchema), SiiCafController.update);
router.post('/caf-destroy', requireRoles(['Admin', 'Seller Manager']), validateSchema(idRoleSchema), SiiCafController.destroy);

// Documentos DTE
/*router.post('/documents-issue', DteDocumentController.issue);
router.get('/documents', DteDocumentController.index);
router.post('/documents-show', DteDocumentController.show);
router.post('/document-check-status', DteDocumentController.checkStatus);*/

router.post('/dte-document', requireRoles(['Admin', 'Seller Manager']), validateSchema(createDteSchema), DteDocumentController.create );
router.post('/dte-document-issue', requireRoles(['Admin', 'Seller Manager']), validateSchema(createDteSchema), DteDocumentController.issue );
router.post('/dte-documents-list', requireRoles(['Admin', 'Seller Manager']), validateSchema(idCompanySchema), DteDocumentController.index );
/*router.post(
  '/dte-documents/show', 
  requireRoles(['Admin', 'Seller Manager']),
  validateSchema({ company_id: Joi.number().integer().positive().required(), document_id: Joi.number().integer().positive().required() }),
  DteDocumentController.show
);*/

// Actualizar documento DTE
router.post('/dte-document-update', requireRoles(['Admin', 'Seller Manager']), validateSchema(createDteSchema), DteDocumentController.update );
router.post('/dte-document-delete', requireRoles(['Admin', 'Seller Manager']), validateSchema(checkStatusSchema), DteDocumentController.destroy );
router.post('/dte-document-status', requireRoles(['Admin', 'Seller Manager']), validateSchema(checkStatusSchema), DteDocumentController.checkStatus );


//JobController y JobProductController
router.post('/job-progress', requireRoles(['Admin', 'Seller Manager']), JobController.getJobProgress);
router.post('/jobs-actives', requireRoles(['Admin', 'Seller Manager']), JobController.getActiveJobs);
router.post('/jobs-finished-list', requireRoles(['Admin', 'Seller Manager']), JobController.listFinishedJobs);
router.post('/jobs-detail', requireRoles(['Admin', 'Seller Manager']), JobController.getJobDetail);

module.exports = router;