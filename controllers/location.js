const { validateLocation } = require('../utils/googleLocationService');
const axios = require('axios');
const { Country, State, City } = require('country-state-city');

const getCountries = async (request, reply) => {
  const data = Country.getAllCountries().map(c => ({ name: c.name, iso2: c.isoCode }));
  return reply.send({ success: true, data });
};

const getStates = async (request, reply) => {
  const { ciso } = request.params;
  const data = State.getStatesOfCountry(ciso).map(s => ({ name: s.name, iso2: s.isoCode }));
  return reply.send({ success: true, data });
};

const getCities = async (request, reply) => {
  const { ciso, siso } = request.params;
  const data = City.getCitiesOfState(ciso, siso).map(c => ({ name: c.name }));
  return reply.send({ success: true, data });
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
