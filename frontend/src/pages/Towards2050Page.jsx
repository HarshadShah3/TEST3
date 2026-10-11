import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useRegionSelection } from '../context/RegionSelectionContext';
import { useSavedRegions } from '../context/SavedRegionsContext';
import { useComparisonSelection } from '../context/ComparisonSelectionContext';
import { fetchRegionalProjections } from '../services/regionApi';
import { formatCurrency, formatNumber } from '../utils/formatters';
import { parseComparisonRegionIds, selectOutlookRegionIds } from '../utils/outlookRegionScope';
import { classifyPopulationOutlook } from '../utils/populationOutlook';

const chartColours = ['#1f5f42', '#2f79a0', '#a6622d', '#74539a'];
const maximumDisplayedRegions = 4;

/* Treats null, blank, non-finite, and explicit unavailable forecast values as missing while preserving valid zeroes. */
function isAvailable(value) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') return Number.isFinite(value);
  return String(value).trim().toLowerCase() !== 'not available';
}

/* Formats each available forecast using its API-supplied unit, including people, currency, percentages, and plain values. */
function formatIndicatorValue(value, unit) {
  if (!isAvailable(value)) return 'Not available';
  if (typeof value === 'string') return value;
  if (unit === 'AUD') return formatCurrency(value);
  if (unit === 'AUD/week') return `${formatCurrency(value)}/wk`;
  if (unit === 'percent') return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
  if (unit === 'index' || unit === 'per 1,000 residents') return Number(value).toFixed(1);
  return formatNumber(value);
}

/* Finds an indicator by stable ID so chart and table transformations do not depend on API response ordering. */
function getIndicator(forecast, indicatorId) {
  return forecast?.indicators.find(indicator => indicator.id === indicatorId) ?? null;
}

/* Calculates projected percentage change only when both values are finite and the baseline is positive. */
function projectedChange(indicator) {
  if (!Number.isFinite(indicator?.baseline) || indicator.baseline <= 0 || !Number.isFinite(indicator?.projected)) return null;
  return ((indicator.projected - indicator.baseline) / indicator.baseline) * 100;
}

/* Resolves up to four journey regions, fetches published forecasts, and builds sourced KPI cards, charts, and grouped indicator tables. */
export default function Towards2050Page() {
  const { selectedRegionId } = useRegionSelection();
  const { savedRegions } = useSavedRegions();
  const { comparisonRegionIds } = useComparisonSelection();
  const [searchParams] = useSearchParams();
  const requestedRegionIds = searchParams.get('regions') ?? '';
  const [displayedRegionIds, setDisplayedRegionIds] = useState([]);
  const [showSchoolIndicator, setShowSchoolIndicator] = useState(false);
  const [forecasts, setForecasts] = useState([]);
  const [requestStatus, setRequestStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [responseMeta, setResponseMeta] = useState(null);

  const availableRegions = useMemo(() => {
    const regionsById = new Map(savedRegions.map(region => [region.id, {
      id: region.id,
      name: region.name,
      state: region.state,
      fromMap: false,
      fromShortlist: true,
    }]));

    if (selectedRegionId) {
      const existing = regionsById.get(selectedRegionId);
      regionsById.set(selectedRegionId, {
        id: selectedRegionId,
        name: existing?.name ?? '',
        state: existing?.state ?? '',
        fromMap: true,
        fromShortlist: Boolean(existing),
      });
    }

    const regions = [...regionsById.values()];
    return regions.sort((first, second) => {
      if (first.fromMap !== second.fromMap) return first.fromMap ? -1 : 1;
      return (first.name || first.id).localeCompare(second.name || second.id);
    });
  }, [savedRegions, selectedRegionId]);

  const availableRegionIdsKey = availableRegions.map(region => region.id).join('|');

  useEffect(() => {
    const availableIds = availableRegions.map(region => region.id);
    const comparisonIds = requestedRegionIds
      ? parseComparisonRegionIds(requestedRegionIds)
      : comparisonRegionIds;
    setDisplayedRegionIds(current => {
      const next = selectOutlookRegionIds(availableIds, comparisonIds, current, maximumDisplayedRegions);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [availableRegionIdsKey, requestedRegionIds, comparisonRegionIds]);

  const displayedRegionIdsKey = displayedRegionIds.join('|');

  useEffect(() => {
    const requestController = new AbortController();
    if (!displayedRegionIds.length) {
      setForecasts([]);
      setResponseMeta(null);
      setRequestStatus('idle');
      setErrorMessage('');
      return () => requestController.abort();
    }

    setRequestStatus('loading');
    setErrorMessage('');
    fetchRegionalProjections(displayedRegionIds, requestController.signal)
      .then(response => {
        setForecasts(response.data);
        setResponseMeta(response.meta);
        setRequestStatus('success');
      })
      .catch(error => {
        if (error.name !== 'AbortError') {
          setForecasts([]);
          setResponseMeta(null);
          setErrorMessage(error.message || 'Forecast data could not be loaded.');
          setRequestStatus('error');
        }
      });
    return () => requestController.abort();
  }, [displayedRegionIdsKey]);

  const forecastById = useMemo(() => Object.fromEntries(
    forecasts.map(forecast => [forecast.region.id, forecast]),
  ), [forecasts]);

  const populationChartData = useMemo(() => {
    const years = [...new Set(forecasts.flatMap(forecast => forecast.series.population.map(point => point.year)))]
      .filter(Number.isFinite)
      .sort((first, second) => first - second);
    return years.map(year => {
      const row = { year };
      forecasts.forEach(forecast => {
        const point = forecast.series.population.find(item => item.year === year);
        row[forecast.region.id] = point?.value ?? null;
      });
      return row;
    });
  }, [forecasts]);

  const householdChartData = useMemo(() => forecasts.map(forecast => ({
    id: forecast.region.id,
    name: forecast.region.name,
    households: getIndicator(forecast, 'households')?.projected ?? null,
    dwellings: getIndicator(forecast, 'dwellings')?.projected ?? null,
  })).filter(row => Number.isFinite(row.households) || Number.isFinite(row.dwellings)), [forecasts]);

  const indicatorGroups = useMemo(() => {
    const indicatorById = new Map();
    forecasts.forEach(forecast => forecast.indicators.forEach(indicator => {
      if (!indicatorById.has(indicator.id)) indicatorById.set(indicator.id, indicator);
    }));
    return [...indicatorById.values()].reduce((groups, indicator) => {
      const group = groups.get(indicator.category) ?? [];
      group.push(indicator);
      groups.set(indicator.category, group);
      return groups;
    }, new Map());
  }, [forecasts]);

  function toggleDisplayedRegion(regionId) {
    setDisplayedRegionIds(current => {
      if (current.includes(regionId)) return current.filter(id => id !== regionId);
      if (current.length >= maximumDisplayedRegions) return current;
      return [...current, regionId];
    });
  }

  return (
    <section className="page-shell towards-page">
      <div className="profile-page-actions">
        <Link className="back-link" to="/compare">&larr; Back to Compare</Link>
      </div>
      <div className="page-heading towards-heading">
        <p className="eyebrow">LONG-TERM OUTLOOK</p>
        <h1>Towards 2050</h1>
        <p>Review forecast indicators for the region selected on the Explore map or Compare page, and the regions saved to your shortlist.</p>
      </div>

      <aside className="projection-integration-note">
        <strong>{responseMeta?.isForecastBackendConnected ? 'Aiven MySQL projection data connected.' : 'Aiven MySQL projection data required.'}</strong>
        <p>{responseMeta?.isForecastBackendConnected
          ? (responseMeta.scenario === 'modelled-projection'
            ? `2050 modelled projections (90% interval) are loaded from Aiven (${responseMeta.methodologyVersion ?? 'iteration3-v1.0.0'}). VIF 2021–2036 anchors remain; employment uses dominant SA4 geography and property prices are low-confidence.`
            : 'Population, household and dwelling series are read from the published VIF records in the cloud database. The latest verified horizon is 2036.')
          : 'Select a region to load its published 2021-2036 VIF projection series from the cloud database.'}</p>
      </aside>

      {!availableRegions.length ? (
        <section className="forecast-empty card">
          <h2>Choose regions to build your outlook</h2>
          <p>Select a highlighted area on the Explore map or save regions to your shortlist. They will appear here automatically.</p>
          <div><Link className="button primary" to="/explore">Open Explore map</Link><Link className="button secondary" to="/shortlist">Open shortlist</Link></div>
        </section>
      ) : (
        <>
          <section className="forecast-scope card" aria-label="Regions included in the forecast dashboard">
            <div className="forecast-scope-heading">
              <div><h2>Regions in this outlook</h2><p>Select up to {maximumDisplayedRegions} regions to keep the charts readable.</p></div>
              <strong>{displayedRegionIds.length}/{maximumDisplayedRegions} selected</strong>
            </div>
            <div className="forecast-region-options">
              {availableRegions.map(region => {
                const forecast = forecastById[region.id];
                const isSelected = displayedRegionIds.includes(region.id);
                return (
                  <label className={isSelected ? 'selected' : ''} key={region.id}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={!isSelected && displayedRegionIds.length >= maximumDisplayedRegions}
                      onChange={() => toggleDisplayedRegion(region.id)}
                    />
                    <span><strong>{forecast?.region.name || region.name || 'Map-selected region'}</strong><small>{region.fromMap ? 'Explore map selection' : 'Shortlist'}{region.fromMap && region.fromShortlist ? ' · Shortlist' : ''}</small></span>
                  </label>
                );
              })}
            </div>
          </section>

          {requestStatus === 'loading' && <p className="forecast-status">Loading regional outlooks…</p>}
          {requestStatus === 'error' && <p className="forecast-error" role="alert">{errorMessage}</p>}

          {requestStatus === 'success' && forecasts.length > 0 && (
            <>
              <section className="forecast-kpi-grid" aria-label="Core forecast indicators">
                {forecasts.map(forecast => {
                  const population = getIndicator(forecast, 'population');
                  const growth = projectedChange(population);
                  const populationOutlook = classifyPopulationOutlook(population?.baseline, population?.projected);
                  return (
                    <article className="forecast-kpi-card card" key={forecast.region.id}>
                      <i style={{ backgroundColor: chartColours[displayedRegionIds.indexOf(forecast.region.id) % chartColours.length] }}/>
                      <small>{forecast.region.state} · TO {forecast.projectionYear ?? 'TBC'}</small>
                      <h2>{forecast.region.name}</h2>
                      <dl>
                        <div><dt>Projected population</dt><dd>{formatIndicatorValue(population?.projected, 'people')}</dd></div>
                        <div><dt>Population change from {forecast.baselineYear ?? 'baseline'}</dt><dd>{Number.isFinite(growth) ? `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%` : 'Not available'}</dd></div>
                        <div><dt>Growth classification</dt><dd>{populationOutlook?.growthBand ?? 'Not available'}</dd></div>
                        <div><dt>Projected households</dt><dd>{formatIndicatorValue(getIndicator(forecast, 'households')?.projected, 'households')}</dd></div>
                        <div><dt>Projected dwellings</dt><dd>{formatIndicatorValue(getIndicator(forecast, 'dwellings')?.projected, 'dwellings')}</dd></div>
                      </dl>
                    </article>
                  );
                })}
              </section>

              <div className="forecast-chart-grid">
                <section className="forecast-chart card">
                  <div className="forecast-panel-heading"><div><h2>Population outlook</h2><p>Observed baseline to the currently available projection horizon.</p></div><span>People</span></div>
                  <div className="forecast-chart-canvas">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={populationChartData} margin={{ top: 12, right: 20, left: 8, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8e4" />
                        <XAxis dataKey="year" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} tickFormatter={value => new Intl.NumberFormat('en-AU', { notation: 'compact' }).format(value)} />
                        <Tooltip formatter={(value, regionId, entry) => {
                          const forecast = forecastById[regionId];
                          const point = forecast?.series.population.find(p => p.year === entry.payload.year);
                          const label = [formatNumber(value), forecast?.region.name ?? regionId];
                          if (point?.modelled && point.confidenceLow != null && point.confidenceHigh != null) {
                            label.push(`90% range: ${formatNumber(point.confidenceLow)} – ${formatNumber(point.confidenceHigh)}`);
                          }
                          return label;
                        }} labelFormatter={year => `Year ${year}`} />
                        <Legend formatter={regionId => forecastById[regionId]?.region.name ?? regionId} />
                        {forecasts.map((forecast, index) => <Line connectNulls dataKey={forecast.region.id} key={forecast.region.id} stroke={chartColours[index % chartColours.length]} strokeWidth={3} dot={{ r: 4 }} type="monotone" />)}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <label className="forecast-service-toggle">
                    <input type="checkbox" checked={showSchoolIndicator} onChange={event => setShowSchoolIndicator(event.target.checked)} />
                    Show current school counts alongside the population outlook
                  </label>
                  {showSchoolIndicator && (
                    <div className="forecast-service-list" aria-label="Current school counts for the selected regions">
                      {forecasts.map(forecast => {
                        const schools = getIndicator(forecast, 'schools');
                        return (
                          <div key={forecast.region.id}>
                            <strong>{forecast.region.name}</strong>
                            <span>{isAvailable(schools?.baseline) ? `${formatIndicatorValue(schools.baseline, 'schools')} schools` : 'School count not available'}</span>
                            {schools?.sourcePeriod && <small>{schools.sourcePeriod}</small>}
                          </div>
                        );
                      })}
                      <p>School counts are current observations, not a forecast of future school capacity or a guarantee of access.</p>
                    </div>
                  )}
                </section>

                <section className="forecast-chart card">
                  <div className="forecast-panel-heading"><div><h2>Future households and dwellings</h2><p>Available totals at each region's current projection horizon.</p></div><span>Count</span></div>
                  <div className="forecast-chart-canvas">
                    {householdChartData.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={householdChartData} margin={{ top: 12, right: 12, left: 8, bottom: 4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8e4" />
                          <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                          <YAxis tick={{ fontSize: 12 }} tickFormatter={value => new Intl.NumberFormat('en-AU', { notation: 'compact' }).format(value)} />
                          <Tooltip formatter={value => formatNumber(value)} />
                          <Legend />
                          <Bar dataKey="households" fill="#4f8968" name="Households" radius={[4, 4, 0, 0]} />
                          <Bar dataKey="dwellings" fill="#d8a15c" name="Dwellings" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <p className="forecast-chart-empty">Household and dwelling forecasts are awaiting backend data.</p>}
                  </div>
                </section>
              </div>

              <section className="forecast-indicators card">
                <div className="forecast-panel-heading"><div><h2>Indicator framework</h2><p>Baseline and projected values across every planned forecast category.</p></div><span>{responseMeta?.isForecastBackendConnected ? 'Forecast service connected' : 'Temporary profile adapter'}</span></div>
                <div className="forecast-indicator-table-shell">
                  <table className="forecast-indicator-table">
                    <thead><tr><th>Indicator</th>{forecasts.map(forecast => <th key={forecast.region.id}>{forecast.region.name}</th>)}</tr></thead>
                    <tbody>
                      {[...indicatorGroups.entries()].map(([category, indicators]) => (
                        <FragmentRows category={category} forecasts={forecasts} indicators={indicators} key={category}/>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </section>
  );
}

/* Labels every region-metric cell as baseline-to-projection, current observation, or pending evidence according to value availability. */
function FragmentRows({ category, forecasts, indicators }) {
  return (
    <>
      <tr className="forecast-indicator-category"><th colSpan={forecasts.length + 1}>{category}</th></tr>
      {indicators.map(indicator => (
        <tr key={indicator.id}>
          <th scope="row"><strong>{indicator.label}</strong><small>{indicator.unit === 'text' ? '' : indicator.unit}</small></th>
          {forecasts.map(forecast => {
            const value = getIndicator(forecast, indicator.id);
            const hasProjection = isAvailable(value?.projected);
            const isCurrentObservation = value?.status === 'current-observation';
            return (
              <td key={forecast.region.id} data-region={forecast.region.name}>
                <span className="forecast-indicator-region">{forecast.region.name}</span>
                <div className="forecast-indicator-values">
                  {hasProjection ? (
                    <><span>{formatIndicatorValue(value?.baseline, value?.unit)}</span><b aria-hidden="true">→</b><strong>{formatIndicatorValue(value.projected, value.unit)}</strong></>
                  ) : isCurrentObservation ? (
                    <><strong>{formatIndicatorValue(value?.baseline, value?.unit)}</strong><small className="forecast-pending">Current observation</small></>
                  ) : (
                    <><span>{formatIndicatorValue(value?.baseline, value?.unit)}</span><small className="forecast-pending">Forecast pending</small></>
                  )}
                </div>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
