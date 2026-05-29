# Updated Product API Documentation

## GET /api/products/all

**Returns enhanced product data for both SIMPLE and VARIABLE products**

### SIMPLE Product Response:
```json
{
  "id": "product-123",
  "title": "Cotton T-Shirt",
  "type": "SIMPLE",
  "displayPrice": "$25.99",
  "totalStock": 50,
  "variantCount": 0,
  "productType": "SIMPLE",
  "featuredImage": "image-url",
  "avgRating": 4.5,
  "ratingCount": 12
}
```

### VARIABLE Product Response:
```json
{
  "id": "product-456", 
  "title": "Variable T-Shirt",
  "type": "VARIABLE",
  "displayPrice": "$20.00 - $35.00",
  "totalStock": 150,
  "variantCount": 6,
  "productType": "VARIABLE",
  "featuredImage": "image-url",
  "avgRating": 4.7,
  "ratingCount": 25
}
```

## GET /api/products/:id

**Returns complete product details including variants for VARIABLE products**

### VARIABLE Product with Variants:
```json
{
  "success": true,
  "product": {
    "id": "product-456",
    "title": "Variable T-Shirt",
    "type": "VARIABLE",
    "price": null,
    "stock": null,
    "variants": [
      {
        "id": "variant-123",
        "price": 25.00,
        "stock": 10,
        "sku": "TSHIRT-RED-M",
        "isActive": true,
        "images": [],
        "attributes": {
          "color": {
            "value": "Red",
            "displayValue": "Red",
            "hexColor": "#FF0000"
          },
          "size": {
            "value": "M",
            "displayValue": "Medium",
            "hexColor": null
          }
        }
      },
      {
        "id": "variant-124", 
        "price": 30.00,
        "stock": 5,
        "sku": "TSHIRT-BLUE-L",
        "isActive": true,
        "images": [],
        "attributes": {
          "color": {
            "value": "Blue",
            "displayValue": "Blue", 
            "hexColor": "#0000FF"
          },
          "size": {
            "value": "L",
            "displayValue": "Large",
            "hexColor": null
          }
        }
      }
    ]
  }
}
```

## GET /api/products/my-products

**Enhanced seller dashboard with variant information**

### Response for VARIABLE Product:
```json
{
  "id": "product-456",
  "title": "Variable T-Shirt", 
  "type": "VARIABLE",
  "displayPrice": "$20.00 - $35.00",
  "totalStock": 150,
  "productType": "VARIABLE",
  "status": "ACTIVE",
  "variantInfo": {
    "totalVariants": 6,
    "activeVariants": 6,
    "priceRange": "$20.00 - $35.00",
    "avgPrice": 27.50
  }
}
```

## GET /api/products/:id/variants

**Get all variants for a VARIABLE product with summary statistics**

### Response:
```json
{
  "success": true,
  "product": {
    "id": "product-456",
    "title": "Variable T-Shirt",
    "type": "VARIABLE",
    "isActive": true
  },
  "variants": [
    {
      "id": "variant-123",
      "productId": "product-456", 
      "price": 25.00,
      "stock": 10,
      "sku": "TSHIRT-RED-M",
      "isActive": true,
      "images": [],
      "attributes": {
        "color": {
          "value": "Red",
          "displayValue": "Red",
          "hexColor": "#FF0000"
        },
        "size": {
          "value": "M",
          "displayValue": "Medium",
          "hexColor": null
        }
      }
    }
  ],
  "summary": {
    "totalVariants": 6,
    "activeVariants": 6, 
    "totalStock": 150,
    "priceRange": {
      "min": 20.00,
      "max": 35.00
    }
  }
}
```

## GET /api/attributes

**Get all available attributes for creating VARIABLE products**

### Response:
```json
{
  "success": true,
  "attributes": [
    {
      "id": "attr-size",
      "name": "size",
      "displayName": "Size",
      "isRequired": false,
      "values": [
        {
          "id": "val-xs",
          "value": "XS",
          "displayValue": "Extra Small",
          "hexColor": null
        },
        {
          "id": "val-s",
          "value": "S", 
          "displayValue": "Small",
          "hexColor": null
        }
      ]
    },
    {
      "id": "attr-color",
      "name": "color",
      "displayName": "Color",
      "isRequired": false,
      "values": [
        {
          "id": "val-red",
          "value": "Red",
          "displayValue": "Red", 
          "hexColor": "#FF0000"
        },
        {
          "id": "val-blue",
          "value": "Blue",
          "displayValue": "Blue",
          "hexColor": "#0000FF"
        }
      ]
    }
  ]
}
```

## Key Changes

### 1. Enhanced Product Listing
- **displayPrice**: Shows single price for SIMPLE or price range for VARIABLE
- **totalStock**: Aggregated stock across all variants for VARIABLE products
- **variantCount**: Number of variants for VARIABLE products
- **productType**: Clear indication of SIMPLE vs VARIABLE

### 2. Detailed Product View
- **variants**: Complete variant information with attributes for VARIABLE products
- **attributes**: Normalized attribute structure with display values and hex colors
- **price/stock**: Null for VARIABLE products (use variant-level data)

### 3. Seller Dashboard
- **variantInfo**: Detailed variant statistics for VARIABLE products
- **priceRange**: Visual price range for seller reference
- **activeVariants**: Count of active vs total variants

### 4. New Endpoint
- **GET /products/:id/variants**: Dedicated endpoint for variant management
- **summary**: Quick statistics for frontend display
- **VARIABLE validation**: Only works for VARIABLE products

All endpoints now properly distinguish between SIMPLE and VARIABLE products and provide appropriate data for each type.