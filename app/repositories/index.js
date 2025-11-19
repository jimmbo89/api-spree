const BranchRepository = require("./BranchRepository");
const BusinessTypeRepository = require("./BusinessTypeRepository");
const CompanyRepository = require("./CompanyRepository");
const InvitationRepository = require("./InvitationRepository");
const LogRepository = require("./LogRepository");
const ProductCategoryRepository = require("./ProductCategoryRepository");
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
    WarehouseProductRepository
};