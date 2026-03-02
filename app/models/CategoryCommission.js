'use strict';
const { Model, Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class CategoryCommission extends Model {
    /**
     * Búsqueda optimizada por marketplace + identificadores de categoría
     * @param {number} marketplaceId - ID de la tabla marketplaces
     * @param {Object} identifiers - Objeto con category_id, category_name_api, global_identifier
     * @param {number|null} credentialId - ID opcional de credencial para comisiones por seller
     * @returns {Promise<CategoryCommission|null>}
     */
    static async findByCategory(marketplaceId, { categoryId, categoryName, globalIdentifier }, credentialId = null) {
      const baseWhere = {
        marketplace_id: marketplaceId,
        is_active: 1,
        credential_id: credentialId || { [Op.eq]: null }
      };

      // 🔹 Prioridad 1: Búsqueda directa por category_id (la más rápida - índice único)
      if (categoryId) {
        const byId = await this.findOne({
          where: {
            ...baseWhere,
            category_id: categoryId.toString()
          },
          order: [['updated_at', 'DESC']]
        });
        if (byId) return byId;
      }

      // 🔹 Prioridad 2: Búsqueda por global_identifier (código global)
      if (globalIdentifier) {
        const byGlobal = await this.findOne({
          where: {
            ...baseWhere,
            global_identifier: globalIdentifier
          },
          order: [['updated_at', 'DESC']]
        });
        if (byGlobal) return byGlobal;
      }

      // 🔹 Prioridad 3: Fallback por nombre de categoría (nivel 4 o category_name_api)
      if (categoryName) {
        const normalizedName = categoryName.trim();
        const byName = await this.findOne({
          where: {
            ...baseWhere,
            [Op.or]: [
              { category_level_4: normalizedName },
              { category_name_api: normalizedName },
              { category_level_4: { [Op.like]: `${normalizedName}%` } } // Prefix match más eficiente
            ]
          },
          order: [['updated_at', 'DESC']]
        });
        if (byName) return byName;
      }

      return null;
    }

    /**
     * Calcula pricing estructurado compatible con Mercado Libre/Falabella
     * @param {number} price - Precio del producto
     * @returns {Object} Estructura de pricing estandarizada
     */
    calculatePricing(price) {
      if (!price || price <= 0 || !this.commission_percentage) {
        return {
          sale_fee_amount: null,
          listing_fee_amount: 0,
          total_fee_amount: null,
          fee_percentage: null,
          net_amount: null,
          currency: this.currency || 'CLP',
          warning: 'Comisión no disponible para esta categoría',
          source: 'tabla_local'
        };
      }

      // Cálculo base: precio * porcentaje
      let calculatedFee = parseFloat((price * (this.commission_percentage / 100)).toFixed(0));
      
      // Aplicar mínimo si existe y es mayor
      if (this.min_fee_amount && calculatedFee < this.min_fee_amount) {
        calculatedFee = parseFloat(this.min_fee_amount);
      }
      
      // Aplicar máximo si existe y es menor
      if (this.max_fee_amount && calculatedFee > this.max_fee_amount) {
        calculatedFee = parseFloat(this.max_fee_amount);
      }
      
      // Sumar fee fijo si existe
      const totalFee = calculatedFee + (parseFloat(this.fixed_fee_amount) || 0);
      const netAmount = parseFloat((price - totalFee).toFixed(0));
      
      return {
        sale_fee_amount: calculatedFee,
        listing_fee_amount: parseFloat(this.fixed_fee_amount) || 0,
        total_fee_amount: totalFee,
        category_id: this.category_id,
        category_name: this.category_name_api || this.category_level_4,
        category_path: this.category_level_2 
          ? `${this.category_level_1} > ${this.category_level_2}${this.category_level_3 ? ` > ${this.category_level_3}` : ''} > ${this.category_level_4}`
          : this.category_level_1,
        input_price: price,
        net_amount: netAmount,
        fee_percentage: parseFloat(this.commission_percentage),
        currency: this.currency,
        source: this.source || 'tabla_local',
        updated_at: this.updated_at?.toISOString?.() || this.updated_at
      };
    }

    static associate(models) {
      // CategoryCommission pertenece a un marketplace
      CategoryCommission.belongsTo(models.Marketplace, {
        foreignKey: 'marketplace_id',
        as: 'marketplace',
        onDelete: 'CASCADE'
      });

      // CategoryCommission puede estar vinculada a una credencial específica (opcional)
      CategoryCommission.belongsTo(models.MarketplaceCredential, {
        foreignKey: 'credential_id',
        as: 'credential',
        onDelete: 'SET NULL'
      });
    }
  }

  CategoryCommission.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    marketplace_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: {
        model: 'marketplaces',
        key: 'id'
      }
    },
    credential_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: {
        model: 'marketplace_credentials',
        key: 'id'
      }
    },
    category_id: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    global_identifier: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    category_name_api: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    category_level_1: {
      type: DataTypes.STRING(150),
      allowNull: false
    },
    category_level_2: {
      type: DataTypes.STRING(150),
      allowNull: true
    },
    category_level_3: {
      type: DataTypes.STRING(150),
      allowNull: true
    },
    category_level_4: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    commission_percentage: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false
    },
    min_fee_amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0
    },
    max_fee_amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true
    },
    fixed_fee_amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: 'CLP'
    },
    is_active: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1
    },
    source: {
      type: DataTypes.ENUM('csv_import', 'api_sync', 'manual', 'marketplace_api'),
      allowNull: false,
      defaultValue: 'csv_import'
    },
    last_synced_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'CategoryCommission',
    tableName: 'category_commissions',
    timestamps: true,
  });

  return CategoryCommission;
};