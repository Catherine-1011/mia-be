const axios = require('axios');

async function validateLocation(mapboxId) {
  const accessToken = process.env.MAPBOX_ACCESS_TOKEN;

  if (!accessToken) {
    console.error('❌ MAPBOX_ACCESS_TOKEN not configured');
    return { valid: false, reason: 'API key not configured', details: null };
  }

  try {
    console.log('🔍 Validating mapbox_id:', mapboxId);

    const encodedId = encodeURIComponent(mapboxId);
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodedId}.json`;

    const response = await axios.get(url, {
      params: { access_token: accessToken }
    });

    const features = response.data.features;
    if (!features || features.length === 0) {
      return { valid: false, reason: 'Location not found', details: null };
    }

    const feature = features[0];
    const context = feature.context || [];

    console.log('📍 Place name:', feature.place_name);
    console.log('🗺️ Context:', JSON.stringify(context, null, 2));

    const countryCtx = context.find(c => c.id.startsWith('country'));
    const regionCtx = context.find(c => c.id.startsWith('region'));

    const isAustralia = countryCtx?.short_code === 'au';
    const isNT = regionCtx?.short_code === 'AU-NT';

    console.log('✅ Is Australia:', isAustralia);
    console.log('✅ Is NT:', isNT);

    if (!isAustralia) {
      return {
        valid: false,
        reason: 'Location is not in Australia',
        formattedAddress: feature.place_name
      };
    }

    if (!isNT) {
      const stateName = regionCtx?.text || 'Unknown State';
      console.log('⚠️ Location is in:', stateName);
      return {
        valid: false,
        reason: `Location is in ${stateName}, not Northern Territory`,
        formattedAddress: feature.place_name,
        state: stateName
      };
    }

    console.log('✅ Location verified in Northern Territory');

    return {
      valid: true,
      reason: 'Location verified in Northern Territory',
      formattedAddress: feature.place_name,
      location: {
        lat: feature.geometry.coordinates[1],
        lng: feature.geometry.coordinates[0]
      },
      mapboxId: feature.id
    };

  } catch (error) {
    console.error('❌ Mapbox Geocoding API Error:', error.message);
    return { valid: false, reason: 'API request failed', details: error.message };
  }
}

module.exports = { validateLocation };
