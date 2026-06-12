const { validateLocation } = require('../utils/mapboxLocationService');
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

const validate = async (request, reply) => {
  const { mapbox_id } = request.body;

  if (!mapbox_id) {
    return reply.code(400).send({ success: false, message: 'mapbox_id is required' });
  }

  try {
    const result = await validateLocation(mapbox_id);

    if (!result.valid) {
      console.log('⚠️ Validation failed:', result.reason);
      return reply.send({
        success: true,
        status: 'manual_review',
        message: result.reason || 'Location could not be verified automatically. Will be reviewed manually.',
        formattedAddress: result.formattedAddress,
        mapbox_id
      });
    }

    console.log('✅ Location validated successfully');
    return reply.send({
      success: true,
      status: 'verified',
      message: 'Location verified in Northern Territory',
      formattedAddress: result.formattedAddress,
      lat: result.location.lat,
      lng: result.location.lng,
      mapbox_id
    });

  } catch (error) {
    console.error('❌ Location validation error:', error);
    return reply.send({
      success: true,
      status: 'manual_review',
      message: 'Location validation failed. Will be reviewed manually.',
      mapbox_id
    });
  }
};

const autocomplete = async (request, reply) => {
  const { input } = request.query;

  if (!input) {
    return reply.code(400).send({ success: false, message: 'input parameter is required' });
  }

  try {
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    const encoded = encodeURIComponent(input);
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json`;

    const { data } = await axios.get(url, {
      params: {
        access_token: accessToken,
        country: 'AU',
        types: 'address,place',
        autocomplete: true,
        limit: 5
      }
    });

    const predictions = (data.features || []).map(f => {
      const commaSplit = f.place_name.indexOf(',');
      const mainText = commaSplit !== -1 ? f.place_name.substring(0, commaSplit) : f.place_name;
      const secondaryText = commaSplit !== -1 ? f.place_name.substring(commaSplit + 2) : '';

      return {
        placeId: f.id,       // renamed mapbox_id kept as placeId for API compatibility
        mapboxId: f.id,
        description: f.place_name,
        mainText,
        secondaryText
      };
    });

    return reply.send({ success: true, predictions });

  } catch (error) {
    console.error('❌ Autocomplete error:', error);
    reply.code(500).send({ success: false, message: 'Autocomplete failed', predictions: [] });
  }
};

module.exports = { validate, autocomplete, getCountries, getStates, getCities };
