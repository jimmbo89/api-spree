const { Warehouse, Branch, Company } = require('../models');
const ImageService = require('../services/ImageService');
const logger = require('../../config/logger');
const WarehouseProductRepository = require('./WarehouseProductRepository');
  const { Op, Sequelize } = require('sequelize');

const WarehouseRepository = {
  /*async findFiltered({ companyId, branchId, userId, status, type }) {
    const where = {};

    if (companyId !== undefined) where.company_id = companyId;
    if (branchId !== undefined) where.branch_id = branchId;
    if (userId !== undefined) where.user_id = userId;
    if (status !== undefined) where.status = status;
    if (type !== undefined) where.type = type;

    const warehouses = await Warehouse.findAll({
      where,
      attributes: [
        'id', 'code', 'user_id', 'company_id', 'branch_id', 
        'name', 'description', 'type', 'address', 'city',
        'region', 'country', 'latitude', 'longitude',
        'capacity_max_units', 'allow_mermas', 'rotation_policy',
        'status', 'image', 'createdAt', 'updatedAt'
      ],
      order: [['name', 'ASC']]
    });

    return warehouses.map(wh => ({
      id: wh.id,
      code: wh.code,
      user_id: wh.user_id,
      company_id: wh.company_id,
      branch_id: wh.branch_id,
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
      updatedAt: wh.updatedAt
    }));
  },*/
  /*async findFiltered({ companyId, branchId, userId, status, type, includeProducts = false }) {
  const where = {};

  if (companyId !== undefined) where.company_id = companyId;
  if (branchId !== undefined) where.branch_id = branchId;
  if (userId !== undefined) where.user_id = userId;
  if (status !== undefined) where.status = status;
  if (type !== undefined) where.type = type;

  const warehouses = await Warehouse.findAll({
    where,
    attributes: [
      'id', 'code', 'user_id', 'company_id', 'branch_id', 
      'name', 'description', 'type', 'address', 'city',
      'region', 'country', 'latitude', 'longitude',
      'capacity_max_units', 'allow_mermas', 'rotation_policy',
      'status', 'image', 'createdAt', 'updatedAt'
    ],
    include: [
      {
        model: Branch,
        as: 'branch',
        attributes: ['id', 'name', 'image']
      },
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'name', 'image']
      }
    ],
    order: [['name', 'ASC']]
  });

  // Obtener IDs de almacenes
  const warehouseIds = warehouses.map(wh => wh.id);
  
  // Obtener conteos de productos
  let productCounts = {};
  if (warehouseIds.length > 0) {
    productCounts = await WarehouseProductRepository.getCountsByWarehouse(warehouseIds);
  }
  
  // Obtener productos detallados (solo si se solicita)
  let warehouseProductsMap = {};
  if (includeProducts && warehouseIds.length > 0) {
    const allWarehouseProducts = await WarehouseProductRepository.findFiltered({
      warehouseId: warehouseIds
    });
    
    allWarehouseProducts.forEach(wp => {
      if (!warehouseProductsMap[wp.warehouse_id]) {
        warehouseProductsMap[wp.warehouse_id] = [];
      }
      warehouseProductsMap[wp.warehouse_id].push(wp);
    });
  }

  return warehouses.map(wh => {
    return {
      id: wh.id,
      code: wh.code,
      user_id: wh.user_id,
      company_id: wh.company_id,
      companyName: wh.company ? wh.company.name : null,
      companyImage: wh.company ? wh.company.image : null,
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
      
      // Estadísticas
      productCount: productCounts[wh.id]?.productCount || 0,
      totalStock: productCounts[wh.id]?.totalStock || 0,
      publishedProducts: productCounts[wh.id]?.publishedProducts || 0,
      
      // Productos detallados (solo si se solicitan)
      products: includeProducts ? (warehouseProductsMap[wh.id] || []) : []
    };
  });
},*/
  /*async findFiltered({ 
    companyId, 
    branchId, 
    userId, 
    status, 
    type, 
    includeProducts = true 
  }) {
    const where = {};
    const include = [];
    
    // Manejo especial para companyId sin branchId
    if (companyId !== undefined && branchId === undefined) {
      // Caso 1: Almacenes que pertenecen directamente a la compañía
      // Caso 2: Almacenes que pertenecen a sucursales de la compañía
      
      include.push(
        {
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false // LEFT JOIN
        },
        {
          model: Branch,
          as: 'branch',
          attributes: ['id', 'name', 'image'],
          include: [{
            model: Company,
            as: 'company',
            attributes: [] // No necesitamos los atributos aquí
          }],
          required: false // LEFT JOIN
        }
      );
      
      // Construcción de la condición WHERE compleja
      where[Op.or] = [
        // Condición 1: warehouse.company_id = companyId
        { company_id: companyId },
        // Condición 2: branch.company_id = companyId (a través del JOIN)
        Sequelize.where(
          Sequelize.col('branch.company_id'), 
          companyId
        )
      ];
      
    } else {
      // Casos normales: filtros individuales
      if (companyId !== undefined) where.company_id = companyId;
      if (branchId !== undefined) where.branch_id = branchId;
      
      // Includes normales para los otros casos
      include.push(
        {
          model: Branch,
          as: 'branch',
          attributes: ['id', 'name', 'image'],
          required: false // LEFT JOIN
        },
        {
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false // LEFT JOIN
        }
      );
    }
    
    // Filtros adicionales comunes
    if (userId !== undefined) where.user_id = userId;
    if (status !== undefined) where.status = status;
    if (type !== undefined) where.type = type;

    // Consulta principal
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
      // Importante: distinct para evitar duplicados por los múltiples JOINs
      distinct: true,
      // Para debug, puedes descomentar:
      // logging: console.log
    });

    // Obtener IDs de almacenes
    const warehouseIds = warehouses.map(wh => wh.id);
    
    // Obtener conteos de productos
    let productCounts = {};
    if (warehouseIds.length > 0) {
      productCounts = await WarehouseProductRepository.getCountsByWarehouse(warehouseIds);
    }
    
    // Obtener productos detallados (solo si se solicita)
    let warehouseProductsMap = {};
    if (includeProducts && warehouseIds.length > 0) {
      const allWarehouseProducts = await WarehouseProductRepository.findFiltered({
        warehouseId: warehouseIds
      });
      
      allWarehouseProducts.forEach(wp => {
        if (!warehouseProductsMap[wp.warehouse_id]) {
          warehouseProductsMap[wp.warehouse_id] = [];
        }
        warehouseProductsMap[wp.warehouse_id].push(wp);
      });
    }

    // Transformar los resultados
    return warehouses.map(wh => {
      // Determinar la compañía correcta (puede venir de warehouse.company o branch.company)
      let companyName = null;
      let companyImage = null;
      
      if (wh.company) {
        // Si el almacén tiene compañía directa
        companyName = wh.company.name;
        companyImage = wh.company.image;
      } else if (wh.branch && wh.branch.company) {
        // Si el almacén tiene compañía a través de la sucursal
        companyName = wh.branch.company.name;
        companyImage = wh.branch.company.image;
      }
      
      return {
        id: wh.id,
        code: wh.code,
        user_id: wh.user_id,
        company_id: wh.company_id || (wh.branch ? wh.branch.company_id : null),
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
        
        // Productos detallados (solo si se solicitan)
        products: includeProducts ? (warehouseProductsMap[wh.id] || []) : [],
        
        // Información adicional para debug
        _source: wh.company ? 'direct_company' : (wh.branch ? 'via_branch' : 'unknown')
      };
    });
  },*/
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
  
  // Manejo especial para companyId sin branchId
  if (companyId !== undefined && branchId === undefined) {
    // Caso 1: Almacenes que pertenecen directamente a la compañía
    // Caso 2: Almacenes que pertenecen a sucursales de la compañía
    
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
          attributes: []
        }],
        required: false
      }
    );
    
    where[Op.or] = [
      { company_id: companyId },
      Sequelize.where(Sequelize.col('branch.company_id'), companyId)
    ];
    
  } else {
    // Casos normales: filtros individuales
    if (companyId !== undefined) where.company_id = companyId;
    if (branchId !== undefined) where.branch_id = branchId;
    
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
  
  // Filtros adicionales
  if (userId !== undefined) where.user_id = userId;
  if (status !== undefined) where.status = status;
  if (type !== undefined) where.type = type;

  // Consulta principal
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
    logging: console.log // ← Activar para debug
  });

  // Obtener IDs de almacenes
  const warehouseIds = warehouses.map(wh => wh.id);
  
  // Obtener conteos de productos
  let productCounts = {};
  if (warehouseIds.length > 0) {
    productCounts = await WarehouseProductRepository.getCountsByWarehouse(warehouseIds);
  }
  logger.info('getCountsByWarehouse');
  logger.info(JSON.stringify(productCounts));
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