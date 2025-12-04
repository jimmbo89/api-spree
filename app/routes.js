const express = require("express");
const logger = require('../config/logger');
const fs = require("fs");
const path = require("path");
const mime = require("mime-types"); 
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
const ProductCategoryController = require("./controllers/ProductCategoryController.js");
const { productCategorySchema, updateProductCategorySchema, idProductCategorySchema } = require("./middlewares/validations/productCategoryValidations.js");
const { listProductsSchema, storeProductSchema, updateProductSchema, idProductSchema } = require("./middlewares/validations/productValidations.js");
const ProductController = require("./controllers/ProductController.js");
const { listWarehouseProductSchema, storeWarehouseProductSchema, updateWarehouseProductSchema, idWarehouseProductSchema, transferSchema, bulkUploadSchema } = require("./middlewares/validations/warehouseProductValidations.js");
const WarehouseProductController = require("./controllers/WarehouseProductController.js");
const multerImage = require("./middlewares/multerImage.js");
const multerGeneric = require("./middlewares/multerGeneric.js");
const multerFieldFolders = require("./middlewares/multerFieldFolders.js");
const { storeMarketplaceSchema, updateMarketplaceSchema, idMarketplaceSchema } = require("./middlewares/validations/marketplaceValidations.js");
const MarketplaceController = require("./controllers/MarketplaceController.js");
const { createProductFieldMappingSchema, updateProductFieldMappingSchema, idProductFieldMappingSchema, listProductFieldMappingSchema, bulkCreateProductFieldMappingSchema } = require("./middlewares/validations/productFieldMappingValidations.js");
const ProductFieldMappingController = require("./controllers/ProductFieldMappingController.js");
const { storeProductPublishingTaskSchema, updateProductPublishingTaskStatusSchema, listProductPublishingTaskSchema, retryProductPublishingTaskSchema } = require("./middlewares/validations/productPublishingTaskValidations.js");
const ProductPublishingTaskController = require("./controllers/ProductPublishingTaskController.js");
const { storeMarketplaceCredentialSchema, findByMarketplaceCredentialSchema, updateMarketplaceCredentialSchema } = require("./middlewares/validations/marketplaceCredentialValidations.js");
const MarketplaceCredentialController = require("./controllers/MarketplaceCredentialController.js");
const OAuthController = require("./controllers/OAuthController.js");
const router = express.Router();


router.get("/", (req, res) => res.json({ hello: "World" }));

router.post("/sign-up", validateSchema(registerSchema), AuthController.signUp);
router.post("/sign-in", validateSchema(loginSchema), AuthController.signIn);
router.get("/verific-invitation", InvitationController.verificInvitation);

router.get('/ml-callback', OAuthController.mercadoLibreCallback);
router.get("/images/:foldername/:filename", (req, res) => {
  const { foldername, filename } = req.params;
  const imagePath = path.join(__dirname, "../public", foldername, filename);

  // Verifica si el archivo existe
  if (!fs.existsSync(imagePath)) {
    return res.status(400).send("Imagen no encontrada");
  }

  // Obtén el tipo MIME del archivo
  const fileType = mime.lookup(imagePath) || "application/octet-stream";

  // Lee el archivo y envíalo en la respuesta
  fs.readFile(imagePath, (err, file) => {
    if (err) {
      return res.status(500).send("Error al leer la imagen");
    }
    res.writeHead(200, { "Content-Type": fileType });
    res.end(file);
  });
});
//rutas protegidas
router.use(auth);

router.get("/images-protect/:foldername/:filename", (req, res) => {
  const { foldername, filename } = req.params;
  const imagePath = path.join(__dirname, "../public", foldername, filename);

  // Verifica si el archivo existe
  if (!fs.existsSync(imagePath)) {
    return res.status(400).send("Imagen no encontrada");
  }

  // Obtén el tipo MIME del archivo
  const fileType = mime.lookup(imagePath) || "application/octet-stream";

  // Lee el archivo y envíalo en la respuesta
  fs.readFile(imagePath, (err, file) => {
    if (err) {
      return res.status(500).send("Error al leer la imagen");
    }
    res.writeHead(200, { "Content-Type": fileType });
    res.end(file);
  });
});

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
router.post("/company", requireRoles(['Admin']), multerImage("image", "companies"), validateSchema(storeCompanySchema), CompanyController.store);
router.post("/company-update", requireRoles(['Admin']), multerImage("image", "companies"), validateSchema(updateCompanySchema), CompanyController.update);
router.post("/company-destroy", requireRoles(['Admin']), validateSchema(idCompanySchema), CompanyController.destroy);

//Rutas de Sucursales
router.post("/branch-user-company", requireRoles(['Admin']), validateSchema(listBranchesSchema), BranchController.list);
router.post("/branch", requireRoles(['Admin']), multerImage("image", "branches"), validateSchema(storeBranchSchema), BranchController.store);
router.post("/branch-update", requireRoles(['Admin']), multerImage("image", "branches"), validateSchema(updateBranchSchema), BranchController.update);
router.post("/branch-destroy", requireRoles(['Admin']), validateSchema(idBranchSchema), BranchController.destroy);

//Rutas de Almacénes
router.post("/warehouse-branch-company", requireRoles(['Admin']), validateSchema(listWarehouseSchema), WarehouseController.list);
router.post("/warehouse", requireRoles(['Admin']), multerImage("image", "warehouses"), validateSchema(storeWarehouseSchema), WarehouseController.store);
router.post("/warehouse-update", requireRoles(['Admin']), multerImage("image", "warehouses"), validateSchema(updateWarehouseSchema), WarehouseController.update);
router.post("/warehouse-destroy", requireRoles(['Admin']), validateSchema(idWarehouseSchema), WarehouseController.destroy);

//Rutas de categoria de productos
router.get("/product-category", requireRoles(['Admin']), ProductCategoryController.index);
router.post("/product-category", requireRoles(['Admin']), validateSchema(productCategorySchema), ProductCategoryController.store);
router.post("/product-category-update", requireRoles(['Admin']), validateSchema(updateProductCategorySchema), ProductCategoryController.update);
router.post("/product-category-destroy", requireRoles(['Admin']), validateSchema(idProductCategorySchema), ProductCategoryController.destroy);


const productImageFields = {
  images: {
    folder: 'products',
    multiple: true,
    maxCount: 10  // o el límite que desees
  }
};

// Rutas de Productos
router.post("/product-user-company", requireRoles(['Admin']), validateSchema(listProductsSchema), ProductController.list);
router.post("/product", requireRoles(['Admin']), multerFieldFolders(productImageFields), validateSchema(storeProductSchema), ProductController.store);
router.post("/product-update", requireRoles(['Admin']), multerFieldFolders(productImageFields), validateSchema(updateProductSchema), ProductController.update);
router.post("/product-destroy", requireRoles(['Admin']), validateSchema(idProductSchema), ProductController.destroy);
router.post("/products-transform", requireRoles(['Admin']), ProductController.transformForMarketplace);

// Mismo patrón que branches y products
router.post("/warehouse-product-user-company", requireRoles(['Admin']), validateSchema(listWarehouseProductSchema), WarehouseProductController.list);
router.post("/warehouse-product", requireRoles(['Admin']), multerImage("image", "warehouse_products"), validateSchema(storeWarehouseProductSchema), WarehouseProductController.store);
router.post("/warehouse-product-update", requireRoles(['Admin']), multerImage("image", "warehouse_products"), validateSchema(updateWarehouseProductSchema), WarehouseProductController.update);
router.post("/warehouse-product-destroy", requireRoles(['Admin']), validateSchema(idWarehouseProductSchema), WarehouseProductController.destroy);
router.post("/warehouse-product-transfer", requireRoles(['Admin']), validateSchema(transferSchema), WarehouseProductController.transfer );
router.post("/warehouse-product-bulk-preview", requireRoles(['Admin']), multerGeneric('file'), validateSchema(bulkUploadSchema), WarehouseProductController.bulkUploadPreview);
router.post("/warehouse-product-bulk-confirm", requireRoles(['Admin']), WarehouseProductController.bulkUploadConfirm);

// Marketplaces
router.post("/marketplace", requireRoles(['Admin']), validateSchema(storeMarketplaceSchema), MarketplaceController.store);
router.post("/marketplace-update", requireRoles(['Admin']), validateSchema(updateMarketplaceSchema), MarketplaceController.update);
router.post("/marketplace-destroy", requireRoles(['Admin']), validateSchema(idMarketplaceSchema), MarketplaceController.destroy);
router.post("/marketplace-show", requireRoles(['Admin']), validateSchema(idMarketplaceSchema), MarketplaceController.show);
router.post("/marketplace-list", requireRoles(['Admin']), MarketplaceController.list); // list no necesita schema (validación manual de company_id)

//Marketplace Credentiales
router.post("/marketplace-credential", requireRoles(['Admin']), validateSchema(storeMarketplaceCredentialSchema), MarketplaceCredentialController.store);
router.post("/marketplace-credential-update", requireRoles(['Admin']), validateSchema(updateMarketplaceCredentialSchema), MarketplaceCredentialController.update);
router.post("/marketplace-credential-show", requireRoles(['Admin']), validateSchema(findByMarketplaceCredentialSchema), MarketplaceCredentialController.show);

// Metadatos de los marketplaces
router.post("/product-field-mapping", requireRoles(['Admin']), validateSchema(createProductFieldMappingSchema), ProductFieldMappingController.store);
router.post("/product-field-mapping-bulk", requireRoles(['Admin']), validateSchema(bulkCreateProductFieldMappingSchema), ProductFieldMappingController.storeBulk);
router.post("/product-field-mapping-update", requireRoles(['Admin']), validateSchema(updateProductFieldMappingSchema), ProductFieldMappingController.update);
router.post("/product-field-mapping-destroy", requireRoles(['Admin']), validateSchema(idProductFieldMappingSchema), ProductFieldMappingController.destroy);
router.post("/product-field-mapping-show", requireRoles(['Admin']), validateSchema(idProductFieldMappingSchema), ProductFieldMappingController.show);
router.post("/product-field-mapping-list", requireRoles(['Admin']), validateSchema(listProductFieldMappingSchema), ProductFieldMappingController.list);

//Rutas de publicaciones de productos
router.post("/publishing-task", requireRoles(['Admin']), validateSchema(storeProductPublishingTaskSchema), ProductPublishingTaskController.store);
router.post("/publishing-task-update-status", requireRoles(['Admin']), validateSchema(updateProductPublishingTaskStatusSchema), ProductPublishingTaskController.updateStatus);
router.post("/publishing-task-list", requireRoles(['Admin']), validateSchema(listProductPublishingTaskSchema), ProductPublishingTaskController.list);
router.post("/publishing-task-retry", requireRoles(['Admin']), validateSchema(retryProductPublishingTaskSchema), ProductPublishingTaskController.retry);

//Rutas de los logs
router.post("/get-logs", requireRoles(['Admin']), LogController.getLogs);
module.exports = router;