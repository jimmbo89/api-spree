const { Product } = require('../models');
const logger = require('../../config/logger');

const ProductRepository = {
  async findFiltered({ companyId, userId, branchId, categoryId }) {
    const where = { company_id: companyId };

    if (userId !== undefined) where.user_id = userId;
    if (companyId !== undefined) where.user_id = companyId;
    if (categoryId !== undefined) where.user_id = categoryId;
    if (branchId !== undefined) where.branch_id = branchId;

    const products = await Product.findAll({
      where,
      attributes: [
        'id', 'sku', 'name', 'description', 'status', 'category_id',
        'base_price', 'user_id', 'company_id', 'branch_id'
      ]
    });

    return products.map(product => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      description: product.description,
      status: product.status,
      status_label: product.status === 0 ? 'draft'
                    : product.status === 1 ? 'published'
                    : product.status === 2 ? 'error'
                    : 'archived',
      category_id: product.category_id,
      base_price: product.base_price,
      user_id: product.user_id,
      company_id: product.company_id,
      branch_id: product.branch_id
    }));
  },

  async findById(id) {
    return await Product.findByPk(id, {
      attributes: [
        'id', 'sku', 'name', 'description', 'status', 'category_id',
        'base_price', 'user_id', 'company_id', 'branch_id'
      ]
    });
  },

  async create(body, options = {} ) {
    const {
      sku, name, description, status, category_id,
      base_price, user_id, company_id, branch_id
    } = body;

    return await Product.create({
      sku,
      name,
      description: description || null,
      status: status !== undefined ? status : 0,
      category_id: category_id || null,
      base_price: base_price || null,
      user_id: user_id || null,
      company_id: company_id || null,
      branch_id: branch_id || null
    }, options);
  },

  async update(product, body) {
    const fieldsToUpdate = [
      'sku', 'name', 'description', 'status', 'category_id',
      'base_price', 'user_id', 'company_id', 'branch_id'
    ];

    const updatedData = Object.keys(body)
      .filter(key => fieldsToUpdate.includes(key) && body[key] !== undefined)
      .reduce((obj, key) => {
        obj[key] = body[key];
        return obj;
      }, {});

    if (Object.keys(updatedData).length > 0) {
      await product.update(updatedData);
      logger.info(`Producto actualizado (ID: ${product.id})`);
    }

    return product;
  },

  async delete(product) {
    return await product.destroy();
  },

 async existsBySku(sku, excludeId = null) {
  const whereCondition = excludeId
    ? { sku, id: { [Op.ne]: excludeId } }
    : { sku };

  const product = await Product.findOne({ where: whereCondition });
  return !!product;
},
async findBySku(sku) {
  return await Product.findOne({ where: { sku } });
},
async findBySkus(skus) {
  return await Product.findAll({
    where: {
      sku: skus
    }
  });
}
};

module.exports = ProductRepository;