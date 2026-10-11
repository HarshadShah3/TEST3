import { regionalProfiles } from '../data/regions.js';
import { queryAiven } from '../database/aivenClient.js';

const maximumRegions = 4;
const projectionYear = 2036;
const profilesById = new Map(regionalProfiles.map(region => [region.id, region]));

export class ForecastRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForecastRequestError';
  }
}

export function parseForecastRegionIds(value) {
  const requested = Array.isArray(value) ? value : String(value ?? '').split(',');
  const regionIds = [...new Set(requested.map(id => id.trim()).filter(Boolean))];
  if (!regionIds.length) throw new ForecastRequestError('Choose at least one region.');
  if (regionIds.length > maximumRegions) {
    throw new ForecastRequestError(`Choose no more than ${maximumRegions} regions.`);
  }
  const invalid = regionIds.filter(id => !profilesById.has(id));
  if (invalid.length) throw new ForecastRequestError(`Unknown Victorian region: ${invalid[0]}.`);
  return regionIds;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function projectionPoint(row, key) {
  return {
    year: Number(row.referenceYear),
    value: finiteNumber(row[key]),
    confidenceLow: null,
    confidenceHigh: null,
  };
}

function indicator(id, category, label, unit, baseline, projected, status = 'available') {
  return { id, category, label, unit, baseline, projected, status };
}

export function buildForecastResponse(regionIds, databaseRows) {
  const rowsByCode = new Map();
  for (const row of databaseRows) {
    const code = String(row.lgaCode);
    const year = Number(row.referenceYear);
    const byYear = rowsByCode.get(code) ?? new Map();
    if (!byYear.has(year)) byYear.set(year, row);
    rowsByCode.set(code, byYear);
  }

  const data = regionIds.map(regionId => {
    const profile = profilesById.get(regionId);
    const databaseCode = profile.lgaCode.replace(/^LGA/i, '');
    const rows = [...(rowsByCode.get(databaseCode)?.values() ?? [])]
      .sort((first, second) => Number(first.referenceYear) - Number(second.referenceYear));
    const baseline = rows.find(row => Number(row.referenceYear) === 2021) ?? rows[0] ?? null;
    const projected = rows.find(row => Number(row.referenceYear) === projectionYear) ?? null;
    const available = Boolean(projected);

    return {
      region: { id: profile.id, name: profile.name, state: profile.state },
      baselineYear: baseline ? Number(baseline.referenceYear) : null,
      projectionYear,
      scenario: 'published-vif-projection',
      dataStatus: available ? 'available' : 'unavailable',
      series: {
        population: rows.map(row => projectionPoint(row, 'population')),
        households: rows.map(row => projectionPoint(row, 'households')),
        dwellings: rows.map(row => projectionPoint(row, 'dwellings')),
        housingCost: [],
        employment: [],
        services: [],
        climate: [],
      },
      indicators: [
        indicator('population', 'Demography', 'Population', 'people', finiteNumber(baseline?.population), finiteNumber(projected?.population), available ? 'available' : 'unavailable'),
        indicator('households', 'Demography', 'Households', 'households', finiteNumber(baseline?.households), finiteNumber(projected?.households), available ? 'available' : 'unavailable'),
        indicator('dwellings', 'Housing', 'Dwellings', 'dwellings', finiteNumber(baseline?.dwellings), finiteNumber(projected?.dwellings), available ? 'available' : 'unavailable'),
        indicator('schools', 'Services', 'Schools', 'schools', null, null, 'unavailable'),
      ],
    };
  });

  const firstSource = databaseRows[0] ?? {};
  return {
    data,
    meta: {
      count: data.length,
      source: 'aiven-mysql',
      provider: firstSource.provider ?? 'Victoria in Future (VIF)',
      dataset: firstSource.datasetName ?? 'VIF LGA housing projections',
      datasetVersion: firstSource.datasetVersion ?? null,
      projectionYear,
      scenario: 'published-vif-projection',
      methodologyVersion: null,
      generatedAt: null,
      isForecastBackendConnected: true,
      limitations: [
        'The latest verified population and housing projection horizon is 2036, not 2050.',
        'School counts are unavailable because the current Aiven MySQL schema contains no verified education table.',
        'The published VIF series does not provide confidence intervals in the imported source.',
      ],
    },
  };
}

export async function getRegionalForecasts(value, query = queryAiven) {
  const regionIds = parseForecastRegionIds(value);
  const codes = regionIds.map(id => profilesById.get(id).lgaCode.replace(/^LGA/i, ''));
  const placeholders = codes.map(() => '?').join(',');
  const rows = await query(
    `SELECT
       ga.area_code AS lgaCode,
       ga.area_name AS lgaName,
       php.reference_year AS referenceYear,
       php.estimated_resident_population AS population,
       php.total_households AS households,
       php.total_dwellings AS dwellings,
       php.observation_status AS observationStatus,
       ds.provider,
       ds.dataset_name AS datasetName,
       ds.dataset_version AS datasetVersion,
       php.source_id AS sourceId
     FROM geographic_area AS ga
     JOIN population_housing_projection AS php ON php.area_id = ga.area_id
     JOIN data_source AS ds ON ds.source_id = php.source_id
     WHERE ga.area_type = 'LGA'
       AND ga.state_code = 'VIC'
       AND ga.area_code IN (${placeholders})
       AND php.reference_year IN (2021, 2026, 2031, 2036)
       AND php.data_status IN ('REPORTED', 'ESTIMATED')
     ORDER BY ga.area_code, php.reference_year, php.source_id DESC`,
    codes,
  );
  return buildForecastResponse(regionIds, rows);
}
