const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');
const MarketplaceTransformer = require('./MarketplaceTransformer');
const MercadoLibreAttributesService = require('./MercadoLibreAttributesService'); // NUEVO
const {
  ProductPublishingTaskRepository,
  ProductMarketplaceLinkRepository,
  WarehouseProductRepository,
  MarketplaceCredentialRepository
} = require('../repositories');
const logger = require('../../config/logger');
const axios = require('axios');

class PublishingService {
  /**
   * Valida atributos obligatorios por categoría (requiere accessToken y dominio)
   */
  static async validateRequiredAttributes(transformed, categoryId, accessToken, marketplaceDomain) {
    if (!categoryId) {
      logger.warn(`[PublishingService] category_id no proporcionado. Saltando validación de atributos obligatorios.`);
      return { valid: true };
    }

    try {
      const url = `${marketplaceDomain}/categories/${categoryId}/attributes`;
      const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      const requiredAttrs = response.data
        .filter(attr => attr.tags?.required || attr.tags?.catalog_required)
        .map(attr => attr.id);

      const providedAttrs = (transformed.attributes || []).map(a => a.id);
      const missing = requiredAttrs.filter(id => !providedAttrs.includes(id));

      if (missing.length > 0) {
        const msg = `Faltan atributos obligatorios: ${missing.join(', ')}`;
        logger.error(`[PublishingService] ${msg}`);
        return { valid: false, error: msg };
      }

      return { valid: true };
    } catch (err) {
      logger.warn(`[PublishingService] No se pudieron validar atributos obligatorios: ${err.message}`);
      return { valid: true };
    }
  }

  /**
   * Publica un producto en un marketplace dado.
   */
  static async publishProduct(productData, marketplace, warehouse, userId) {
    let product;
    let transformed;

    try {
      // 1. Obtener datos del producto
      const { product: productDataResult, warehouseProduct } = await WarehouseProductRepository.getProductAndWarehouseData(
        productData.product_id,
        warehouse.id
      );
      product = productDataResult;

      // 2. Normalizar imágenes
      let images = [];
      if (warehouseProduct.image) {
        images = Array.isArray(warehouseProduct.image) ? warehouseProduct.image : [warehouseProduct.image];
      } else if (product.images) {
        images = Array.isArray(product.images) ? product.images : [product.images];
      }
      if (images.length === 0) {
        logger.info(`[PublishingService] Producto ${product.id} no tiene imágenes definidas`);
      }

      // 3. Preparar datos base
      const baseProductForTransform = {
        ...productData,
        name: product.name,
        title: productData.title || product.name,
        description: product.description || null,
        sku: product.sku,
        images,
        pictures: images,
        price: warehouseProduct.price !== null ? warehouseProduct.price : product.base_price,
        stock: warehouseProduct.stock
      };

      // 4. Obtener adapter
      const adapter = PublishingAdapterFactory.getAdapter(marketplace, warehouse.company_id, warehouse.branch_id);
      if (!adapter) {
        return { success: false, error: 'adapter_not_found', product_id: product.id };
      }

      logger.info(`[PublishingService] Usando adapter para marketplace ${marketplace.name} (${marketplace.domain})`);

      // 5. 🔑 PREDICCIÓN CONDICIONAL: Solo si el adapter soporta categoría (MercadoLibre)
      let productForTransform = { ...baseProductForTransform };

      if (adapter.constructor.supportsCategoryPrediction?.()) {
        const hasValidCreds = await adapter.ensureValidCredentials();
        try {
          const prediction = await adapter.predictCategory(product.name);
          productForTransform.category_id = prediction.category_id;

            productForTransform.is_user_product = prediction.is_user_product;
    
            if (prediction.is_user_product) {
              logger.info(`[PublishingService] Categoría ${prediction.category_id} es User Product - título manejado especial`);
              
              // Para User Products, el título puede necesitar ser diferente
              // Usar un título genérico basado en la categoría
              const categoryName = prediction.category_settings?.name || 'Producto';
              productForTransform.title = `${categoryName} - ${product.name.substring(0, 30)}`;
            }

          // 🔴 CRÍTICO: SI REQUIERE family_name, ASEGURARLO
          if (prediction.requires_family_name) {
            logger.info(`[PublishingService] Categoría ${prediction.category_id} REQUIERE family_name`);
            
            // Intentar construir family_name
            let familyName = '';
            
            // 1. Usar BRAND y MODEL de atributos predichos
            if (prediction.attributes) {
              const brandAttr = prediction.attributes.find(a => a.id === 'BRAND');
              const modelAttr = prediction.attributes.find(a => a.id === 'MODEL');
              
              if (brandAttr?.value_name) familyName += brandAttr.value_name + ' ';
              if (modelAttr?.value_name) familyName += modelAttr.value_name;
            }
            
            // 2. Si no hay atributos, usar nombre del producto
            if (!familyName.trim()) {
              familyName = product.name.substring(0, 50);
            }
            
            // 3. Limpiar y asegurar
            familyName = familyName.replace(/(\b\w+\b)(?:\s+\1)+/gi, '$1')
                                  .replace(/\s+/g, ' ')
                                  .trim();
            
            // 4. Si aún está vacío, usar default
            if (!familyName.trim()) {
              familyName = 'Producto de catálogo';
            }
            
            productForTransform.family_name = familyName;
            logger.info(`[PublishingService] Family_name asignado: "${familyName}"`);
          }

          // 👇 NUEVO: OBTENER ATRIBUTOS DINÁMICAMENTE SI TENEMOS CREDENCIALES VÁLIDAS
          if (prediction.category_id && hasValidCreds && adapter.credential?.access_token) {
            const attributesResult = await MercadoLibreAttributesService.buildAttributesArray(
              {
                ...productForTransform,
                brand: product.brand || productData.brand,
                model: product.model || productData.model,
                warranty: productData.warranty || productForTransform.warranty
              },
              prediction.category_id,
              adapter.credential.access_token,
              adapter.getSiteId()
            );

            // Combinar atributos de predicción con atributos dinámicos
            const combinedAttributes = [];

            // 1. Agregar atributos de predicción primero
            if (prediction.attributes && prediction.attributes.length > 0) {
              prediction.attributes.forEach(predAttr => {
                const existingIndex = combinedAttributes.findIndex(a => a.id === predAttr.id);
                if (existingIndex === -1) {
                  combinedAttributes.push({
                    id: predAttr.id,
                    value_name: predAttr.value_name,
                    ...(predAttr.value_id && { value_id: predAttr.value_id })
                  });
                }
              });
            }

            // 2. Agregar atributos dinámicos (sobrescriben si existen)
            attributesResult.attributes.forEach(dynAttr => {
              const existingIndex = combinedAttributes.findIndex(a => a.id === dynAttr.id);
              if (existingIndex !== -1) {
                // Actualizar con datos más completos
                combinedAttributes[existingIndex] = {
                  ...combinedAttributes[existingIndex],
                  value_name: dynAttr.value_name || combinedAttributes[existingIndex].value_name,
                  ...(dynAttr.value_id && { value_id: dynAttr.value_id })
                };
              } else {
                combinedAttributes.push(dynAttr);
              }
            });

            // 3. Guardar atributos combinados
            if (combinedAttributes.length > 0) {
              productForTransform.suggested_attributes = combinedAttributes;
              logger.info(`[PublishingService] Obtenidos ${combinedAttributes.length} atributos dinámicos`);
            }

            // 4. Log de atributos faltantes (solo para información)
            if (attributesResult.missing_required.length > 0) {
              logger.warn(`[PublishingService] Atributos requeridos faltantes:`, 
                attributesResult.missing_required.map(a => `${a.id} (${a.name})`).join(', '));
            }
          }
          
          // 🔴 CRÍTICO: SI HAY WARRANTY, CONVERTIR A SALE_TERMS
          if (productData.warranty || productForTransform.warranty) {
            const warrantyText = productData.warranty || productForTransform.warranty || '6 meses de garantía';
            
            productForTransform.sale_terms = [
              {
                id: 'WARRANTY_TIME',
                value_name: warrantyText
              },
              {
                id: 'WARRANTY_TYPE',
                value_name: 'Garantía del vendedor'
              }
            ];
            
            // 🔴 ELIMINAR WARRANTY DEL OBJETO PRINCIPAL - NO DEBE ESTAR EN EL PAYLOAD FINAL
            delete productForTransform.warranty;
            delete productData.warranty;
            
            logger.info(`[PublishingService] Warranty convertido a sale_terms: "${warrantyText}"`);
          }
          
          logger.info(`[PublishingService] Categoría predicha: ${prediction.category_id}`);
        } catch (predError) {
          logger.warn(`[PublishingService] Predicción falló:`, predError.message);
        }
      }
  
      // 6. Transformar producto
      const [transformedResult] = await MarketplaceTransformer.transformProducts([productForTransform], marketplace.id);
      transformed = transformedResult;
      if (!transformed) {
        return { success: false, error: 'productTransformFailed', product_id: product.id };
      }
      // 🔴 AÑADIR: CAMPOS REQUERIDOS OBLIGATORIOS
      // 1. Asegurar category_id
      if (productForTransform.category_id) {
        transformed.category_id = productForTransform.category_id;
      }

      // 2. Asegurar family_name si la categoría lo requiere
      if (productForTransform.family_name && !transformed.family_name) {
        transformed.family_name = productForTransform.family_name;
      }

      // 3. Asegurar listing_type_id (requerido por Mercado Libre)
      if (!transformed.listing_type_id) {
        transformed.listing_type_id = 'bronze';
        logger.info(`[PublishingService] Asignado listing_type_id por defecto: bronze`);
      }

      // 4. Asegurar sale_terms para warranty
      if (productForTransform.sale_terms && !transformed.sale_terms) {
        transformed.sale_terms = productForTransform.sale_terms;
      }

      // 5. ELIMINAR WARRANTY - NO DEBE ESTAR EN EL PAYLOAD FINAL
      if (transformed.warranty) {
        logger.warn(`[PublishingService] Eliminando warranty del payload (debe ir en sale_terms)`);
        delete transformed.warranty;
      }

      // 6. Asegurar atributos
      if (productForTransform.suggested_attributes && (!transformed.attributes || transformed.attributes.length === 0)) {
        transformed.attributes = productForTransform.suggested_attributes;
      }
      // 8. Advertencia de stock 0
      if (productForTransform.stock === 0) {
        logger.warn(`[PublishingService] Producto ${product.id} tiene stock 0 → publicación será PAUSADA.`);
      }

      // 9. Validar si el adapter lo soporta
      if (adapter.validateProduct) {
        try {
          await adapter.validateProduct(transformed);
        } catch (validationError) {
          logger.error(`[PublishingService] Validación falló:`, validationError.message);
          return { 
            success: false, 
            error: validationError.message,
            payload: transformed,
            product_id: product.id
          };
        }
      }
      
      // 👇 Para Mercado Libre: Eliminar description (no va en el endpoint /items)
      if (marketplace.domain?.includes('mercadolibre')) {
        delete transformed.description;
      }
      
      // 10. Publicar
      const result = await adapter.publish(transformed);
      logger.info(`[PublishingService] Resultado del adapter.publish():`, JSON.stringify(result, null, 2));

      // 11. Manejo de resultados
      if (result.auth_required) {
        return {
          auth_required: true,
          auth_url: result.auth_url,
          message: result.message || 'Se requiere autenticación en Mercado Libre',
          product_id: product.id
        };
      }

      if (result.success) {
        const task = await ProductPublishingTaskRepository.create({
          product_id: product.id,
          marketplace_id: marketplace.id,
          warehouse_id: warehouse.id,
          user_id: userId,
          date: new Date(),
          status: 'published',
          payload: transformed,
          external_id: result.external_id || result.data?.id,
          external_url: result.data?.permalink
        });

        await ProductMarketplaceLinkRepository.upsert({
          product_id: product.id,
          marketplace_id: marketplace.id,
          company_id: warehouse.company_id,
          branch_id: warehouse.branch_id,
          status: 'published',
          external_id: result.external_id || result.data?.id,
          external_url: result.data?.permalink,
          last_synced_at: new Date()
        });

        return { 
          success: true, 
          task_id: task.id, 
          external_id: result.external_id || result.data?.id,
          product_id: product.id
        };
      }

      // Error en publicación
      logger.error(`[PublishingService] Error del adapter: ${result.error || 'Error desconocido'}`);
      return { 
        success: false, 
        error: result.error || 'unknown_error',
        details: result.details,
        status_code: result.status_code,
        payload: transformed,
        product_id: product.id
      };

    } catch (error) {
      logger.error(`[PublishingService] Error al publicar producto:`, error);
      if (error.message && (error.message.includes('auth') || error.message.includes('credencial'))) {
        return {
          success: false,
          auth_required: true,
          error: error.message,
          product_id: productData.product_id,
          message: 'Error de autenticación. Se requiere configurar credenciales.'
        };
      }
      return { 
        success: false, 
        error: error.message || 'internal_error',
        product_id: productData.product_id
      };
    }
  }
}

module.exports = PublishingService;