-- =============================================
-- MIGRACIÓN DE DATOS - Precio de Compra
-- =============================================
-- Este script asigna un precio de compra estimado 
-- para los registros existentes antes de la implementación
--
-- EJECUTAR DESPUÉS DE: npx sequelize-cli db:migrate
-- =============================================

-- Opción 1: Asignar 70% del precio de venta (asume 30% de margen)
UPDATE warehouse_product_variants 
SET purchase_price = ROUND(price * 0.7, 2)
WHERE purchase_price = 0 OR purchase_price IS NULL;

-- Opción 2: Si tienes un margen diferente, ajusta el multiplicador
-- 60% del precio de venta (40% de margen)
-- UPDATE warehouse_product_variants 
-- SET purchase_price = ROUND(price * 0.6, 2)
-- WHERE purchase_price = 0 OR purchase_price IS NULL;

-- Opción 3: Si conoces el margen real por categoría, usa esto:
-- UPDATE wpv
-- SET purchase_price = CASE
--     WHEN p.category_id = 1 THEN ROUND(wpv.price * 0.65, 2)  -- 35% margen
--     WHEN p.category_id = 2 THEN ROUND(wpv.price * 0.70, 2)  -- 30% margen
--     WHEN p.category_id = 3 THEN ROUND(wpv.price * 0.75, 2)  -- 25% margen
--     ELSE ROUND(wpv.price * 0.70, 2)  -- Default 30% margen
-- END
-- FROM warehouse_product_variants wpv
-- JOIN warehouse_products wp ON wpv.warehouse_product_id = wp.id
-- JOIN products p ON wp.product_id = p.id
-- WHERE wpv.purchase_price = 0 OR wpv.purchase_price IS NULL;

-- =============================================
-- VERIFICACIÓN - Ver datos migrados
-- =============================================

-- Ver cuántos registros se actualizaron
SELECT 
    COUNT(*) AS total_registros,
    COUNT(CASE WHEN purchase_price > 0 THEN 1 END) AS con_precio_compra,
    COUNT(CASE WHEN purchase_price = 0 OR purchase_price IS NULL THEN 1 END) AS sin_precio_compra
FROM warehouse_product_variants;

-- Ver muestra de datos
SELECT 
    wpv.id,
    wpv.warehouse_product_id,
    wpv.variant_id,
    wpv.price AS precio_venta,
    wpv.purchase_price AS precio_compra,
    wpv.stock,
    ROUND((wpv.price - wpv.purchase_price) / wpv.price * 100, 2) AS margen_porcentaje
FROM warehouse_product_variants wpv
ORDER BY wpv.id
LIMIT 20;

-- =============================================
-- CONSULTAS ÚTILES POST-MIGRACIÓN
-- =============================================

-- 1. Valor total del inventario (costo de reposición)
SELECT 
    SUM(wpv.stock * wpv.purchase_price) AS valor_total_inventario,
    SUM(wpv.stock) AS stock_total,
    SUM(wpv.stock * wpv.price) AS valor_total_venta,
    SUM(wpv.stock * (wpv.price - wpv.purchase_price)) AS ganancia_potencial
FROM warehouse_product_variants wpv
WHERE wpv.active = 1;

-- 2. Stock por almacén con valorización
SELECT 
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    COUNT(DISTINCT wp.product_id) AS productos_unicos,
    SUM(wpv.stock) AS stock_total,
    SUM(wpv.stock * wpv.purchase_price) AS valor_costo,
    SUM(wpv.stock * wpv.price) AS valor_venta,
    ROUND(AVG(wpv.purchase_price), 2) AS precio_compra_promedio
FROM warehouse_product_variants wpv
JOIN warehouse_products wp ON wpv.warehouse_product_id = wp.id
JOIN warehouses w ON wp.warehouse_id = w.id
WHERE wpv.active = 1
GROUP BY w.id, w.name
ORDER BY w.name;

-- 3. Productos con margen negativo (precio compra > precio venta)
SELECT 
    p.sku,
    p.name,
    w.name AS warehouse,
    wpv.price AS precio_venta,
    wpv.purchase_price AS precio_compra,
    wpv.stock,
    ROUND((wpv.price - wpv.purchase_price), 2) AS margen_unitario,
    ROUND((wpv.price - wpv.purchase_price) / wpv.price * 100, 2) AS margen_porcentaje
FROM warehouse_product_variants wpv
JOIN warehouse_products wp ON wpv.warehouse_product_id = wp.id
JOIN products p ON wp.product_id = p.id
JOIN warehouses w ON wp.warehouse_id = w.id
WHERE wpv.purchase_price > wpv.price
  AND wpv.active = 1
  AND wpv.stock > 0
ORDER BY (wpv.purchase_price - wpv.price) DESC;

-- =============================================
-- ÍNDICES RECOMENDADOS (opcional, para rendimiento)
-- =============================================

-- Índice para consultas FIFO (por fecha de creación)
CREATE INDEX IF NOT EXISTS idx_warehouse_product_variants_fifo 
ON warehouse_product_variants(warehouse_product_id, variant_id, createdAt);

-- Índice para consultas por precio de compra
CREATE INDEX IF NOT EXISTS idx_warehouse_product_variants_purchase_price 
ON warehouse_product_variants(purchase_price);

-- Índice para consultas de valor de inventario
CREATE INDEX IF NOT EXISTS idx_warehouse_product_variants_active_stock 
ON warehouse_product_variants(active, stock);

-- =============================================
-- FIN DEL SCRIPT
-- =============================================
