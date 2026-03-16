# Image Cache Implementation

## Overview
The backend now implements HTTP cache headers for images to reduce server load and improve frontend performance.

## Backend Changes

### 1. Cache Headers in Routes (`routes.js`)
Both `/images/:foldername/:filename` and `/images-protect/:foldername/:filename` now return:

```http
Cache-Control: public, max-age=31536000, immutable
ETag: "mtimeMs-size"
Last-Modified: Wed, 13 Mar 2024 10:00:00 GMT
```

**Cache duration:** 1 year (31536000 seconds)

### 2. Image Version in Responses
All product-related endpoints now include image version information:

```json
{
  "products": [
    {
      "id": 1,
      "sku": "PROD-001",
      "images": ["products/abc123.jpg"],
      "images_with_version": [
        {
          "url": "products/abc123.jpg",
          "version": "1710345678901",
          "fullUrl": "/images/products/abc123.jpg?v=1710345678901"
        }
      ],
      "image_version": "1710345678901",
      "product_image_url": "/images/products/abc123.jpg?v=1710345678901"
    }
  ]
}
```

## Frontend Usage

### Recommended Pattern

```javascript
// When displaying product images
function ProductImage({ product }) {
  // Use the pre-built URL with version
  const imageUrl = product.product_image_url || 
                   product.images_with_version?.[0]?.fullUrl ||
                   `/images/products/${product.images?.[0]}?v=${product.image_version}`;
  
  return <img src={imageUrl} alt={product.name} />;
}
```

### Alternative: Build URL Manually

```javascript
// If you need to construct URLs dynamically
function buildImageUrl(imagePath, version) {
  const folder = imagePath.split('/')[0]; // e.g., 'products'
  const filename = imagePath.split('/').pop(); // e.g., 'abc123.jpg'
  return `/images/${folder}/${filename}?v=${version}`;
}

// Usage
const imageUrl = buildImageUrl(product.images[0], product.image_version);
```

### Cache Invalidation

When a product image is updated, the backend automatically generates a new version based on the file's modification time (mtime).

**Frontend doesn't need to do anything** - the browser will:
1. Use cached image if ETag/Last-Modified matches
2. Automatically load new image when version changes

### Example: Product List Component

```javascript
function ProductList({ products }) {
  return (
    <div className="product-grid">
      {products.map(product => (
        <div key={product.id} className="product-card">
          <img 
            src={product.product_image_url || '/images/products/default.jpg'} 
            alt={product.name}
            loading="lazy"
          />
          <h3>{product.name}</h3>
          <p>{product.sku}</p>
        </div>
      ))}
    </div>
  );
}
```

### Example: Image Gallery Component

```javascript
function ProductGallery({ product }) {
  return (
    <div className="gallery">
      {product.images_with_version?.map((img, index) => (
        <img 
          key={index}
          src={img.fullUrl}
          alt={`${product.name} - ${index + 1}`}
          className="gallery-thumbnail"
        />
      ))}
    </div>
  );
}
```

## Benefits

| Metric | Before | After |
|--------|--------|-------|
| Image requests (repeat visit) | 100% | ~0% (cached) |
| Page load time | Slower | Faster |
| Server bandwidth | High | Minimal |
| User experience | Good | Excellent |

## Browser Behavior

1. **First visit:** Browser downloads image and caches it
2. **Subsequent visits:** Browser uses cached image (no network request)
3. **After 1 year:** Browser revalidates with ETag/If-Modified-Since
4. **If image updated:** New version number forces fresh download

## Testing

Verify cache headers in browser DevTools:

```
Network Tab → Select image request → Response Headers:
- Cache-Control: public, max-age=31536000, immutable
- ETag: "1710345678901-12345"
- Last-Modified: Wed, 13 Mar 2024 10:00:00 GMT
```

## Troubleshooting

### Images not caching?
- Check browser cache is enabled
- Verify Cache-Control header is present
- Ensure no service worker interfering

### Old image showing after update?
- Check `image_version` changed in API response
- Verify file mtime updated on server
- Hard refresh browser (Ctrl+Shift+R)

### Protected images (/images-protect)?
- Same implementation, just use `/images-protect/` base path
- Authentication required before cache kicks in

## API Endpoints Updated

| Endpoint | Response Includes |
|----------|-------------------|
| `POST /product-user-company` | `products[].images_with_version`, `products[].image_version` |
| `POST /product` | `data.images_with_version`, `data.image_version` |
| `POST /warehouse-product-user-company` | `warehouse_products[].product_images_with_version` |
| `POST /warehouse-products-not-in-warehouse` | `products[].image_url`, `products[].image_version` |
| `POST /products-transform` | `products[].images_with_version` |

## Migration Guide

### Old Code (remove cache busting)
```javascript
// ❌ Remove manual cache busting
<img src={`/api/images/products/${image}?t=${Date.now()}`} />
```

### New Code (use backend version)
```javascript
// ✅ Use backend-provided version
<img src={product.product_image_url} />
```
