# 📦 RESUMEN EJECUTIVO - Cambios de Inventario con Precio de Compra

## 🎯 Objetivo

Implementar sistema de **precio de compra por lote** para calcular la **ganancia real** en cada venta.

---

## 📁 Archivos Modificados

### Backend (API)

| Archivo | Cambios Principales |
|---------|-------------------|
| `app/database/migrations/20260316000001-add-purchase-price-to-warehouse-product-variants.js` | ⭐ Nueva migración: campo `purchase_price` |
| `app/database/migrations/20260316000002-remove-unique-constraint-warehouse-product-variants.js` | ⭐ Nueva migración: remover UNIQUE constraint |
| `app/database/migrations/20260316000003-add-meta-to-inventory-movements.js` | ⭐ Nueva migración: campo `meta` para FIFO |
| `app/models/WarehouseProductVariant.js` | ✅ Campo `purchase_price` agregado |
| `app/models/InventoryMovement.js` | ✅ Campo `meta` agregado |
| `app/repositories/WarehouseProductVariantRepository.js` | ✅ 5 nuevos métodos para gestión de lotes |
| `app/repositories/WarehouseProductRepository.js` | ✅ Actualizado para retornar `purchase_price` en todos los endpoints |
| `app/controllers/WarehouseProductController.js` | ✅ Flujos entry/exit/transfer con FIFO |

### Documentación

| Archivo | Descripción |
|---------|-------------|
| `docs/CAMBIOS_INVENTARIO_PRECIO_COMPRA.md` | 📖 Documentación completa para frontend |
| `docs/RESUMEN_CAMBIOS_INVENTARIO.md` | 📋 Este archivo - resumen ejecutivo |

---

## 🚀 Pasos Rápidos para Implementar

### 1. Backend (3 pasos)

```bash
# Paso 1: Aplicar migraciones
cd api-spree
npx sequelize-cli db:migrate

# Paso 2: Migrar datos existentes (opcional)
# Ejecutar en MySQL/PostgreSQL:
UPDATE warehouse_product_variants 
SET purchase_price = price * 0.7 
WHERE purchase_price = 0;

# Paso 3: Verificar que funciona
# POST /api/movements con movement_type: 'entry'
```

### 2. Frontend (3 áreas)

#### A. Modelos/Types
```typescript
// Agregar a WarehouseProductVariant
purchase_price: number;      // Precio de compra
promotional_price?: number;  // Precio promocional
createdAt: string;           // Fecha para FIFO
```

#### B. Componentes de Inventario
```javascript
// Stock total = suma de todos los lotes
const totalStock = variants.reduce((sum, v) => sum + v.stock, 0);

// Costo promedio ponderado
const avgCost = variants.reduce((sum, v) => sum + (v.purchase_price * v.stock), 0) / totalStock;
```

#### C. Reportes de Ganancias
```javascript
// Ganancia = Venta - Costo FIFO
const ganancia = ventaTotal - movement.total_value;
const margen = (ganancia / ventaTotal) * 100;
```

---

## 💡 Conceptos Clave

### 1. **Lotes (Batch System)**
- Cada compra crea un **nuevo lote** con su `purchase_price` único
- Mismo producto/variante puede tener **múltiples lotes** en un almacén

### 2. **FIFO (First-In-First-Out)**
- Las ventas descuentan stock del **lote más antiguo** primero
- El `total_value` en `inventory_movements` tiene el **costo real FIFO**

### 3. **Ganancia Real**
```
Ganancia = Precio de Venta - Costo FIFO
Margen = (Ganancia / Precio de Venta) × 100
```

---

## 📊 Ejemplo Práctico

### Escenario

```
Compra 1 (Mar 1):  100 unidades a $20,000 = Lote 1
Compra 2 (Mar 15): 100 unidades a $25,000 = Lote 2
Venta (Mar 20):    50 unidades a $40,000 c/u
```

### Resultado con FIFO

```
Stock vendido: 50 unidades del Lote 1 (más antiguo)
Costo FIFO: 50 × $20,000 = $1,000,000
Venta total: 50 × $40,000 = $2,000,000
Ganancia: $2,000,000 - $1,000,000 = $1,000,000
Margen: 50%
```

### Stock Restante

```
Lote 1: 50 unidades a $20,000 (100 - 50)
Lote 2: 100 unidades a $25,000 (sin tocar)
Total: 150 unidades
Valor inventario: (50×20,000) + (100×25,000) = $3,500,000
```

---

## 🔍 Endpoints Afectados

### `POST /api/warehouse-product-user-company`

**Respuesta ahora incluye:**
```json
{
  "variants": [{
    "price": 30000,
    "purchase_price": 20000,    // ⭐ NUEVO
    "promotional_price": null,  // ⭐ NUEVO
    "stock": 50,
    "createdAt": "2026-03-01T10:00:00Z"  // ⭐ NUEVO
  }],
  "stock": 150  // Suma de todos los lotes
}
```

### `POST /api/movements`

**Request (sin cambios):**
```json
{
  "movement_type": "exit",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [{"variant_id": 5, "quantity": 50}]
}
```

**Response (meta ahora incluye FIFO):**
```json
{
  "success": true,
  "reference_id": "uuid-12345",
  "meta": {
    "fifo_calculation": true,
    "lots_used": [
      {"lotId": 1, "quantityUsed": 50, "purchasePrice": 20000}
    ],
    "total_purchase_cost": 1000000  // 💰 Costo FIFO
  }
}
```

### `POST /api/warehouse-metadata`

**Summary ahora incluye:**
```json
{
  "summary": {
    "totalProducts": 150,
    "totalStock": 1500,
    "totalInventoryValue": 32500000,  // ⭐ NUEVO: stock × purchase_price
    "avgPurchasePrice": 22000         // ⭐ NUEVO
  }
}
```

---

## ⚠️ IMPORTANTE: No Romper Funcionalidad

Los cambios son **compatibles hacia atrás**:
- ✅ Los endpoints mantienen la misma estructura de request
- ✅ El response ahora tiene **más campos**, no menos
- ✅ El frontend antiguo sigue funcionando (ignora campos nuevos)
- ✅ El stock total se calcula automático sumando lotes

---

## 🧪 Testing Rápido

### Test 1: Crear dos compras
```bash
# Compra 1
POST /api/movements
{
  "movement_type": "entry",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [{"variant_id": 5, "quantity": 100, "price": 20000}]
}

# Compra 2
POST /api/movements
{
  "movement_type": "entry",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [{"variant_id": 5, "quantity": 100, "price": 25000}]
}
```

### Test 2: Verificar lotes
```bash
POST /api/warehouse-product-user-company
{
  "warehouse_id": 1
}
# Debe retornar 2 warehouseVariants para el mismo producto
```

### Test 3: Venta con FIFO
```bash
POST /api/movements
{
  "movement_type": "exit",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [{"variant_id": 5, "quantity": 50}]
}

# Verificar en DB:
# inventory_movements.total_value = 1,000,000 (50 × 20,000)
# inventory_movements.meta.lots_used[0].purchasePrice = 20000
```

---

## 📞 Soporte / Dudas

### ¿Dónde se guarda el precio de compra?
En `warehouse_product_variants.purchase_price` (por lote)

### ¿Cómo se calcula la ganancia?
`ganancia = venta_total - movement.total_value`

### ¿Qué pasa si vendo más del primer lote?
El sistema continúa con el siguiente lote (FIFO automático)

### ¿Puedo seleccionar manualmente el lote?
No actualmente. Se puede implementar si es necesario.

### ¿Los datos históricos se pierden?
No. Los movimientos anteriores mantienen sus valores.

---

## ✅ Checklist de Implementación

- [ ] Aplicar migraciones en DB
- [ ] Migrar datos existentes (UPDATE)
- [ ] Actualizar models/types en frontend
- [ ] Actualizar componentes de stock (suma de lotes)
- [ ] Actualizar componentes de costo (promedio ponderado)
- [ ] Implementar reporte de ganancias
- [ ] Pruebas de entrada/salida/transferencia
- [ ] Validar cálculo de ganancias

---

**📅 Fecha de implementación:** Marzo 2026  
**👥 Equipo requerido:** 1 backend + 1 frontend  
**⏱️ Tiempo estimado:** 2-4 horas backend, 4-8 horas frontend
