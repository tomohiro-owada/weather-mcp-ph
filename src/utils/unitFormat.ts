import { UnitPreferences } from '../config/units.js';

/** Query parameters that make Open-Meteo return the requested display units. */
export function openMeteoUnitParams(prefs: UnitPreferences): {
  temperature_unit: 'celsius' | 'fahrenheit';
  wind_speed_unit: 'mph' | 'kmh' | 'ms' | 'kn';
  precipitation_unit: 'inch' | 'mm';
} {
  return {
    temperature_unit: prefs.temperature === 'C' ? 'celsius' : 'fahrenheit',
    wind_speed_unit: prefs.windSpeed,
    precipitation_unit: prefs.precipitation === 'mm' ? 'mm' : 'inch'
  };
}
