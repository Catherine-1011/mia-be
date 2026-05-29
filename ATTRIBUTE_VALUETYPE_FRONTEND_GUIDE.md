    # Attribute valueType Frontend Guide

    ## What Changed

    The `Attribute` object now includes a `valueType` field:

    ```json
    {
    "id": "clx...",
    "name": "size",
    "displayName": "Size",
    "valueType": "text",     // ← NEW: "text" | "number"
    "isRequired": false,
    "values": [
        { "id": "...", "value": "S", "displayValue": "S", "hexColor": null },
        { "id": "...", "value": "M", "displayValue": "M", "hexColor": null }
    ]
    }
    ```

    | `valueType` | Example values | Use for |
    |---|---|---|
    | `"text"` | S, M, L, XL | Clothing sizes |
    | `"number"` | 6, 7, 8, 9, 10 | Shoe sizes |
    | `"text"` (default) | Red, Blue | Color — unchanged |

    ---

    ## 1. Fetching Attributes

    **Endpoint:** `GET /api/attributes`

    **Response:**
    ```json
    {
    "success": true,
    "attributes": [
        {
        "id": "...",
        "name": "color",
        "displayName": "Color",
        "valueType": "text",
        "values": [
            { "id": "...", "value": "Red", "displayValue": "Red", "hexColor": "#FF0000" }
        ]
        },
        {
        "id": "...",
        "name": "size",
        "displayName": "Size",
        "valueType": "text",
        "values": [
            { "id": "...", "value": "S", "displayValue": "S", "hexColor": null },
            { "id": "...", "value": "M", "displayValue": "M", "hexColor": null },
            { "id": "...", "value": "L", "displayValue": "L", "hexColor": null }
        ]
        }
    ]
    }
    ```

    ---

    ## 2. Rendering Size Selector

    Use `valueType` to decide how to display size options:

    ```tsx
    function AttributeSelector({ attribute, selected, onChange }) {
    const isColor = attribute.name === 'color';
    const isNumberSize = attribute.valueType === 'number';

    if (isColor) {
        // Render color swatches (existing behaviour)
        return (
        <div className="flex gap-2">
            {attribute.values.map(val => (
            <button
                key={val.id}
                onClick={() => onChange(val.id)}
                style={{ backgroundColor: val.hexColor }}
                className={`w-8 h-8 rounded-full border-2 ${selected === val.id ? 'border-black' : 'border-transparent'}`}
                title={val.displayValue}
            />
            ))}
        </div>
        );
    }

    if (isNumberSize) {
        // Render number size chips — sorted numerically
        const sorted = [...attribute.values].sort((a, b) => Number(a.value) - Number(b.value));
        return (
        <div className="flex gap-2 flex-wrap">
            {sorted.map(val => (
            <button
                key={val.id}
                onClick={() => onChange(val.id)}
                className={`px-3 py-1 border rounded text-sm font-mono
                ${selected === val.id ? 'bg-black text-white border-black' : 'border-gray-300 hover:border-black'}`}
            >
                {val.displayValue}
            </button>
            ))}
        </div>
        );
    }

    // Default: text size chips (S / M / L / XL)
    return (
        <div className="flex gap-2 flex-wrap">
        {attribute.values.map(val => (
            <button
            key={val.id}
            onClick={() => onChange(val.id)}
            className={`px-3 py-1 border rounded text-sm uppercase
                ${selected === val.id ? 'bg-black text-white border-black' : 'border-gray-300 hover:border-black'}`}
            >
            {val.displayValue}
            </button>
        ))}
        </div>
    );
    }
    ```

    ---

    ## 3. Product Page — Variant Selection

    ```tsx
    // State: one selected attributeValueId per attribute name
    const [selectedAttributes, setSelectedAttributes] = useState({});
    // e.g. { color: "clx_red_id", size: "clx_M_id" }

    function handleAttributeChange(attributeName, valueId) {
    setSelectedAttributes(prev => ({ ...prev, [attributeName]: valueId }));
    }

    // Find matching variant from selected attributes
    function getSelectedVariant(variants, selectedAttributes) {
    return variants.find(variant =>
        variant.variantAttributeValues.every(vav =>
        selectedAttributes[vav.attributeValue.attribute.name] === vav.attributeValueId
        )
    ) || null;
    }

    const selectedVariant = getSelectedVariant(product.variants, selectedAttributes);
    ```

    ---

    ## 4. Admin — Creating/Updating an Attribute with valueType

    ### Create a number-type size attribute (e.g. shoe sizes)
    ```
    POST /api/attributes
    Authorization: Bearer <admin_token>

    {
    "name": "shoe_size",
    "displayName": "Shoe Size",
    "valueType": "number",
    "values": [
        { "value": "6",  "displayValue": "6" },
        { "value": "7",  "displayValue": "7" },
        { "value": "8",  "displayValue": "8" },
        { "value": "9",  "displayValue": "9" },
        { "value": "10", "displayValue": "10" },
        { "value": "11", "displayValue": "11" }
    ]
    }
    ```

    ### Create a text-type size attribute (e.g. clothing)
    ```
    POST /api/attributes
    Authorization: Bearer <admin_token>

    {
    "name": "size",
    "displayName": "Size",
    "valueType": "text",
    "values": [
        { "value": "XS", "displayValue": "XS" },
        { "value": "S",  "displayValue": "S"  },
        { "value": "M",  "displayValue": "M"  },
        { "value": "L",  "displayValue": "L"  },
        { "value": "XL", "displayValue": "XL" }
    ]
    }
    ```

    ### Update an existing attribute's valueType
    ```
    PUT /api/attributes/:id
    Authorization: Bearer <admin_token>

    {
    "valueType": "number"
    }
    ```

    ---

    ## 5. Cart & Order — No Changes Needed

    The cart and order APIs already use `variantId` — the `valueType` only affects how the frontend **displays** the selector. The underlying IDs passed to cart/order endpoints are the same `attributeValueId` strings regardless of `valueType`.

    Cart add item stays the same:
    ```json
    POST /api/cart/add
    {
    "productId": "...",
    "variantId": "...",   ← same as before
    "quantity": 1
    }
    ```

    ---

    ## 6. Displaying variant info in Order History

    The variant title already includes attribute names and values, e.g.:
    ```
    "T-Shirt (Size: M, Color: Red)"
    "Running Shoe (Shoe Size: 9, Color: Black)"
    ```

    No change needed on the order history display — the backend builds this string automatically.
