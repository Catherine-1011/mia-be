const axios = require('axios');

async function validateLocation(placeId) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  
  if (!apiKey) {
    console.error('❌ GOOGLE_MAPS_API_KEY not configured');
    return {
      valid: false,
      reason: 'API key not configured',
      details: null
    };
  }

  try {
    console.log('🔍 Validating place_id:', placeId);
    console.log('🔑 Using API key:', apiKey.substring(0, 10) + '...');
    
    const url = `https://maps.googleapis.com/maps/api/geocode/json`;
    
    const response = await axios.get(url, {
      params: {
        place_id: placeId,
        key: apiKey
      }
    });
    
    console.log('📡 Google API Status:', response.data.status);
    
    if (response.data.status !== 'OK') {
      console.error('❌ Google API Error:', response.data.status);
      if (response.data.error_message) {
        console.error('❌ Error Message:', response.data.error_message);
      }
      
      // Provide specific troubleshooting for REQUEST_DENIED
      if (response.data.status === 'REQUEST_DENIED') {
        console.error('');
        console.error('🔧 TROUBLESHOOTING REQUEST_DENIED:');
        console.error('1. Go to: https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com');
        console.error('2. Make sure "Geocoding API" is ENABLED');
        console.error('3. Go to: https://console.cloud.google.com/apis/credentials');
        console.error('4. Check your API key restrictions:');
        console.error('   - Remove IP restrictions for testing (set to "None")');
        console.error('   - Or add your current IP address');
        console.error('5. Make sure billing is enabled on your Google Cloud project');
        console.error('');
      }
      
      return {
        valid: false,
        reason: `Google API error: ${response.data.status}`,
        details: response.data.error_message || null
      };
    }

    const result = response.data.results[0];
    const addressComponents = result.address_components;
    
    console.log('📍 Formatted Address:', result.formatted_address);
    console.log('🗺️ Address Components:', JSON.stringify(addressComponents, null, 2));

    // Check if in Northern Territory
    const hasNT = addressComponents.some(component => 
      component.types.includes('administrative_area_level_1') && 
      (component.short_name === 'NT' || component.long_name === 'Northern Territory')
    );

    // Check if in Australia
    const hasAustralia = addressComponents.some(component =>
      component.types.includes('country') &&
      component.short_name === 'AU'
    );

    console.log('✅ Has Australia:', hasAustralia);
    console.log('✅ Has NT:', hasNT);

    if (!hasAustralia) {
      return {
        valid: false,
        reason: 'Location is not in Australia',
        formattedAddress: result.formatted_address
      };
    }

    if (!hasNT) {
      const state = addressComponents.find(c => 
        c.types.includes('administrative_area_level_1')
      )?.long_name || 'Unknown State';
      
      console.log('⚠️ Location is in:', state);
      
      return {
        valid: false,
        reason: `Location is in ${state}, not Northern Territory`,
        formattedAddress: result.formatted_address,
        state: state
      };
    }

    console.log('✅ Location verified in Northern Territory');
    
    return {
      valid: true,
      reason: 'Location verified in Northern Territory',
      formattedAddress: result.formatted_address,
      location: result.geometry.location,
      placeId: result.place_id
    };

  } catch (error) {
    console.error('❌ Geocoding API Error:', error.message);
    if (error.response) {
      console.error('❌ API Response Status:', error.response.status);
      console.error('❌ API Response Data:', error.response.data);
    }
    return {
      valid: false,
      reason: 'API request failed',
      details: error.message
    };
  }
}

module.exports = { validateLocation };
