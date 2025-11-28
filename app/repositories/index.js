const BranchRepository = require("./BranchRepository");
const BusinessTypeRepository = require("./BusinessTypeRepository");
const CompanyRepository = require("./CompanyRepository");
const InvitationRepository = require("./InvitationRepository");
const LogRepository = require("./LogRepository");
const MarketplaceCredentialRepository = require("./MarketplaceCredentialRepository");
const MarketplaceRepository = require("./MarketplaceRepository");
const ProductCategoryRepository = require("./ProductCategoryRepository");
const ProductFieldMappingRepository = require("./ProductFieldMappingRepository");
const ProductMarketplaceLinkRepository = require("./ProductMarketplaceLinkRepository");
const ProductPublishingTaskRepository = require("./ProductPublishingTaskRepository");
const ProductRepository = require("./ProductRepository");
const RoleRepository = require("./RoleRepository");
const UserRepository = require("./UserRepository");
const UserTokenRepository = require("./UserTokenRepository");
const WarehouseProductRepository = require("./WarehouseProductRepository");
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
    ProductMarketplaceLinkRepository
};