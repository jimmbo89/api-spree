const { Warehouse, Branch, Company } = require('../models');
const ImageService = require('../services/ImageService');
const logger = require('../../config/logger');
const WarehouseProductRepository = require('./WarehouseProductRepository');
  const { Op, Sequelize } = require('sequelize');

const WarehouseRepository = {
  async findFiltered({ 
  companyId, 
  branchId, 
  userId, 
  status, 
  type, 
  includeProducts = true // ← Valor por defecto true
}) {
  const where = {};
  const include = [];

  // Caso especial: se filtra por companyId y NO por branchId específico
  if (companyId != null && companyId !== 0 && (branchId == null || branchId === 0)) {
    // Incluimos relaciones para poder filtrar por branch.company_id
    include.push(
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'name', 'image'],
        required: false
      },
      {
        model: Branch,
        as: 'branch',
        attributes: ['id', 'name', 'image'],
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'] // necesitas el id al menos para join
        }],
        required: false
      }
    );

    // Filtrar: almacenes propios de la compañía O almacenes de sus sucursales
    where[Op.or] = [
      { company_id: companyId },
      { '$branch.company_id$': companyId } // Sequelize usa $...$ para columnas anidadas en where
    ];

  } else {
    // Caso normal: filtrado directo
    if (companyId != null && companyId !== 0) where.company_id = companyId;
    if (branchId != null && branchId !== 0) where.branch_id = branchId;

    include.push(
      {
        model: Branch,
        as: 'branch',
        attributes: ['id', 'name', 'image'],
        required: false
      },
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'name', 'image'],
        required: false
      }
    );
  }

  // Otros filtros
  if (userId != null && userId !== 0) where.user_id = userId;
  if (status != null && status !== 0) where.status = status;
  if (type != null && type !== 0) where.type = type;

  // Consulta
  const warehouses = await Warehouse.findAll({
    where,
    attributes: [
      'id', 'code', 'user_id', 'company_id', 'branch_id', 
      'name', 'description', 'type', 'address', 'city',
      'region', 'country', 'latitude', 'longitude',
      'capacity_max_units', 'allow_mermas', 'rotation_policy',
      'status', 'image', 'createdAt', 'updatedAt'
    ],
    include,
    order: [['name', 'ASC']],
    distinct: true,
  });
  // Obtener IDs de almacenes
  const warehouseIds = warehouses.map(wh => wh.id);
  
  // Obtener conteos de productos
  let productCounts = {};
  if (warehouseIds.length > 0 && includeProducts === true) {
    productCounts = await WarehouseProductRepository.getCountsByWarehouse(warehouseIds);
  }
  // Obtener productos detallados (solo si se solicita)
  let warehouseProductsMap = {};
  if (includeProducts && warehouseIds.length > 0) {
    try {
      const allWarehouseProducts = await WarehouseProductRepository.findFiltered({
        warehouseId: warehouseIds
      });
      
      allWarehouseProducts.forEach(wp => {
        if (!warehouseProductsMap[wp.warehouse_id]) {
          warehouseProductsMap[wp.warehouse_id] = [];
        }
        warehouseProductsMap[wp.warehouse_id].push(wp);
      });
    } catch (error) {
      console.error('Error al obtener productos de almacenes:', error);
      // Si hay error, dejamos el array vacío
    }
  }

  // Transformar los resultados
  return warehouses.map(wh => {
    // Determinar la compañía correcta
    let companyName = null;
    let companyImage = null;
    let finalCompanyId = null;
    
    if (wh.company) {
      companyName = wh.company.name;
      companyImage = wh.company.image;
      finalCompanyId = wh.company_id;
    } else if (wh.branch && wh.branch.company) {
      companyName = wh.branch.company.name;
      companyImage = wh.branch.company.image;
      finalCompanyId = wh.branch.company_id;
    } else {
      finalCompanyId = wh.company_id;
    }
    
    return {
      id: wh.id,
      code: wh.code,
      user_id: wh.user_id,
      company_id: finalCompanyId,
      companyName,
      companyImage,
      branch_id: wh.branch_id,
      branchName: wh.branch ? wh.branch.name : null,
      branchImage: wh.branch ? wh.branch.image : null,
      name: wh.name,
      description: wh.description,
      type: wh.type,
      address: wh.address,
      city: wh.city,
      region: wh.region,
      country: wh.country,
      latitude: wh.latitude,
      longitude: wh.longitude,
      capacity_max_units: wh.capacity_max_units,
      allow_mermas: wh.allow_mermas,
      rotation_policy: wh.rotation_policy,
      status: wh.status,
      image: wh.image,
      createdAt: wh.createdAt,
      updatedAt: wh.updatedAt,
      
      // Estadísticas
      productCount: productCounts[wh.id]?.productCount || 0,
      totalStock: productCounts[wh.id]?.totalStock || 0,
      publishedProducts: productCounts[wh.id]?.publishedProducts || 0,
      
      // Productos detallados
      products: includeProducts ? (warehouseProductsMap[wh.id] || []) : [],
      
      _source: wh.company ? 'direct_company' : (wh.branch ? 'via_branch' : 'unknown')
    };
  });
},
  async findById(id) {
    return await Warehouse.findByPk(id, {
      attributes: [
        'id', 'code', 'user_id', 'company_id', 'branch_id', 
        'name', 'description', 'type', 'address', 'city',
        'region', 'country', 'latitude', 'longitude',
        'capacity_max_units', 'allow_mermas', 'rotation_policy',
        'status', 'image'
      ],
    });
  },

  async validateWarehousesExist(warehouseIds, companyId = null) {
  if (!Array.isArray(warehouseIds) || warehouseIds.length === 0) {
    return { valid: false, missing: [], message: "No se proporcionaron almacenes" };
  }

  // Eliminar duplicados y asegurar que sean números
  const uniqueIds = [...new Set(warehouseIds.map(id => Number(id)).filter(id => !isNaN(id)))];

  if (uniqueIds.length === 0) {
    return { valid: false, missing: warehouseIds, message: "IDs de almacén inválidos" };
  }

  const where = { id: uniqueIds };
  if (companyId) {
    where.company_id = companyId;
  }

  const foundWarehouses = await Warehouse.findAll({
    where,
    attributes: ['id'],
    raw: true
  });

  const foundIds = new Set(foundWarehouses.map(w => w.id));
  const missing = uniqueIds.filter(id => !foundIds.has(id));

  if (missing.length > 0) {
    return {
      valid: false,
      missing,
      message: `Almacenes no encontrados: ${missing.join(', ')}`
    };
  }

  return { valid: true, missing: [] };
},

  async create(body, file, transaction = null) {
    const { 
      code, name, description, type, address, city, region, 
      country, latitude, longitude, capacity_max_units, 
      allow_mermas, rotation_policy, status, company_id, 
      branch_id, user_id 
    } = body;

    const warehouse = await Warehouse.create({
      code,
      name,
      description: description || null,
      type: type || 'central',
      address: address || null,
      city: city || null,
      region: region || null,
      country: country || null,
      latitude: latitude || null,
      longitude: longitude || null,
      capacity_max_units: capacity_max_units || null,
      allow_mermas: allow_mermas !== undefined ? allow_mermas : true,
      rotation_policy: rotation_policy || 'FIFO',
      status: status || 'activo',
      company_id: company_id || null,
      branch_id: branch_id || null,
      user_id: user_id || null,
      image: 'warehouses/default.jpg',
    }, { transaction });

    if (file) {
      const newFilename = ImageService.generateFilename('warehouses', warehouse.id, file.originalname);
      warehouse.image = await ImageService.moveFile(file, newFilename);
      await warehouse.update({ image: warehouse.image }, { transaction });
    }

    return warehouse;
  },

  async update(warehouse, body, file) {
    const fieldsToUpdate = [
      'code', 'name', 'description', 'type', 'address', 'city',
      'region', 'country', 'latitude', 'longitude', 'capacity_max_units',
      'allow_mermas', 'rotation_policy', 'status', 'company_id',
      'branch_id', 'user_id'
    ];

    const updatedData = Object.keys(body)
      .filter(key => fieldsToUpdate.includes(key) && body[key] !== undefined)
      .reduce((obj, key) => {
        obj[key] = body[key];
        return obj;
      }, {});

    if (file) {
      if (warehouse.image && warehouse.image !== 'warehouses/default.jpg') {
        await ImageService.deleteFile(warehouse.image);
      }
      const newFilename = ImageService.generateFilename('warehouses', warehouse.id, file.originalname);
      updatedData.image = await ImageService.moveFile(file, newFilename);
    }

    if (Object.keys(updatedData).length > 0) {
      await warehouse.update(updatedData);
      logger.info(`Almacén actualizado (ID: ${warehouse.id})`);
    }

    return warehouse;
  },

  async delete(warehouse) {
    if (warehouse.image && warehouse.image !== 'warehouses/default.jpg') {
      await ImageService.deleteFile(warehouse.image);
    }
    return await warehouse.destroy();
  },

  async existsPrincipalByEntity({ companyId = null, branchId = null }, transaction = null) {
    if (companyId === null && branchId === null) {
      throw new Error('Debe proporcionar companyId o branchId');
    }

    const whereCondition = {
      status: 'activo',
      type: 'central',
      ...(companyId !== null && { company_id: companyId, branch_id: null }),
      ...(branchId !== null && { branch_id: branchId, company_id: null }),
    };

    const warehouse = await Warehouse.findOne({
      where: whereCondition,
      transaction,
    });

    return !!warehouse;
  },

  async getByCode(code) {
    return await Warehouse.findOne({
      where: { code },
      attributes: [
        'id', 'code', 'name', 'type', 'status', 'company_id', 'branch_id'
      ]
    });
  },

  async getActiveWarehouses(companyId = null, branchId = null) {
    const where = { status: 'activo' };
    
    if (companyId !== null) where.company_id = companyId;
    if (branchId !== null) where.branch_id = branchId;
    
    return await Warehouse.findAll({
      where,
      attributes: ['id', 'code', 'name', 'type', 'capacity_max_units'],
      order: [['name', 'ASC']]
    });
  }
};

module.exports = WarehouseRepository;