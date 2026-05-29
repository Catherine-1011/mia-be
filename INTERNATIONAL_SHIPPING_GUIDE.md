    # International Shipping — Frontend Integration Guide

    ## Overview

    Shipping is split into two modes depending on the customer's destination country:

    | Mode | When to use | How to identify |
    |---|---|---|
    | **Domestic** | Shipping to Australia | Show Standard / Express options |
    | **International** | Shipping to any other country | Show country selector → fetch zone rate |

    Australia Post zone pricing applies for international orders:

    | Zone | Region | Flat Rate (AUD) |
    |---|---|---|
    | Zone 1 | New Zealand | $49.10 |
    | Zone 2 | Asia Pacific | $75.55 |
    | Zone 3 | US & Canada | $84.35 |
    | Zone 4 | UK & Europe | $93.25 |
    | Zone 5 | Rest of World | $120.00 |

    > Countries not in the explicit list automatically fall back to **Zone 5 – Rest of World ($120.00)**.

    ---

    ## Recommended UI Flow

    ```
    User enters / selects shipping country
            │
            ├── "Australia"
            │       │
            │       └── GET /api/shipping/active
            │           Show Standard / Express radio buttons
            │           User selects one → store shippingMethodId
            │
            └── Any other country
                    │
                    └── Show country dropdown (populated from /api/shipping/international/zones)
                        On country change → GET /api/shipping/international/rate?country=<name>
                        Display: "International — $XX.XX (Zone N – Region)"
                        Estimated delivery: 10–20 business days
                        On checkout → pass internationalCountry in request body
    ```

    ---

    ## API Reference

    ### 1. Get Domestic Shipping Options (Australia only)

    ```
    GET /api/shipping/active
    ```

    No authentication required.

    **Response:**
    ```json
    {
    "success": true,
    "count": 2,
    "data": [
        {
        "id": "cm1abc123",
        "name": "Standard Shipping",
        "description": "3-7 business days",
        "cost": "9.95",
        "estimatedDays": "3-7 business days",
        "isActive": true
        },
        {
        "id": "cm1xyz456",
        "name": "Express Shipping",
        "description": "1-2 business days",
        "cost": "19.95",
        "estimatedDays": "1-2 business days",
        "isActive": true
        }
    ]
    }
    ```

    Use the `id` field as `shippingMethodId` when placing an order.

    ---

    ### 2. Get International Zones + Country List

    Use this to populate the **country selector dropdown** on the shipping page.

    ```
    GET /api/shipping/international/zones
    ```

    No authentication required.

    **Response:**
    ```json
    {
    "success": true,
    "data": [
        {
        "zone": "Zone 1",
        "label": "New Zealand",
        "cost": 49.10,
        "countries": ["New Zealand"]
        },
        {
        "zone": "Zone 2",
        "label": "Asia Pacific",
        "cost": 75.55,
        "countries": [
            "Bangladesh", "Bhutan", "Brunei", "Cambodia", "China",
            "Cook Islands", "East Timor", "Federated States of Micronesia",
            "Fiji", "French Polynesia", "Guam", "Hong Kong", "India",
            "Indonesia", "Japan", "Kiribati", "Laos", "Macau", "Malaysia",
            "Maldives", "Marshall Islands", "Myanmar", "Nauru", "Nepal",
            "New Caledonia", "Niue", "Northern Mariana Islands", "Pakistan",
            "Palau", "Papua New Guinea", "Philippines", "Samoa",
            "Singapore", "Solomon Islands", "South Korea", "Sri Lanka",
            "Taiwan", "Thailand", "Tonga", "Tuvalu", "Vanuatu", "Vietnam"
        ]
        },
        {
        "zone": "Zone 3",
        "label": "US & Canada",
        "cost": 84.35,
        "countries": ["Canada", "United States"]
        },
        {
        "zone": "Zone 4",
        "label": "UK & Europe",
        "cost": 93.25,
        "countries": [
            "Albania", "Andorra", "Armenia", "Austria", "Azerbaijan",
            "Belarus", "Belgium", "Bosnia and Herzegovina", "Bulgaria",
            "Croatia", "Cyprus", "Czech Republic", "Denmark", "Estonia",
            "Finland", "France", "Georgia", "Germany", "Greece", "Hungary",
            "Iceland", "Ireland", "Italy", "Kazakhstan", "Kosovo", "Latvia",
            "Liechtenstein", "Lithuania", "Luxembourg", "Malta", "Moldova",
            "Monaco", "Montenegro", "Netherlands", "North Macedonia",
            "Norway", "Poland", "Portugal", "Romania", "Russia",
            "San Marino", "Serbia", "Slovakia", "Slovenia", "Spain",
            "Sweden", "Switzerland", "Turkey", "Ukraine",
            "United Kingdom", "Vatican City"
        ]
        },
        {
        "zone": "Zone 5",
        "label": "Rest of World",
        "cost": 120.00,
        "countries": []
        }
    ]
    }
    ```

    > **Tip:** Flatten all zone `countries` arrays into one sorted list for the dropdown. When the user picks a country, call the rate endpoint below to get the exact cost. Zone 5 ("Rest of World") has an empty `countries` array — any country not found in Zones 1–4 is treated as Zone 5.

    ---

    ### 3. Get Shipping Rate for a Specific Country

    Call this whenever the user **changes their selected country** in the international dropdown.

    ```
    GET /api/shipping/international/rate?country=Japan
    ```

    No authentication required.

    **Query Parameters:**

    | Parameter | Required | Description |
    |---|---|---|
    | `country` | Yes | Country name as a string (e.g. `Japan`, `United States`) |

    **Success Response (200):**
    ```json
    {
    "success": true,
    "data": {
        "country": "Japan",
        "zone": "Zone 2",
        "zoneName": "Asia Pacific",
        "cost": 75.55,
        "name": "International",
        "estimatedDays": "10-20 business days",
        "description": "International shipping to Japan (Zone 2 – Asia Pacific)"
    }
    }
    ```

    **Error — Australia passed (400):**
    ```json
    {
    "success": false,
    "message": "Use standard or express shipping for Australia"
    }
    ```

    **Error — missing country (400):**
    ```json
    {
    "success": false,
    "message": "country query parameter is required"
    }
    ```

    > **Note:** Unknown countries return a **200** response with Zone 5 pricing ($120.00). There is no 404 for unrecognised countries.

    ---

    ## Placing an Order

    ### Domestic Order (Australia)

    Send `shippingMethodId` (the DB record ID from `/api/shipping/active`).

    **POST /api/orders** *(logged-in user)*
    **POST /api/orders/guest** *(guest checkout)*

    ```json
    {
    "shippingAddress": "123 Main Street",
    "paymentMethod": "STRIPE",
    "shippingMethodId": "cm1abc123",
    "gstId": "optional-gst-id",
    "country": "Australia",
    "city": "Sydney",
    "state": "NSW",
    "zipCode": "2000",
    "mobileNumber": "0412345678",
    "couponCode": "SAVE10"
    }
    ```

    ### International Order

    Send `internationalCountry` instead of `shippingMethodId`. **Do not send both.**

    The backend looks up the correct zone price server-side — never send the price from the frontend.

    **POST /api/orders** *(logged-in user)*
    **POST /api/orders/guest** *(guest checkout)*

    ```json
    {
    "shippingAddress": "1-2-3 Shibuya",
    "paymentMethod": "STRIPE",
    "internationalCountry": "Japan",
    "gstId": "optional-gst-id",
    "country": "Japan",
    "city": "Tokyo",
    "state": "Tokyo",
    "zipCode": "150-0002",
    "mobileNumber": "+81312345678",
    "couponCode": "SAVE10"
    }
    ```

    > For guest orders, also include `customerName`, `customerEmail`, and `customerPhone`.

    ### Validation Rules

    | Scenario | Result |
    |---|---|
    | Neither `shippingMethodId` nor `internationalCountry` provided | `400` error |
    | Both `shippingMethodId` and `internationalCountry` provided | `shippingMethodId` takes precedence (treated as domestic) |
    | `internationalCountry` = `"Australia"` | `400` error — use domestic flow |
    | Unknown country name | Zone 5 pricing applied automatically |

    ---

    ## Order Summary Display

    When showing the order summary before checkout, display the shipping line like this:

    **Domestic:**
    ```
    Standard Shipping (3-7 business days)   $9.95
    ```

    **International:**
    ```
    International Shipping                  $75.55
    Zone 2 – Asia Pacific · 10-20 business days
    ```

    The `description` field returned by `/api/shipping/international/rate` can be used directly as a subtitle line.

    ---

    ## Multi-Seller Shipping Behaviour

    When a cart contains products from **more than one seller**, the shipping rate is charged **separately per seller**. Each seller ships independently, so the customer pays the full shipping rate for each.

    ### How the total is calculated

    ```
    totalShipping = zoneRate × numberOfSellers
    grandTotal    = productSubtotal + totalShipping
    ```

    **Example — 2 sellers, Japan (Zone 2, $75.55 per seller):**

    | | Products | Shipping | Sub-total |
    |---|---|---|---|
    | Seller A | $120.00 | $75.55 | $195.55 |
    | Seller B | $80.00 | $75.55 | $155.55 |
    | **Order Total** | **$200.00** | **$151.10** | **$351.10** |

    This applies equally to domestic and international shipping.

    ### What to display in the cart / order summary

    Show the **per-seller shipping cost** alongside each seller's product group, and the **total shipping cost** in the order summary footer.

    ```
    ┌─────────────────────────────────────────┐
    │  Seller A                               │
    │  Blue T-Shirt × 1          $120.00      │
    │  International Shipping      $75.55     │
    │                             ────────    │
    │  Sub-total                 $195.55      │
    ├─────────────────────────────────────────┤
    │  Seller B                               │
    │  Red Sneakers × 1           $80.00      │
    │  International Shipping      $75.55     │
    │                             ────────    │
    │  Sub-total                 $155.55      │
    ├─────────────────────────────────────────┤
    │  Products                  $200.00      │
    │  Total Shipping            $151.10      │
    │  GST (included)             $18.18      │
    │                             ────────    │
    │  ORDER TOTAL               $351.10      │
    └─────────────────────────────────────────┘
    ```

    > The `shippingCost` field in the API response is the **per-seller rate**.
    > The `totalShippingCost` field is `shippingCost × sellerCount`.

    ### Fields returned in the order response

    ```json
    "orderSummary": {
      "shippingCost": "75.55",        ← per-seller rate (use for each seller group)
      "totalShippingCost": "151.10",  ← total across all sellers (use in footer)
      "sellerCount": 2,
      "shippingMethod": {
        "name": "International",
        "cost": 75.55,
        "estimatedDays": "10-20 business days",
        "zone": "Zone 2",
        "zoneName": "Asia Pacific",
        "country": "Japan"
      }
    }
    ```

    ---

    ## Quick Reference

    | Action | Endpoint |
    |---|---|
    | Get domestic options (AU) | `GET /api/shipping/active` |
    | Get all zones + country lists | `GET /api/shipping/international/zones` |
    | Get rate for a country | `GET /api/shipping/international/rate?country=<name>` |
    | Place order (logged-in) | `POST /api/orders` |
    | Place order (guest) | `POST /api/orders/guest` |
