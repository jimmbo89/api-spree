const BranchRepository = require("./BranchRepository");
const BusinessTypeRepository = require("./BusinessTypeRepository");
const CompanyRepository = require("./CompanyRepository");
const InventoryMovementRepository = require("./InventoryMovementRepository");
const InvitationRepository = require("./InvitationRepository");
const LogRepository = require("./LogRepository");
const MarketplaceCredentialRepository = require("./MarketplaceCredentialRepository");
const MarketplaceRepository = require("./MarketplaceRepository");
const PoolRepository = require("./PoolRepository");
const PoolWarehouseRepository = require("./PoolWarehouseRepository");
const ProductCategoryRepository = require("./ProductCategoryRepository");
const ProductFieldMappingRepository = require("./ProductFieldMappingRepository");
const ProductMarketplaceLinkRepository = require("./ProductMarketplaceLinkRepository");
const ProductPublishingTaskRepository = require("./ProductPublishingTaskRepository");
const ProductRepository = require("./ProductRepository");
const ProductVariantRepository = require("./ProductVariantRepository");
const RoleRepository = require("./RoleRepository");
const UserRepository = require("./UserRepository");
const UserTokenRepository = require("./UserTokenRepository");
const WarehouseProductRepository = require("./WarehouseProductRepository");
const WarehouseProductVariantRepository = require("./WarehouseProductVariantRepository");
const WarehouseRepository = require("./WarehouseRepository");

module.exports = {
    RoleRepository,
    UserRepository,
    UserTokenRepository,
    LogRepository,
    InvitationRepository,
    CompanyRepository,
    BranchRepository,
    WarehouseRepository,
    BusinessTypeRepository,
    ProductCategoryRepository,
    ProductRepository,
    WarehouseProductRepository,
    MarketplaceRepository,
    ProductFieldMappingRepository,
    ProductPublishingTaskRepository,
    MarketplaceCredentialRepository,
    ProductMarketplaceLinkRepository,
    ProductVariantRepository,
    WarehouseProductVariantRepository,
    PoolRepository,
    PoolWarehouseRepository,
    InventoryMovementRepository
};