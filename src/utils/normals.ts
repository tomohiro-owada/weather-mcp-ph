import type { OpenMeteoHistoricalResponse, ClimateNormals } from '../types/openmeteo.js';

function celsiusToFahrenheit(value: number): number {
  return value * 9 / 5 + 32;
}

/** Compute a 1991–2020 daily climate reference from Open-Meteo archive data. */
export function computeNormalsFrom30YearData(
  historicalData: OpenMeteoHistoricalResponse,
  targetMonth: number,
  targetDay: number
): ClimateNormals {
  const daily = historicalData.daily;
  if (!daily?.time) throw new Error('Historical data does not contain daily data');
  const key = `${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
  const highs: number[] = [];
  const lows: number[] = [];
  const precipitation: number[] = [];
  for (let index = 0; index < daily.time.length; index += 1) {
    if (daily.time[index].slice(5) !== key) continue;
    if (daily.temperature_2m_max?.[index] !== undefined) highs.push(daily.temperature_2m_max[index]);
    if (daily.temperature_2m_min?.[index] !== undefined) lows.push(daily.temperature_2m_min[index]);
    if (daily.precipitation_sum?.[index] !== undefined) precipitation.push(daily.precipitation_sum[index]);
  }
  if (highs.length === 0 || lows.length === 0) throw new Error(`No climate data for ${key}`);
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    tempHigh: Math.round(celsiusToFahrenheit(average(highs))),
    tempLow: Math.round(celsiusToFahrenheit(average(lows))),
    precipitation: precipitation.length ? Math.round((average(precipitation) / 25.4) * 100) / 100 : 0,
    source: 'Open-Meteo',
    month: targetMonth,
    day: targetDay
  };
}

export function getNormalsCacheKey(
  latitude: number,
  longitude: number,
  month: number,
  day: number
): string {
  return `normals:${latitude.toFixed(2)}:${longitude.toFixed(2)}:${month}:${day}`;
}
