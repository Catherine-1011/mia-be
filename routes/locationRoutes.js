const { validate, autocomplete, getCountries, getStates, getCities } = require('../controllers/location');
const { authenticateUser } = require('../middlewares/authMiddleware');

async function locationRoutes(fastify, options) {
  // Routes for dynamic country/state/city dropdowns
  fastify.get('/location/countries', getCountries);
  fastify.get('/location/countries/:ciso/states', getStates);
  fastify.get('/location/countries/:ciso/states/:siso/cities', getCities);

  // Frontend will use Google Places Autocomplete (client-side)
  // Backend endpoint: Validate place_id from frontend selection
  fastify.post(
    '/validate-location',
    {
      preHandler: [authenticateUser],
      schema: {
        body: {
          type: 'object',
          required: ['mapbox_id'],
          properties: {
            mapbox_id: {
              type: 'string',
              description: 'Mapbox feature ID from Mapbox Geocoding autocomplete'
            }
          }
        }
      }
    },
    validate
  );
}

module.exports = locationRoutes;
