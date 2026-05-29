/**
 * International Shipping Zone Data
 *
 * Flat-rate prices (AUD) for shipping from Australia to international destinations.
 * Zone assignment follows Australia Post regional groupings.
 *
 * Zones:
 *   Zone 1 – New Zealand        $49.10
 *   Zone 2 – Asia Pacific       $75.55
 *   Zone 3 – US & Canada        $84.35
 *   Zone 4 – UK & Europe        $93.25
 *   Zone 5 – Rest of World     $120.00
 */

const INTERNATIONAL_ZONES = [
  {
    zone: 'Zone 1',
    label: 'New Zealand',
    cost: 49.10,
    countries: ['New Zealand']
  },
  {
    zone: 'Zone 2',
    label: 'Asia Pacific',
    cost: 75.55,
    countries: [
      'Japan', 'China', 'South Korea', 'Hong Kong', 'Taiwan', 'Macau',
      'Singapore', 'Malaysia', 'Thailand', 'Indonesia', 'Philippines',
      'Vietnam', 'Cambodia', 'Laos', 'Myanmar', 'Brunei', 'Bangladesh',
      'Sri Lanka', 'Nepal', 'Bhutan', 'Maldives', 'Papua New Guinea',
      'Fiji', 'Samoa', 'American Samoa', 'Tonga', 'Vanuatu',
      'Solomon Islands', 'Kiribati', 'Nauru', 'Tuvalu', 'Palau',
      'Marshall Islands', 'Federated States of Micronesia', 'Cook Islands',
      'Niue', 'French Polynesia', 'New Caledonia', 'Guam',
      'Northern Mariana Islands', 'East Timor', 'India', 'Pakistan'
    ]
  },
  {
    zone: 'Zone 3',
    label: 'US & Canada',
    cost: 84.35,
    countries: ['United States', 'Canada']
  },
  {
    zone: 'Zone 4',
    label: 'UK & Europe',
    cost: 93.25,
    countries: [
      'United Kingdom', 'Germany', 'France', 'Italy', 'Spain',
      'Netherlands', 'Belgium', 'Switzerland', 'Austria', 'Sweden',
      'Norway', 'Denmark', 'Finland', 'Portugal', 'Ireland', 'Poland',
      'Czech Republic', 'Hungary', 'Romania', 'Bulgaria', 'Greece',
      'Croatia', 'Slovakia', 'Slovenia', 'Estonia', 'Latvia', 'Lithuania',
      'Luxembourg', 'Malta', 'Cyprus', 'Iceland', 'Albania',
      'Bosnia and Herzegovina', 'Kosovo', 'North Macedonia', 'Montenegro',
      'Serbia', 'Moldova', 'Ukraine', 'Belarus', 'Russia', 'Turkey',
      'Georgia', 'Armenia', 'Azerbaijan', 'Kazakhstan', 'Liechtenstein',
      'Monaco', 'San Marino', 'Andorra', 'Vatican City'
    ]
  },
  {
    zone: 'Zone 5',
    label: 'Rest of World',
    cost: 120.00,
    countries: [] // catch-all — any country not listed above falls here
  }
];

// Quick lookup: lowercase country name → zone entry
const COUNTRY_ZONE_MAP = {};
INTERNATIONAL_ZONES.forEach(zoneEntry => {
  zoneEntry.countries.forEach(country => {
    COUNTRY_ZONE_MAP[country.toLowerCase()] = zoneEntry;
  });
});

/**
 * Look up the zone entry for a given country name.
 * Falls back to Zone 5 (Rest of World) for unknown countries.
 *
 * @param {string} country - Country name (case-insensitive)
 * @returns {{ zone, label, cost, countries }}
 */
function lookupZone(country) {
  const key = (country || '').trim().toLowerCase();
  return COUNTRY_ZONE_MAP[key] || INTERNATIONAL_ZONES[4];
}

module.exports = { INTERNATIONAL_ZONES, COUNTRY_ZONE_MAP, lookupZone };
