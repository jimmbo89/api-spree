const BranchRepository = require("./BranchRepository");
const BusinessTypeRepository = require("./BusinessTypeRepository");
const CompanyRepository = require("./CompanyRepository");
const InvitationRepository = require("./InvitationRepository");
const LogRepository = require("./LogRepository");
const RoleRepository = require("./RoleRepository");
const UserRepository = require("./UserRepository");
const UserTokenRepository = require("./UserTokenRepository");
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
    BusinessTypeRepository
};