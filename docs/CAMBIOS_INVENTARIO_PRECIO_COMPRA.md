# 📦 Cambios en el Sistema de Inventario - Implementación de Precio de Compra y FIFO

## 📋 Resumen Ejecutivo

Se ha implementado un sistema de **gestión de lotes por precio de compra** que permite:
- Registrar el **precio de compra** de cada lote de producto
- Calcular la **ganancia real** por venta basada en el costo del lote vendido
- Aplicar método **FIFO** (First-In-First-Out) para salidas de inventario
- Mantener el **costo original** en transferencias entre almacenes

---

## 🗄️ Cambios en la Base de Datos

### 1. Nueva columna `purchase_price` en `warehouse_product_variants`

**Migración:** `20260316000001-add-purchase-price-to-warehouse-product-variants.js`

```sql
ALTER TABLE warehouse_product_variants 
ADD COLUMN purchase_price DECIMAL(16,2) NOT NULL DEFAULT 0;
```

**Propósito:** Almacenar el precio de compra unitario de cada lote.

### 2. Remoción del constraint UNIQUE en `warehouse_product_variants`

**Migración:** `20260316000002-remove-unique-constraint-warehouse-product-variants.js`

```sql
-- Se elimina el UNIQUE constraint (warehouse_product_id, variant_id)
-- Ahora pueden existir múltiples registros (lotes) del mismo producto/variante en un almacén
```

**⚠️ IMPORTANTE:** Esto cambia el comportamiento del sistema. Ahora una variante puede tener **múltiples lotes** en el mismo almacén.

### 3. Nueva columna `meta` en `inventory_movements`

**Migración:** `20260316000003-add-meta-to-inventory-movements.js`

```sql
ALTER TABLE inventory_movements 
ADD COLUMN meta JSON DEFAULT '{}';
```

**Propósito:** Almacenar información detallada de cálculos FIFO y lotes utilizados.

---

## 📡 Cambios en la API

### 1. Estructura de Datos de `warehouse_product_variants`

**ANTES:**
```json
{
  "id": 1,
  "warehouse_product_id": 10,
  "variant_id": 5,
  "price": 30000,
  "stock": 100,
  "active": true
}
```

**AHORA:**
```json
{
  "id": 1,
  "warehouse_product_id": 10,
  "variant_id": 5,
  "price": 30000,              // Precio de venta
  "purchase_price": 20000,      // 💰 NUEVO: Precio de compra
  "promotional_price": null,
  "stock": 100,
  "active": true,
  "published": false,
  "local_sku": "PROD-001",
  "createdAt": "2026-03-01T10:00:00Z"  // 💰 IMPORTANTE: Fecha para FIFO
}
```

### 2. Múltiples lotes por variante

Ahora una consulta a `/api/warehouse-product-user-company` puede retornar **múltiples registros** para la misma variante en un almacén:

```json
{
  "warehouse_products": [
    {
      "id": 10,
      "product_id": 5,
      "warehouse_id": 3,
      "warehouseVariants": [
        {
          "id": 1,
          "variant_id": 5,
          "purchase_price": 20000,  // Lote 1 - Compra antigua
          "price": 30000,
          "stock": 50,
          "createdAt": "2026-03-01T10:00:00Z"
        },
        {
          "id": 2,
          "variant_id": 5,
          "purchase_price": 25000,  // Lote 2 - Compra reciente
          "price": 35000,
          "stock": 100,
          "createdAt": "2026-03-15T10:00:00Z"
        }
      ]
    }
  ]
}
```

### 3. Respuesta del endpoint `warehouse-product-user-company`

**CAMBIOS IMPORTANTES:** Cada variante ahora incluye:

```json
{
  "variants": [
    {
      "id": 1,
      "variant_id": 5,
      "sku": "ZAP-001",
      "price": 30000,
      "purchase_price": 20000,      // ⭐ NUEVO
      "promotional_price": null,    // ⭐ NUEVO
      "stock": 50,
      "active": true,
      "createdAt": "2026-03-01T10:00:00Z"  // ⭐ NUEVO
    }
  ],
  "stock": 150  // Suma de todos los lotes
}
```

### 4. Nuevos campos en resumen de inventario

El endpoint que retorna el resumen del inventario ahora incluye:

```json
{
  "sumary": {
    "totalProducts": 150,
    "totalWarehouseProducts": 200,
    "totalStock": 1500,
    "totalInventoryValue": 32500000  // ⭐ NUEVO: stock × purchase_price
  },
  "productsByWarehouse": [
    {
      "warehouse_id": 1,
      "warehouse_name": "Almacén Central",
      "totalProducts": 100,
      "totalWarehouseProducts": 120,
      "totalStock": 1000,
      "totalInventoryValue": 22000000,  // ⭐ NUEVO
      "avgPurchasePrice": 22000         // ⭐ NUEVO
    }
  ]
}
```

---

## 🔄 Cambios en los Endpoints

### `POST /api/movements` - Crear Movimiento

#### **ENTRADA (entry) - Request Actualizado**

**Request con `purchase_price` separado (RECOMENDADO):**
```json
{
  "movement_type": "entry",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [
    {
      "variant_id": 5,
      "quantity": 100,
      "purchase_price": 25000,    // 💰 PRECIO DE COMPRA (campo separado)
      "price": 35000              // 💰 PRECIO DE VENTA (campo separado)
    }
  ],
  "reason": "Compra a proveedor",
  "notes": "Orden de compra #12345"
}
```

**Request básico (sin variant_id, usando price como fallback):**
```json
{
  "movement_type": "entry",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [
    {
      "quantity": 100,
      "price": 25000              // Si no hay purchase_price, se usa price
    }
  ],
  "reason": "Compra a proveedor"
}
```

**Comportamiento:**
- ✅ **Si envía `purchase_price`:** Se usa como precio de compra del lote
- ✅ **Si NO envía `purchase_price`:** Usa `price` como precio de compra (fallback)
- ✅ **Si NO envía `variant_id`:** Usa/crea variante por defecto automáticamente
- ✅ **AHORA:** Siempre crea un **nuevo lote** con el `purchase_price` especificado
- ✅ **AHORA:** Guarda información del lote en `inventory_movements.meta`

#### **SALIDA (exit) - Sin cambios en el request**

```json
{
  "movement_type": "exit",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [
    {
      "variant_id": 5,
      "quantity": 50
    }
  ],
  "reason": "Venta a cliente"
}
```

**Comportamiento:**
- ✅ **AHORA:** Aplica **FIFO** automáticamente
  - Obtiene lotes ordenados por `createdAt` (más antiguo primero)
  - Descuenta stock comenzando por el lote más antiguo
  - Calcula el **costo total real** de lo vendido
  - Guarda detalle en `inventory_movements.meta`

```json
// Response de inventory_movements para SALIDA (exit) con FIFO
{
  "id": 124,
  "movement_type": "exit",
  "quantity": 50,
  "unit_price": 20000,          // Costo promedio FIFO
  "total_value": 1000000,       // 💰 Costo total real
  "meta": {
    "fifo_calculation": true,
    "lots_used": [
      {
        "lotId": 1,
        "oldStock": 100,
        "newStock": 50,
        "purchasePrice": 20000,
        "quantityUsed": 50
      }
    ],
    "total_purchase_cost": 1000000
  }
}

// Response de inventory_movements para ENTRADA (entry)
{
  "id": 123,
  "movement_type": "entry",
  "quantity": 100,
  "unit_price": 25000,
  "total_value": 2500000,
  "meta": {
    "lot_created": true,        // ⭐ Se creó un nuevo lote
    "lot_id": 456,              // ⭐ ID del lote creado
    "purchase_price": 25000,    // ⭐ Precio de compra
    "sale_price": 35000         // ⭐ Precio de venta
  }
}
```

#### **TRANSFERENCIA (transfer) - Sin cambios en el request**

```json
{
  "movement_type": "transfer",
  "origin_warehouse_id": 1,
  "destination_warehouse_id": 2,
  "product_id": 10,
  "variants": [
    {
      "variant_id": 5,
      "quantity": 30
    }
  ],
  "reason": "Traslado entre almacenes"
}
```

**Comportamiento:**
- ✅ **AHORA:** 
  - Aplica **FIFO en el origen**
  - **Mantiene el purchase_price** en el destino
  - Crea nuevo lote en destino con el costo promedio de lo transferido

---

## 📊 Cálculo de Ganancia en Ventas

### Cómo obtener la ganancia real

**Paso 1:** Registrar la venta (usando `movement_type: 'exit'`)

**Paso 2:** Consultar el movimiento creado

```bash
GET /api/movements?reference_id=<reference_id_de_la_venta>
```

**Paso 3:** Calcular ganancia

```javascript
// Datos del movimiento
const movement = {
  quantity: 50,
  unit_price: 20000,        // Costo promedio FIFO
  total_value: 1000000,     // Costo total (50 × 20000)
  meta: {
    total_purchase_cost: 1000000
  }
};

// Datos de la venta (lo que cobraste al cliente)
const venta = {
  quantity: 50,
  sale_price: 40000,        // Precio de venta al público
  total_sale: 2000000       // 50 × 40000
};

// Cálculo de ganancia
const ganancia = venta.total_sale - movement.total_value;  // 2000000 - 1000000 = 1000000
const margenGanancia = (ganancia / venta.total_sale) * 100; // (1000000 / 2000000) * 100 = 50%
```

---

## 🆕 Nuevos Endpoints / Métodos en el Repository

### `WarehouseProductVariantRepository`

```javascript
// Obtener todos los lotes de una variante (FIFO order)
const lots = await WarehouseProductVariantRepository.findAllLotsByVariantAndWarehouse(
  variantId,
  warehouseProductId
);
// Retorna: [{ id, purchase_price, stock, createdAt, ... }]

// Obtener stock total (suma de todos los lotes)
const stockInfo = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
  variantId,
  warehouseProductId
);
// Retorna: { total_stock: 150, avg_purchase_price: 23333.33 }

// Obtener un lote específico por ID
const lot = await WarehouseProductVariantRepository.findLotById(lotId);

// Obtener todos los lotes con detalles para UI
const lots = await WarehouseProductVariantRepository.findAllLotsWithDetails(warehouseProductId);
```

---

## ⚠️ Consideraciones Importantes para el Frontend

### 1. **Mostrar Stock Total**

El stock que ve el usuario debe ser la **suma de todos los lotes activos**:

```javascript
// ANTES (incorrecto)
const stock = warehouseVariant.stock;

// AHORA (correcto)
const totalStock = warehouseVariants
  .filter(v => v.active && v.stock > 0)
  .reduce((sum, v) => sum + v.stock, 0);
```

### 2. **Mostrar Precio de Compra Promedio**

Para mostrar el "costo actual" del producto:

```javascript
const avgPurchasePrice = warehouseVariants
  .filter(v => v.active && v.stock > 0)
  .reduce((sum, v) => sum + (v.purchase_price * v.stock), 0) / totalStock;
```

### 3. **UI de Gestión de Lotes (Opcional pero recomendado)**

Se recomienda crear una vista para ver lotes individuales:

```
Producto: Zapatillas Nike Air
┌─────────────────────────────────────────┐
│ Lote 1 | Compra: $20,000 | Stock: 50   │
│ Lote 2 | Compra: $25,000 | Stock: 100  │
├─────────────────────────────────────────┤
│ TOTAL  | Costo Prom: $23,333 | Stock: 150 │
└─────────────────────────────────────────┘
```

### 4. **Reporte de Ganancias**

Para calcular ganancias por venta:

```javascript
// Consultar movimientos de salida
const movements = await fetch('/api/movements', {
  movement_type: 'exit',
  date_from: '2026-03-01',
  date_to: '2026-03-31'
});

// Para cada movimiento
movements.forEach(movement => {
  const costoTotal = movement.total_value;  // 💰 Costo FIFO
  const ventaTotal = obtenerVentaTotal(movement.reference_id); // Lo que cobraste
  const ganancia = ventaTotal - costoTotal;
  const margen = (ganancia / ventaTotal) * 100;
  
  console.log(`Venta ${movement.reference_id}: Ganancia $${ganancia} (${margen}%)`);
});
```

### 5. **Valor del Inventario**

El nuevo campo `totalInventoryValue` en el resumen permite:

```javascript
// En dashboard de inventario
const summary = await fetch('/api/warehouse-metadata');

console.log(`Valor total del inventario: $${summary.sumary.totalInventoryValue}`);
// Esto es lo que te costaría reponer todo el stock al precio de compra actual
```

### 6. **Nuevos Campos en Variantes**

```typescript
interface WarehouseVariant {
  id: number;
  variant_id: number;
  price: number;
  purchase_price: number;      // ⭐ NUEVO
  promotional_price?: number;  // ⭐ NUEVO
  stock: number;
  active: boolean;
  createdAt: string;           // ⭐ NUEVO - Importante para FIFO
}
```

---

## 🧪 Pruebas Recomendadas

### 1. Prueba de Entrada (Compra) - Producto sin variantes

```bash
# Compra 1: 100 unidades a $20,000 (sin variant_id, usa price como purchase_price)
POST /api/movements
{
  "movement_type": "entry",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [
    {
      "quantity": 100,
      "price": 20000
    }
  ],
  "reason": "Compra prueba"
}

# Verificar que se creó variante por defecto
POST /api/warehouse-product-user-company
{
  "warehouse_id": 1
}
# Debe retornar 1 variante con purchase_price: 20000

# Verificar movimiento creado
GET /api/movements?reference_id=<id_de_la_compra>
# meta debe incluir: { lot_created: true, lot_id: X, purchase_price: 20000 }
```

### 2. Prueba de Entrada (Compra) - Con purchase_price separado

```bash
# Compra 1: 100 unidades con purchase_price y price separados
POST /api/movements
{
  "movement_type": "entry",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [
    {
      "variant_id": 5,
      "quantity": 100,
      "purchase_price": 20000,    // 💰 Campo separado para precio de compra
      "price": 35000              // 💰 Campo separado para precio de venta
    }
  ],
  "reason": "Compra prueba"
}

# Verificar movimiento
GET /api/movements?reference_id=<id>
# meta: { lot_created: true, lot_id: X, purchase_price: 20000, sale_price: 35000 }
```

### 3. Prueba de Entrada (Compra) - Producto con variantes (múltiples lotes)

```bash
# Compra 1: 100 unidades a $20,000
POST /api/movements
{
  "movement_type": "entry",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [
    {
      "variant_id": 5,
      "quantity": 100,
      "purchase_price": 20000,
      "price": 35000
    }
  ],
  "reason": "Compra prueba 1"
}

# Compra 2: 100 unidades a $25,000 (mismo producto, diferente precio)
POST /api/movements
{
  "movement_type": "entry",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [
    {
      "variant_id": 5,
      "quantity": 100,
      "purchase_price": 25000,
      "price": 40000
    }
  ],
  "reason": "Segunda compra"
}

# Verificar que hay 2 lotes
POST /api/warehouse-product-user-company
{
  "warehouse_id": 1
}
# Debe retornar 2 warehouseVariants para la misma variante
# Lote 1: purchase_price: 20000, stock: 100, createdAt: "2026-03-16..."
# Lote 2: purchase_price: 25000, stock: 100, createdAt: "2026-03-16..."
```

### 4. Prueba de Salida (Venta con FIFO)

```bash
# Venta: 50 unidades (debe usar el lote de $20,000 - FIFO)
POST /api/movements
{
  "movement_type": "exit",
  "origin_warehouse_id": 1,
  "product_id": 10,
  "variants": [
    {
      "variant_id": 5,
      "quantity": 50
    }
  ],
  "reason": "Venta prueba"
}

# Verificar movimiento
GET /api/movements?reference_id=<id_de_la_venta>

# En la respuesta:
{
  "movement_type": "exit",
  "quantity": 50,
  "unit_price": 20000,
  "total_value": 1000000,        // 💰 Costo FIFO real
  "meta": {
    "fifo_calculation": true,
    "lots_used": [
      {
        "lotId": 1,
        "quantityUsed": 50,
        "purchasePrice": 20000
      }
    ],
    "total_purchase_cost": 1000000
  }
}
```

### 5. Prueba de Transferencia

```bash
# Transferir 30 unidades
POST /api/movements
{
  "movement_type": "transfer",
  "origin_warehouse_id": 1,
  "destination_warehouse_id": 2,
  "product_id": 10,
  "variants": [
    {
      "variant_id": 5,
      "quantity": 30
    }
  ],
  "reason": "Traslado entre almacenes"
}

# Verificar destino
POST /api/warehouse-product-user-company
{
  "warehouse_id": 2
}
# El nuevo lote debe tener purchase_price: 20000 (o promedio si usa múltiples lotes)

# Verificar movimientos
GET /api/movements?reference_id=<id_transferencia>
# Debe haber 2 movimientos: transfer_exit y transfer_entry
# Ambos con total_value: 600000 (30 × 20000)
```

---

## 📝 Migración de Datos Existentes

Para los registros existentes que no tienen `purchase_price`:

```sql
-- Opción 1: Igualar purchase_price al price actual
UPDATE warehouse_product_variants 
SET purchase_price = price 
WHERE purchase_price = 0;

-- Opción 2: Asignar un valor por defecto
UPDATE warehouse_product_variants 
SET purchase_price = price * 0.7  -- Asumiendo 30% de margen
WHERE purchase_price = 0;
```

**⚠️ IMPORTANTE:** Ejecutar esto **después** de aplicar las migraciones.

---

## 🔧 Pasos para Sincronizar el Frontend

### 1. Aplicar migraciones en la base de datos

```bash
cd api-spree
npx sequelize-cli db:migrate
```

### 2. Actualizar modelos/types en el frontend

```typescript
// warehouse-variant.model.ts
export interface WarehouseProductVariant {
  id: number;
  warehouse_product_id: number;
  variant_id: number;
  price: number;
  purchase_price: number;  // ⭐ NUEVO
  promotional_price?: number;
  stock: number;
  active: boolean;
  published: boolean;
  local_sku?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 3. Actualizar componentes de stock

- Donde se muestre stock, asegurar que se **sumen todos los lotes**
- Donde se muestre costo, calcular el **promedio ponderado**

### 4. Actualizar reportes de ventas

- Incluir campo `total_value` de `inventory_movements` como costo
- Calcular ganancia: `venta_total - total_value`

---

## ❓ Preguntas Frecuentes

### ¿Qué pasa si vendo más stock del que hay en el primer lote?

El sistema automáticamente continúa con el siguiente lote más antiguo (FIFO):

```
Lote 1: 50 unidades a $20,000
Lote 2: 100 unidades a $25,000

Venta: 70 unidades
→ 50 del Lote 1 ($20,000 c/u)
→ 20 del Lote 2 ($25,000 c/u)
Costo total: (50×20000) + (20×25000) = 1,000,000 + 500,000 = 1,500,000
Costo promedio: 1,500,000 / 70 = $21,428.57
```

### ¿Puedo seleccionar manualmente qué lote vender?

Actualmente no. El sistema usa **FIFO automático**. Si necesitas selección manual, se puede implementar un endpoint adicional que reciba `lot_id` específico.

### ¿Los datos históricos se ven afectados?

No. Los movimientos anteriores mantienen sus valores originales. Solo los **nuevos movimientos** usarán el sistema de lotes.

---

## 📞 Soporte

Para dudas o problemas con la implementación:
- Revisar los logs del backend para detalles de errores
- Verificar que las migraciones se aplicaron correctamente
- Consultar la tabla `inventory_movements.meta` para ver el detalle de cálculos FIFO
