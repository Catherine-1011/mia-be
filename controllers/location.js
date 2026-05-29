const { validateLocation } = require('../utils/googleLocationService');
const axios = require('axios');

const COUNTRY_API_HEADERS = {
  'X-CSCAPI-KEY': process.env.COUNTRY_STATE_CITY_API_KEY
};

// In-memory cache to prevent hitting the 100 req/day API limit!
const locationCache = {
  countries: null,
  states: {},
  cities: {}
};

const getCountries = async (request, reply) => {
  try {
    if (locationCache.countries) {
      return reply.send({ success: true, data: locationCache.countries });
    }
    const { data } = await axios.get('https://api.countrystatecity.in/v1/countries', {
      headers: COUNTRY_API_HEADERS
    });
    locationCache.countries = data; // Save to cache
    return reply.send({ success: true, data });
  } catch (error) {
    console.error('❌ Error fetching countries:', error?.response?.data || error.message);
    return reply.code(500).send({ success: false, message: 'Failed to fetch countries' });
  }
};

const getStates = async (request, reply) => {
  const { ciso } = request.params;
  try {
    if (locationCache.states[ciso]) {
      return reply.send({ success: true, data: locationCache.states[ciso] });
    }
    const { data } = await axios.get(`https://api.countrystatecity.in/v1/countries/${ciso}/states`, {
      headers: COUNTRY_API_HEADERS
    });
    locationCache.states[ciso] = data; // Save to cache
    return reply.send({ success: true, data });
  } catch (error) {
    console.error('❌ Error fetching states:', error?.response?.data || error.message);
    return reply.code(500).send({ success: false, message: 'Failed to fetch states' });
  }
};

const getCities = async (request, reply) => {
  const { ciso, siso } = request.params;
  const cacheKey = `${ciso}-${siso}`;
  try {
    if (locationCache.cities[cacheKey]) {
      return reply.send({ success: true, data: locationCache.cities[cacheKey] });
    }
    const { data } = await axios.get(`https://api.countrystatecity.in/v1/countries/${ciso}/states/${siso}/cities`, {
      headers: COUNTRY_API_HEADERS
    });
    locationCache.cities[cacheKey] = data; // Save to cache
    return reply.send({ success: true, data });
  } catch (error) {
    console.error('❌ Error fetching cities:', error?.response?.data || error.message);
    return reply.code(500).send({ success: false, message: 'Failed to fetch cities' });
  }
};

// Backend: Accept place_id and validate via Geocoding API
const validate = async (request, reply) => {
  const { place_id } = request.body;

  if (!place_id) {
    return reply.code(400).send({
      success: false,
      message: 'place_id is required'
    });
  }

//   console.log('🚀 Starting location validation for place_id:', place_id);

  try {
    // Use the utility function for validation
    const result = await validateLocation(place_id);

    // If validation failed or not in NT → manual_review
    if (!result.valid) {
      console.log('⚠️ Validation failed:', result.reason);
      return reply.send({
        success: true,
        status: 'manual_review',
        message: result.reason || 'Location could not be verified automatically. Will be reviewed manually.',
        formattedAddress: result.formattedAddress,
        place_id
      });
    }

    // Location verified in NT
    console.log('✅ Location validated successfully');
    return reply.send({
      success: true,
      status: 'verified',
      message: 'Location verified in Northern Territory',
      formattedAddress: result.formattedAddress,
      lat: result.location.lat,
      lng: result.location.lng,
      place_id
    });

  } catch (error) {
    console.error('❌ Location validation error:', error);
    // Even on error, allow with manual review
    return reply.send({
      success: true,
      status: 'manual_review',
      message: 'Location validation failed. Will be reviewed manually.',
      place_id
    });
  }
};

const autocomplete = async (request, reply) => {
  const { input } = request.query;

  if (!input) {
    return reply.code(400).send({
      success: false,
      message: 'input parameter is required'
    });
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json`;
    const { data } = await axios.get(url, {
      params: {
        input: input,
        key: process.env.GOOGLE_MAPS_API_KEY,
        components: 'country:au', // Restrict to Australia
        types: 'geocode' // Only return addresses
      }
    });

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      return reply.send({
        success: false,
        message: 'Autocomplete service error',
        predictions: []
      });
    }

    const predictions = data.predictions.map(p => ({
      placeId: p.place_id,
      description: p.description,
      mainText: p.structured_formatting?.main_text || '',
      secondaryText: p.structured_formatting?.secondary_text || ''
    }));

    return reply.send({
      success: true,
      predictions
    });

  } catch (error) {
    console.error('❌ Autocomplete error:', error);
    reply.code(500).send({
      success: false,
      message: 'Autocomplete failed',
      predictions: []
    });
  }
};

module.exports = { validate, autocomplete, getCountries, getStates, getCities };
