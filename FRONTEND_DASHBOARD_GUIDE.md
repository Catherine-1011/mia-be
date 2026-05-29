# Frontend Dashboard Implementation Guide

## Overview
This guide covers implementing a frontend dashboard for the marketplace backend with SIMPLE and VARIABLE product support.

## Table of Contents
- [API Integration](#api-integration)
- [Dashboard Components](#dashboard-components)
- [Product Management](#product-management)
- [Attribute System](#attribute-system)
- [Example Implementations](#example-implementations)
- [State Management](#state-management)

---

## API Integration

### Base Configuration
```javascript
const API_BASE = 'http://localhost:3000/api';

const apiClient = {
  get: async (endpoint) => {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'Authorization': `Bearer ${getAuthToken()}` }
    });
    return response.json();
  },
  
  post: async (endpoint, data) => {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`
      },
      body: JSON.stringify(data)
    });
    return response.json();
  }
};
```

### Core API Endpoints

#### Products API
```javascript
// Get all products with pagination and filters
GET /api/products?page=1&limit=10&type=VARIABLE&category=Electronics

// Get single product with variants
GET /api/products/:productId

// Create new product (SIMPLE or VARIABLE)
POST /api/products

// Update existing product
PUT /api/products/:productId

// Delete product
DELETE /api/products/:productId
```

#### Attributes API
```javascript
// Get all attributes with values (public)
GET /api/attributes

// Admin: Create new attribute
POST /api/attributes

// Admin: Update attribute
PUT /api/attributes/:attributeId

// Admin: Delete attribute
DELETE /api/attributes/:attributeId
```

---

## Dashboard Components

### 1. Main Dashboard Layout

```jsx
// React Example
import React, { useState, useEffect } from 'react';

const MarketplaceDashboard = () => {
  const [activeTab, setActiveTab] = useState('products');
  const [stats, setStats] = useState({});

  useEffect(() => {
    loadDashboardStats();
  }, []);

  const loadDashboardStats = async () => {
    const data = await apiClient.get('/dashboard/stats');
    setStats(data);
  };

  return (
    <div className="dashboard-container">
      <nav className="dashboard-nav">
        <button 
          className={activeTab === 'products' ? 'active' : ''}
          onClick={() => setActiveTab('products')}
        >
          Products ({stats.totalProducts || 0})
        </button>
        <button 
          className={activeTab === 'attributes' ? 'active' : ''}
          onClick={() => setActiveTab('attributes')}
        >
          Attributes
        </button>
        <button 
          className={activeTab === 'analytics' ? 'active' : ''}
          onClick={() => setActiveTab('analytics')}
        >
          Analytics
        </button>
      </nav>

      <main className="dashboard-content">
        {activeTab === 'products' && <ProductManagement />}
        {activeTab === 'attributes' && <AttributeManagement />}
        {activeTab === 'analytics' && <Analytics />}
      </main>
    </div>
  );
};
```

### 2. Product Management Component

```jsx
const ProductManagement = () => {
  const [products, setProducts] = useState([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [productType, setProductType] = useState('SIMPLE');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadProducts();
  }, []);

  const loadProducts = async () => {
    setLoading(true);
    try {
      const response = await apiClient.get('/products?limit=50');
      setProducts(response.products);
    } catch (error) {
      console.error('Failed to load products:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="product-management">
      <div className="header">
        <h2>Product Management</h2>
        <button 
          className="btn-primary"
          onClick={() => setShowAddModal(true)}
        >
          Add New Product
        </button>
      </div>

      {loading ? (
        <div className="loading">Loading products...</div>
      ) : (
        <ProductTable 
          products={products} 
          onEdit={handleEditProduct}
          onDelete={handleDeleteProduct}
        />
      )}

      {showAddModal && (
        <ProductModal
          type={productType}
          onClose={() => setShowAddModal(false)}
          onSave={handleSaveProduct}
        />
      )}
    </div>
  );
};
```

### 3. Product Table Component

```jsx
const ProductTable = ({ products, onEdit, onDelete }) => {
  return (
    <table className="product-table">
      <thead>
        <tr>
          <th>Product</th>
          <th>Type</th>
          <th>Price</th>
          <th>Stock</th>
          <th>Variants</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {products.map(product => (
          <tr key={product.id}>
            <td>
              <div className="product-info">
                <img 
                  src={product.images?.[0] || '/placeholder.jpg'} 
                  alt={product.title}
                  className="product-thumb"
                />
                <div>
                  <h4>{product.title}</h4>
                  <p className="product-sku">SKU: {product.sku}</p>
                </div>
              </div>
            </td>
            <td>
              <span className={`badge badge-${product.type.toLowerCase()}`}>
                {product.type}
              </span>
            </td>
            <td>
              {product.type === 'SIMPLE' 
                ? `$${product.price}`
                : `$${getVariantPriceRange(product.variants)}`
              }
            </td>
            <td>
              {product.type === 'SIMPLE'
                ? product.stock
                : getTotalVariantStock(product.variants)
              }
            </td>
            <td>
              {product.type === 'VARIABLE' 
                ? `${product.variants?.length || 0} variants`
                : '-'
              }
            </td>
            <td>
              <span className={`status ${product.isActive ? 'active' : 'inactive'}`}>
                {product.isActive ? 'Active' : 'Inactive'}
              </span>
            </td>
            <td>
              <button onClick={() => onEdit(product)} className="btn-edit">
                Edit
              </button>
              <button onClick={() => onDelete(product.id)} className="btn-delete">
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// Helper functions
const getVariantPriceRange = (variants) => {
  if (!variants?.length) return '0';
  const prices = variants.map(v => parseFloat(v.price));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? min.toString() : `${min} - ${max}`;
};

const getTotalVariantStock = (variants) => {
  if (!variants?.length) return 0;
  return variants.reduce((total, variant) => total + variant.stock, 0);
};
```

---

## Product Management

### 1. Product Creation Modal

```jsx
const ProductModal = ({ type, product, onClose, onSave }) => {
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    type: type || 'SIMPLE',
    category: '',
    weight: '',
    price: '', // For SIMPLE products
    stock: '', // For SIMPLE products
    variants: [] // For VARIABLE products
  });
  
  const [attributes, setAttributes] = useState([]);
  const [selectedAttributes, setSelectedAttributes] = useState({});

  useEffect(() => {
    loadAttributes();
    if (product) {
      setFormData({ ...product });
    }
  }, [product]);

  const loadAttributes = async () => {
    const response = await apiClient.get('/attributes');
    setAttributes(response.attributes);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      let productData = { ...formData };
      
      if (formData.type === 'VARIABLE') {
        // Ensure variants are properly formatted
        productData.variants = formData.variants.map(variant => ({
          ...variant,
          price: parseFloat(variant.price),
          stock: parseInt(variant.stock)
        }));
      } else {
        // For SIMPLE products, convert price and stock
        productData.price = parseFloat(formData.price);
        productData.stock = parseInt(formData.stock);
      }

      const endpoint = product ? `/products/${product.id}` : '/products';
      const method = product ? 'PUT' : 'POST';
      
      await apiClient[method.toLowerCase()](endpoint, productData);
      onSave();
      onClose();
    } catch (error) {
      console.error('Failed to save product:', error);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content product-modal">
        <div className="modal-header">
          <h3>{product ? 'Edit Product' : 'Add New Product'}</h3>
          <button onClick={onClose} className="modal-close">×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-section">
            <h4>Basic Information</h4>
            
            <div className="form-group">
              <label>Product Type</label>
              <select 
                value={formData.type}
                onChange={(e) => setFormData({...formData, type: e.target.value})}
                disabled={!!product} // Can't change type after creation
              >
                <option value="SIMPLE">Simple Product</option>
                <option value="VARIABLE">Variable Product</option>
              </select>
            </div>

            <div className="form-group">
              <label>Title</label>
              <input 
                type="text"
                value={formData.title}
                onChange={(e) => setFormData({...formData, title: e.target.value})}
                required
              />
            </div>

            <div className="form-group">
              <label>Description</label>
              <textarea 
                value={formData.description}
                onChange={(e) => setFormData({...formData, description: e.target.value})}
                rows={4}
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Category</label>
                <input 
                  type="text"
                  value={formData.category}
                  onChange={(e) => setFormData({...formData, category: e.target.value})}
                />
              </div>
              
              <div className="form-group">
                <label>Weight (kg)</label>
                <input 
                  type="number"
                  step="0.01"
                  value={formData.weight}
                  onChange={(e) => setFormData({...formData, weight: e.target.value})}
                />
              </div>
            </div>
          </div>

          {formData.type === 'SIMPLE' && (
            <SimpleProductFields 
              formData={formData}
              setFormData={setFormData}
            />
          )}

          {formData.type === 'VARIABLE' && (
            <VariableProductFields 
              formData={formData}
              setFormData={setFormData}
              attributes={attributes}
            />
          )}

          <div className="modal-footer">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              {product ? 'Update Product' : 'Create Product'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
```

### 2. Simple Product Fields

```jsx
const SimpleProductFields = ({ formData, setFormData }) => {
  return (
    <div className="form-section">
      <h4>Pricing & Inventory</h4>
      
      <div className="form-row">
        <div className="form-group">
          <label>Price ($)</label>
          <input 
            type="number"
            step="0.01"
            value={formData.price}
            onChange={(e) => setFormData({...formData, price: e.target.value})}
            required
          />
        </div>
        
        <div className="form-group">
          <label>Stock Quantity</label>
          <input 
            type="number"
            value={formData.stock}
            onChange={(e) => setFormData({...formData, stock: e.target.value})}
            required
          />
        </div>
      </div>
    </div>
  );
};
```

### 3. Variable Product Fields

```jsx
const VariableProductFields = ({ formData, setFormData, attributes }) => {
  const [newVariant, setNewVariant] = useState({
    price: '',
    stock: '',
    sku: '',
    attributes: {}
  });

  const addVariant = () => {
    if (!newVariant.price || !newVariant.stock) {
      alert('Please fill in all variant fields');
      return;
    }

    const updatedVariants = [...(formData.variants || []), { ...newVariant }];
    setFormData({ ...formData, variants: updatedVariants });
    
    // Reset form
    setNewVariant({
      price: '',
      stock: '',
      sku: '',
      attributes: {}
    });
  };

  const removeVariant = (index) => {
    const updatedVariants = formData.variants.filter((_, i) => i !== index);
    setFormData({ ...formData, variants: updatedVariants });
  };

  const updateVariantAttribute = (attributeName, value) => {
    setNewVariant({
      ...newVariant,
      attributes: {
        ...newVariant.attributes,
        [attributeName]: value
      }
    });
  };

  return (
    <div className="form-section">
      <h4>Product Variants</h4>
      
      {/* Existing Variants */}
      {formData.variants?.length > 0 && (
        <div className="existing-variants">
          <h5>Current Variants</h5>
          {formData.variants.map((variant, index) => (
            <div key={index} className="variant-item">
              <div className="variant-info">
                <span className="variant-attributes">
                  {Object.entries(variant.attributes || {}).map(([key, value]) => (
                    <span key={key} className="attribute-badge">
                      {key}: {value}
                    </span>
                  ))}
                </span>
                <span className="variant-details">
                  ${variant.price} | Stock: {variant.stock} | SKU: {variant.sku}
                </span>
              </div>
              <button 
                type="button"
                onClick={() => removeVariant(index)}
                className="btn-remove"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add New Variant */}
      <div className="add-variant">
        <h5>Add New Variant</h5>
        
        {/* Attribute Selection */}
        <div className="attribute-selection">
          {attributes.map(attribute => (
            <div key={attribute.id} className="form-group">
              <label>{attribute.name}</label>
              <select 
                value={newVariant.attributes[attribute.name] || ''}
                onChange={(e) => updateVariantAttribute(attribute.name, e.target.value)}
              >
                <option value="">Select {attribute.name}</option>
                {attribute.values?.map(value => (
                  <option key={value.id} value={value.value}>
                    {value.displayName || value.value}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {/* Variant Details */}
        <div className="form-row">
          <div className="form-group">
            <label>Price ($)</label>
            <input 
              type="number"
              step="0.01"
              value={newVariant.price}
              onChange={(e) => setNewVariant({...newVariant, price: e.target.value})}
              placeholder="25.99"
            />
          </div>
          
          <div className="form-group">
            <label>Stock</label>
            <input 
              type="number"
              value={newVariant.stock}
              onChange={(e) => setNewVariant({...newVariant, stock: e.target.value})}
              placeholder="10"
            />
          </div>
          
          <div className="form-group">
            <label>SKU</label>
            <input 
              type="text"
              value={newVariant.sku}
              onChange={(e) => setNewVariant({...newVariant, sku: e.target.value})}
              placeholder="PRODUCT-RED-L"
            />
          </div>
        </div>

        <button 
          type="button" 
          onClick={addVariant}
          className="btn-add-variant"
        >
          Add Variant
        </button>
      </div>
    </div>
  );
};
```

---

## Attribute System

### Attribute Management Component

```jsx
const AttributeManagement = () => {
  const [attributes, setAttributes] = useState([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingAttribute, setEditingAttribute] = useState(null);

  useEffect(() => {
    loadAttributes();
  }, []);

  const loadAttributes = async () => {
    try {
      const response = await apiClient.get('/attributes');
      setAttributes(response.attributes);
    } catch (error) {
      console.error('Failed to load attributes:', error);
    }
  };

  const handleSaveAttribute = async (attributeData) => {
    try {
      if (editingAttribute) {
        await apiClient.put(`/attributes/${editingAttribute.id}`, attributeData);
      } else {
        await apiClient.post('/attributes', attributeData);
      }
      
      loadAttributes();
      setShowAddModal(false);
      setEditingAttribute(null);
    } catch (error) {
      console.error('Failed to save attribute:', error);
    }
  };

  const handleDeleteAttribute = async (attributeId) => {
    if (confirm('Are you sure? This will affect all products using this attribute.')) {
      try {
        await apiClient.delete(`/attributes/${attributeId}`);
        loadAttributes();
      } catch (error) {
        console.error('Failed to delete attribute:', error);
      }
    }
  };

  return (
    <div className="attribute-management">
      <div className="header">
        <h2>Attribute Management</h2>
        <button 
          className="btn-primary"
          onClick={() => setShowAddModal(true)}
        >
          Add New Attribute
        </button>
      </div>

      <div className="attributes-grid">
        {attributes.map(attribute => (
          <div key={attribute.id} className="attribute-card">
            <div className="attribute-header">
              <h3>{attribute.name}</h3>
              <div className="attribute-actions">
                <button 
                  onClick={() => {
                    setEditingAttribute(attribute);
                    setShowAddModal(true);
                  }}
                  className="btn-edit-sm"
                >
                  Edit
                </button>
                <button 
                  onClick={() => handleDeleteAttribute(attribute.id)}
                  className="btn-delete-sm"
                >
                  Delete
                </button>
              </div>
            </div>
            
            <div className="attribute-values">
              <h4>Values ({attribute.values?.length || 0})</h4>
              <div className="values-list">
                {attribute.values?.map(value => (
                  <span key={value.id} className="value-badge">
                    {value.displayName || value.value}
                    {value.hexCode && (
                      <span 
                        className="color-preview"
                        style={{ backgroundColor: value.hexCode }}
                      ></span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {showAddModal && (
        <AttributeModal
          attribute={editingAttribute}
          onClose={() => {
            setShowAddModal(false);
            setEditingAttribute(null);
          }}
          onSave={handleSaveAttribute}
        />
      )}
    </div>
  );
};
```

---

## State Management

### Using React Context

```jsx
// ProductContext.js
import React, { createContext, useContext, useReducer } from 'react';

const ProductContext = createContext();

const initialState = {
  products: [],
  attributes: [],
  currentProduct: null,
  loading: false,
  error: null
};

const productReducer = (state, action) => {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    
    case 'SET_PRODUCTS':
      return { ...state, products: action.payload, loading: false };
    
    case 'SET_ATTRIBUTES':
      return { ...state, attributes: action.payload };
    
    case 'ADD_PRODUCT':
      return { 
        ...state, 
        products: [...state.products, action.payload] 
      };
    
    case 'UPDATE_PRODUCT':
      return {
        ...state,
        products: state.products.map(p => 
          p.id === action.payload.id ? action.payload : p
        )
      };
    
    case 'DELETE_PRODUCT':
      return {
        ...state,
        products: state.products.filter(p => p.id !== action.payload)
      };
    
    case 'SET_ERROR':
      return { ...state, error: action.payload, loading: false };
    
    default:
      return state;
  }
};

export const ProductProvider = ({ children }) => {
  const [state, dispatch] = useReducer(productReducer, initialState);

  const actions = {
    loadProducts: async () => {
      dispatch({ type: 'SET_LOADING', payload: true });
      try {
        const response = await apiClient.get('/products');
        dispatch({ type: 'SET_PRODUCTS', payload: response.products });
      } catch (error) {
        dispatch({ type: 'SET_ERROR', payload: error.message });
      }
    },

    loadAttributes: async () => {
      try {
        const response = await apiClient.get('/attributes');
        dispatch({ type: 'SET_ATTRIBUTES', payload: response.attributes });
      } catch (error) {
        console.error('Failed to load attributes:', error);
      }
    },

    createProduct: async (productData) => {
      try {
        const response = await apiClient.post('/products', productData);
        dispatch({ type: 'ADD_PRODUCT', payload: response.product });
        return response;
      } catch (error) {
        dispatch({ type: 'SET_ERROR', payload: error.message });
        throw error;
      }
    },

    updateProduct: async (productId, productData) => {
      try {
        const response = await apiClient.put(`/products/${productId}`, productData);
        dispatch({ type: 'UPDATE_PRODUCT', payload: response.product });
        return response;
      } catch (error) {
        dispatch({ type: 'SET_ERROR', payload: error.message });
        throw error;
      }
    },

    deleteProduct: async (productId) => {
      try {
        await apiClient.delete(`/products/${productId}`);
        dispatch({ type: 'DELETE_PRODUCT', payload: productId });
      } catch (error) {
        dispatch({ type: 'SET_ERROR', payload: error.message });
        throw error;
      }
    }
  };

  return (
    <ProductContext.Provider value={{ ...state, ...actions }}>
      {children}
    </ProductContext.Provider>
  );
};

export const useProducts = () => {
  const context = useContext(ProductContext);
  if (!context) {
    throw new Error('useProducts must be used within ProductProvider');
  }
  return context;
};
```

---

## Example Implementations

### Complete Dashboard Setup

```jsx
// App.js
import React from 'react';
import { ProductProvider } from './contexts/ProductContext';
import MarketplaceDashboard from './components/MarketplaceDashboard';
import './styles/dashboard.css';

function App() {
  return (
    <ProductProvider>
      <div className="App">
        <MarketplaceDashboard />
      </div>
    </ProductProvider>
  );
}

export default App;
```

### CSS Styles

```css
/* dashboard.css */
.dashboard-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f5f5f5;
}

.dashboard-nav {
  display: flex;
  background: white;
  border-bottom: 1px solid #e0e0e0;
  padding: 0 20px;
}

.dashboard-nav button {
  padding: 15px 20px;
  border: none;
  background: none;
  border-bottom: 3px solid transparent;
  cursor: pointer;
  font-weight: 500;
}

.dashboard-nav button.active {
  border-bottom-color: #007cba;
  color: #007cba;
}

.dashboard-content {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}

.product-table {
  width: 100%;
  background: white;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.product-table th,
.product-table td {
  padding: 12px 15px;
  text-align: left;
  border-bottom: 1px solid #e0e0e0;
}

.product-table th {
  background: #f8f9fa;
  font-weight: 600;
}

.product-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.product-thumb {
  width: 40px;
  height: 40px;
  border-radius: 4px;
  object-fit: cover;
}

.badge {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}

.badge-simple {
  background: #e3f2fd;
  color: #1976d2;
}

.badge-variable {
  background: #f3e5f5;
  color: #7b1fa2;
}

.status.active {
  color: #2e7d32;
}

.status.inactive {
  color: #d32f2f;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: white;
  padding: 0;
  border-radius: 8px;
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
  max-width: 800px;
  max-height: 90vh;
  overflow-y: auto;
  width: 90%;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px;
  border-bottom: 1px solid #e0e0e0;
}

.modal-close {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: #666;
}

.form-section {
  padding: 20px;
  border-bottom: 1px solid #e0e0e0;
}

.form-group {
  margin-bottom: 15px;
}

.form-group label {
  display: block;
  margin-bottom: 5px;
  font-weight: 500;
}

.form-group input,
.form-group select,
.form-group textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px;
}

.variant-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px;
  background: #f8f9fa;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  margin-bottom: 8px;
}

.attribute-badge {
  display: inline-block;
  padding: 2px 6px;
  background: #e1f5fe;
  color: #0277bd;
  border-radius: 3px;
  font-size: 0.75rem;
  margin-right: 5px;
}

.btn-primary {
  background: #007cba;
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}

.btn-secondary {
  background: #f5f5f5;
  color: #333;
  border: 1px solid #ddd;
  padding: 10px 20px;
  border-radius: 4px;
  cursor: pointer;
}

.btn-edit {
  background: #ff9800;
  color: white;
  border: none;
  padding: 6px 12px;
  border-radius: 3px;
  font-size: 0.875rem;
  cursor: pointer;
  margin-right: 5px;
}

.btn-delete {
  background: #f44336;
  color: white;
  border: none;
  padding: 6px 12px;
  border-radius: 3px;
  font-size: 0.875rem;
  cursor: pointer;
}
```

---

## Integration Checklist

### ✅ Backend Ready
- [x] SIMPLE and VARIABLE product types
- [x] Normalized attribute system
- [x] SKU validation and uniqueness
- [x] Stock management for both types
- [x] API endpoints for CRUD operations

### 🚀 Frontend Implementation
- [ ] Set up API client with authentication
- [ ] Create product management dashboard
- [ ] Implement attribute management interface
- [ ] Add product creation/editing modals
- [ ] Handle SIMPLE vs VARIABLE product flows
- [ ] Implement stock management
- [ ] Add image upload functionality
- [ ] Create analytics/reporting views

### 🎨 UI/UX Considerations
- [ ] Responsive design for mobile/tablet
- [ ] Loading states and error handling
- [ ] Form validation with user feedback
- [ ] Bulk operations (bulk edit, bulk delete)
- [ ] Search and filtering capabilities
- [ ] Export/import functionality

---

This guide provides a complete foundation for implementing your marketplace dashboard. The examples are in React, but the concepts apply to any frontend framework (Vue, Angular, etc.). Adapt the code to match your specific tech stack and design requirements.