import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConfiguration } from '../src/database/aivenClient.js';
import { buildForecastResponse, getRegionalForecasts, parseForecastRegionIds } from '../src/services/forecastService.js';

const source = {
  provider: 'Victoria in Future (VIF)',
  datasetName: 'VIF LGA housing projections',
  datasetVersion: 'VIF 2023',
};

function row(lgaCode, referenceYear, population, households, dwellings) {
  return { lgaCode, referenceYear, population, households, dwellings, ...source };
}

test('validates and de-duplicates forecast region IDs', () => {
  assert.deepEqual(parseForecastRegionIds('ballarat,bendigo,ballarat'), ['ballarat', 'bendigo']);
  assert.throws(() => parseForecastRegionIds(''), /at least one/);
  assert.throws(() => parseForecastRegionIds('not-a-region'), /Unknown Victorian region/);
  assert.throws(() => parseForecastRegionIds('ballarat,bendigo,mildura,melton,moira'), /no more than 4/);
});

test('builds a 2021-2036 VIF forecast response without inventing confidence intervals', () => {
  const response = buildForecastResponse(['ballarat'], [
    row('20570', 2021, 110000, 45000, 50000),
    row('20570', 2026, 116000, 48000, 53000),
    row('20570', 2031, 123000, 51000, 57000),
    row('20570', 2036, 131000, 55000, 61000),
  ]);

  assert.equal(response.meta.source, 'aiven-mysql');
  assert.equal(response.meta.isForecastBackendConnected, true);
  assert.equal(response.meta.projectionYear, 2036);
  assert.equal(response.data[0].series.population.length, 4);
  assert.equal(response.data[0].series.population.at(-1).value, 131000);
  assert.equal(response.data[0].series.population.at(-1).confidenceLow, null);
  assert.equal(response.data[0].indicators.find(item => item.id === 'population').projected, 131000);
  assert.equal(response.data[0].indicators.find(item => item.id === 'schools').status, 'unavailable');
  assert.equal(response.data[0].indicators.find(item => item.id === 'schools').baseline, null);
});

test('queries only the selected LGA codes and the reviewed projection years', async () => {
  let captured;
  const query = async (sql, parameters) => {
    captured = { sql, parameters };
    return [
      row('20570', 2021, 110000, 45000, 50000),
      row('20570', 2036, 131000, 55000, 61000),
      row('22620', 2021, 121000, 49000, 55000),
      row('22620', 2036, 150000, 62000, 69000),
    ];
  };

  const response = await getRegionalForecasts(['ballarat', 'bendigo'], query);
  assert.deepEqual(captured.parameters, ['20570', '22620']);
  assert.match(captured.sql, /php\.reference_year IN \(2021, 2026, 2031, 2036\)/);
  assert.deepEqual(response.data.map(item => item.region.id), ['ballarat', 'bendigo']);
});

test('reports an invalid CA path as an incomplete database configuration', () => {
  const configuration = databaseConfiguration({
    DB_HOST: 'example.aivencloud.com',
    DB_PORT: '27679',
    DB_USER: 'avnadmin',
    DB_PASSWORD: 'not-a-real-secret',
    DB_NAME: 'simulate_australia_2050_v2',
    DB_SSL_CA_PATH: 'Z:/missing/aiven-ca.pem',
  });

  assert.equal(configuration.configured, false);
  assert.deepEqual(configuration.missing, ['valid DB_SSL_CA_PATH']);
});
