# Dynamic Address Frontend Implementation Guide

This guide explains how to implement the Shopify-style dynamic address fields (Country > State > City) in the frontend application using the newly added backend APIs.

## Overview

The backend now acts as a secure proxy to the `countrystatecity.in` API, exposing three new endpoints:
1. `GET /api/location/countries` - Returns all countries.
2. `GET /api/location/countries/:ciso/states` - Returns states for a specific country (using ISO2 code).
3. `GET /api/location/countries/:ciso/states/:siso/cities` - Returns cities for a specific state (using ISO2 codes).

## Frontend Requirements

You need to replace standard text inputs for Country, State, and City with **Cascading Dropdowns**.

### 1. State Management
You will need to maintain both the list of options to display and the selected values.
Keep track of the ISO codes separately from the display names. The ISO codes are required to fetch the dependent data from the API, while the names should be saved to your database to maintain backward compatibility.

```javascript
// Dropdown Data
const [countries, setCountries] = useState([]);
const [states, setStates] = useState([]);
const [cities, setCities] = useState([]);

// Selected ISO Codes (For API calls)
const [selectedCountryCode, setSelectedCountryCode] = useState("");
const [selectedStateCode, setSelectedStateCode] = useState("");

// Actual Form Data (To be sent to your database)
const [formData, setFormData] = useState({
  addressLine1: "",
  country: "",  // Store Name, e.g., "India"
  state: "",    // Store Name, e.g., "Maharashtra"
  city: "",     // Store Name, e.g., "Mumbai"
  zipCode: ""
});
```

### 2. Dynamic Label Mapping
To provide a localized, Shopify-like experience, map labels based on the selected country code.

```javascript
const addressTerminology = {
  AU: { state: "State/Territory", city: "Suburb" },
  US: { state: "State", city: "City" },
  CA: { state: "Province", city: "City" },
  GB: { state: "County", city: "Town/City" },
  IN: { state: "State", city: "City" },
  default: { state: "State/Province", city: "City" }
};

const labels = addressTerminology[selectedCountryCode] || addressTerminology.default;
```

### 3. API Integration & Event Handlers

Fetch data sequentially. When a parent dropdown changes, its children must be reset.

```javascript
import { useEffect } from 'react';
import axios from 'axios';

// 1. Initial Load: Fetch Countries
useEffect(() => {
  const fetchCountries = async () => {
    try {
      const { data } = await axios.get('/api/location/countries');
      setCountries(data.data || []);
    } catch (error) {
      console.error("Failed to fetch countries", error);
    }
  };
  fetchCountries();
}, []);

// 2. Handle Country Change
const handleCountryChange = async (e) => {
  const iso2 = e.target.value;
  const countryName = e.target.options[e.target.selectedIndex].text;
  
  setSelectedCountryCode(iso2);
  
  // Important: Update DB model with Name, reset state/city
  setFormData(prev => ({ ...prev, country: countryName, state: "", city: "" }));
  setStates([]);
  setCities([]);

  if (!iso2) return;

  try {
    const { data } = await axios.get(`/api/location/countries/${iso2}/states`);
    setStates(data.data || []);
  } catch (error) {
    console.error("Failed to fetch states", error);
  }
};

// 3. Handle State Change
const handleStateChange = async (e) => {
  const iso2 = e.target.value;
  const stateName = e.target.options[e.target.selectedIndex].text;
  
  setSelectedStateCode(iso2);
  
  // Update DB model with Name, reset city
  setFormData(prev => ({ ...prev, state: stateName, city: "" }));
  setCities([]);

  if (!iso2 || !selectedCountryCode) return;

  try {
    const { data } = await axios.get(`/api/location/countries/${selectedCountryCode}/states/${iso2}/cities`);
    setCities(data.data || []);
  } catch (error) {
    console.error("Failed to fetch cities", error);
  }
};

// 4. Handle City Change
const handleCityChange = (e) => {
  const cityName = e.target.value;
  setFormData(prev => ({ ...prev, city: cityName }));
};

// 5. Initialize Google Places Autocomplete (Restricted by Selected Country)
const addressInputRef = useRef(null);

useEffect(() => {
  if (!window.google || !addressInputRef.current) return;

  const autocomplete = new window.google.maps.places.Autocomplete(addressInputRef.current, {
    types: ['address'],
    // Optional: Restrict Google Autocomplete to the selected country
    componentRestrictions: selectedCountryCode ? { country: selectedCountryCode.toLowerCase() } : undefined,
  });

  autocomplete.addListener('place_changed', () => {
    const place = autocomplete.getPlace();
    if (place?.formatted_address) {
      setFormData(prev => ({ ...prev, address: place.formatted_address }));
    }
  });

  // Cleanup
  return () => {
    window.google.maps.event.clearInstanceListeners(autocomplete);
  };
}, [selectedCountryCode]); // Re-initialize if the country changes to update componentRestrictions
```

### 4. UI Implementation (React/Next.js Example)

```jsx
<div className="address-form-container">
  {/* Country Dropdown */}
  <div className="form-group">
    <label>Country/Region <span className="text-red-500">*</span></label>
    <select value={selectedCountryCode} onChange={handleCountryChange} required className={inputNormal}>
      <option value="">Select Country</option>
      {countries.map(c => (
         <option key={c.iso2} value={c.iso2}>{c.name}</option>
      ))}
    </select>
  </div>

  {/* State Dropdown - Only show if states exist */}
  {states.length > 0 && (
    <div className="form-group">
      <label>{labels.state} <span className="text-red-500">*</span></label>
      <select value={selectedStateCode} onChange={handleStateChange} required className={inputNormal}>
        <option value="">Select {labels.state}</option>
        {states.map(s => (
           <option key={s.iso2} value={s.iso2}>{s.name}</option>
        ))}
      </select>
    </div>
  )}

  {/* City / Suburb Dropdown */}
  {cities.length > 0 ? (
    <div className="form-group">
      <label>{labels.city} <span className="text-red-500">*</span></label>
      <select value={formData.city} onChange={handleCityChange} required className={inputNormal}>
         <option value="">Select {labels.city}</option>
         {cities.map(c => (
           <option key={c.name} value={c.name}>{c.name}</option> 
         ))}
      </select>
    </div>
  ) : (
    selectedStateCode && (
      <div className="form-group">
        <label>{labels.city} <span className="text-red-500">*</span></label>
        <input 
          type="text" 
          value={formData.city} 
          onChange={(e) => setFormData(prev => ({ ...prev, city: e.target.value }))}
          placeholder={`Enter your ${labels.city}`}
          className={inputNormal}
          required 
        />
      </div>
    )
  )}

  {/* Google Places Street Address (Should be placed AFTER Country/State/City to utilize the selected country restriction) */}
  <div className="flex flex-col gap-1.5 relative mt-4">
    <label htmlFor="address" className="text-sm font-medium text-gray-600">
      Street Address <span className="text-red-500">*</span>
    </label>
    <input
      ref={addressInputRef}
      id="address"
      name="address"
      type="text"
      value={formData.address}
      onChange={(e) => setFormData(prev => ({ ...prev, address: e.target.value }))}
      placeholder={formData.city ? `Start typing street address in ${formData.city}...` : "Please select Country, State, and City first"}
      className={inputNormal}
      disabled={!selectedCountryCode} // Disable until they select a country
      required
    />
    {formData.city && (
      <p className="text-xs text-gray-400 mt-1">
        Type to search street addresses in {formData.city}
      </p>
    )}
  </div>
</div>
```

## Key Considerations
- **Data Integrity:** Your Prisma database currently expects Strings for `city`, `state`, and `country`. Always save `country.name` to `formData.country` instead of the `iso2` code.
- **Fail-safes:** The code above includes a fallback text `<input>` for the city field if the external API does not return cities for a particular state. This prevents users from getting stuck during checkout.