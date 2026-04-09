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
  includeProducts = true
}) {
  const where = {};
  const include = [];

  // ✅ FILTRAR por companyId y/o branchId
  if (companyId != null && companyId !== 0) {
    if (branchId != null && branchId !== 0) {
      // ✅ Ambos companyId y branchId especificados
      // Verificar que la branch pertenezca a la company
      const branch = await Branch.findByPk(branchId);
      if (!branch || branch.company_id !== companyId) {
        return []; // Branch no pertenece a la company
      }
      // Filtrar solo almacenes de esta branch específica
      where.branch_id = branchId;
    } else {
      // ✅ Solo companyId especificado
      // Estrategia: Obtener IDs de branches válidas y filtrar por ellas
      
      // 1. Obtener branches que pertenecen a la company
      const companyBranches = await Branch.findAll({
        where: { company_id: companyId },
        attributes: ['id'],
        raw: true
      });
      
      const validBranchIds = companyBranches.map(b => b.id);
      
      // 2. Construir filtro para almacenes:
      // - Almacenes directos de la company (company_id = companyId, branch_id null/0)
      // - Almacenes de branches de la company (branch_id IN validBranchIds)
      const branchCondition = validBranchIds.length > 0
        ? { branch_id: { [Op.in]: validBranchIds } }
        : { branch_id: { [Op.eq]: 0 } }; // Si no hay branches, usar condición falsa
      
      where[Op.or] = [
        {
          company_id: companyId,
          branch_id: { [Op.or]: [{ [Op.is]: null }, { [Op.eq]: 0 }] }
        },
        branchCondition
      ];
      
      // 3. Incluir branch para obtener sus datos (sin filtrar por company_id aquí)
      include.push({
        model: Branch,
        as: 'branch',
        attributes: ['id', 'name', 'image', 'company_id'],
        required: false
      });
    }
  } else if (branchId != null && branchId !== 0) {
    // ✅ Solo branchId especificado (sin companyId)
    where.branch_id = branchId;
  }
  // Si no hay companyId ni branchId, no filtrar (trae todos)

  // ✅ Otros filtros opcionales
  if (userId != null && userId !== 0) where.user_id = userId;
  if (status != null && status !== 0) where.status = status;
  if (type != null && type !== 0) where.type = type;

  // ✅ Excluir almacenes con status 'delete' por defecto
  if (!status || status === 'delete') {
    where.status = { [Op.ne]: 'delete' };
  }

  // ✅ Incluir relaciones
  include.push(
    {
      model: Company,
      as: 'company',
      attributes: ['id', 'name', 'image'],
      required: false
    }
  );

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

  // ✅ FILTRADO MANUAL (capa adicional de seguridad)
  // Obtener branches válidas de la company para verificar
  let validBranchIds = new Set();
  if (companyId != null && companyId !== 0) {
    const branches = await Branch.findAll({
      where: { company_id: companyId },
      attributes: ['id'],
      raw: true
    });
    validBranchIds = new Set(branches.map(b => b.id));
  }

  const filteredWarehouses = warehouses.filter(wh => {
    if (companyId != null && companyId !== 0) {
      // Caso 1: Almacén directo de la company
      if (wh.company_id === companyId && (wh.branch_id === null || wh.branch_id === 0)) {
        return true;
      }
      // Caso 2: Almacén de branch → verificar que branch_id esté en validBranchIds
      if (wh.branch_id !== null && wh.branch_id !== 0 && validBranchIds.has(wh.branch_id)) {
        return true;
      }
      // ❌ Excluir: huérfanos, otras companies, branches no válidas
      return false;
    }
    return true;
  });

  // Obtener IDs de almacenes válidos
  const warehouseIds = filteredWarehouses.map(wh => wh.id);
  
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

  // Transformar los resultados (usando filteredWarehouses, no warehouses)
  return filteredWarehouses.map(wh => {
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
/**
 * Verifica si ya existe un almacén con el mismo nombre o código en la misma empresa o sucursal.
 *
 * @param {Object} data - Contiene name, code, company_id y branch_id
 * @param {number|null} excludeId - ID del almacén a excluir (para ediciones)
 * @returns {Promise<{ exists: boolean, field: string | null, existing: object | null }>}
 */
async checkUniqueName(data, excludeId = null) {
  const { code, name, company_id, branch_id } = data;

  // Validar nombre
  if (name && name.trim() !== '') {
    const whereCondition = {
      name: name.trim()
    };

    // Filtrar por empresa o sucursal según corresponda
    if (branch_id !== null && branch_id !== undefined) {
      // Almacén asociado a una sucursal → unicidad dentro de esa sucursal
      whereCondition.branch_id = branch_id;
      whereCondition.company_id = null;
    } else {
      // Almacén asociado directamente a la empresa → unicidad dentro de la empresa
      whereCondition.company_id = company_id;
      whereCondition.branch_id = null;
    }

    // Excluir el registro actual si se está editando
    if (excludeId !== null) {
      whereCondition.id = { [Op.ne]: excludeId };
    }

    const existingByName = await Warehouse.findOne({
      where: whereCondition,
      attributes: ['id', 'name', 'company_id', 'branch_id']
    });

    if (existingByName) {
      return { exists: true, field: 'name', existing: existingByName };
    }
  }

  // Validar código
  if (code && code.trim() !== '') {
    const whereCondition = {
      code: code.trim()
    };

    // Filtrar por empresa o sucursal según corresponda
    if (branch_id !== null && branch_id !== undefined) {
      whereCondition.branch_id = branch_id;
      whereCondition.company_id = null;
    } else {
      whereCondition.company_id = company_id;
      whereCondition.branch_id = null;
    }

    // Excluir el registro actual si se está editando
    if (excludeId !== null) {
      whereCondition.id = { [Op.ne]: excludeId };
    }

    const existingByCode = await Warehouse.findOne({
      where: whereCondition,
      attributes: ['id', 'code', 'company_id', 'branch_id']
    });

    if (existingByCode) {
      return { exists: true, field: 'code', existing: existingByCode };
    }
  }

  return { exists: false, field: null, existing: null };
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

  async countByCompanyId(companyId) {
  const count = await Warehouse.count({
    where: {
      [Op.or]: [
        { company_id: companyId }, // Almacenes directos de la empresa
        {
          branch_id: {
            [Op.in]: Sequelize.literal(
              `(SELECT id FROM branches WHERE company_id = ${companyId})`
            )
          }
        }
      ]
    }
  });

  return count;
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

  // ✅ Excluir almacenes con status 'delete'
  where.status = { [Op.ne]: 'delete' };

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

  async findWarehousesByCompanyOrBranch(company_id, branch_id) {

  const where = {};

  // ✅ Excluir almacenes con status 'delete'
  where.status = { [Op.ne]: 'delete' };

  if (branch_id) {
    where.branch_id = branch_id;
  } else if (company_id) {
    // Obtener las branches de esta company primero
    const branches = await Branch.findAll({
      where: { company_id },
      attributes: ['id']
    });

    const branchIds = branches.map(b => b.id);

    // Buscar warehouses de la company directa O de sus branches
    where[Op.or] = [
      { company_id },
      { branch_id: { [Op.in]: branchIds } }
    ];
  }

  return Warehouse.findAll({
    where,
    attributes: ['id', 'code', 'name', 'type', 'status', 'company_id', 'branch_id']
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
  },

  async validateWarehouseIdsExist(warehouseIds) {
  if (!Array.isArray(warehouseIds) || warehouseIds.length === 0) {
    return { valid: true, invalidIds: [] };
  }
  const existing = await Warehouse.findAll({
    where: { id: warehouseIds },
    attributes: ['id']
  });
  const existingIds = new Set(existing.map(w => w.id));
  const invalidIds = warehouseIds.filter(id => !existingIds.has(id));
  return { valid: invalidIds.length === 0, invalidIds };
},

};

module.exports = WarehouseRepository;