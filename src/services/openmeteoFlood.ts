import axios from 'axios';

export interface FloodForecast {
  latitude: number;
  longitude: number;
  dates: string[];
  discharge: Array<number | null>;
  mean: Array<number | null>;
  p25: Array<number | null>;
  p75: Array<number | null>;
}

export class OpenMeteoFloodService {
  async getForecast(latitude: number, longitude: number, days = 7): Promise<FloodForecast> {
    const response = await axios.get('https://flood-api.open-meteo.com/v1/flood', {
      timeout: 15_000,
      params: {
        latitude,
        longitude,
        daily: 'river_discharge,river_discharge_mean,river_discharge_p25,river_discharge_p75',
        forecast_days: Math.max(1, Math.min(days, 30))
      }
    });
    const daily = response.data?.daily ?? {};
    return {
      latitude: Number(response.data?.latitude),
      longitude: Number(response.data?.longitude),
      dates: Array.isArray(daily.time) ? daily.time : [],
      discharge: Array.isArray(daily.river_discharge) ? daily.river_discharge : [],
      mean: Array.isArray(daily.river_discharge_mean) ? daily.river_discharge_mean : [],
      p25: Array.isArray(daily.river_discharge_p25) ? daily.river_discharge_p25 : [],
      p75: Array.isArray(daily.river_discharge_p75) ? daily.river_discharge_p75 : []
    };
  }
}

export const openMeteoFloodService = new OpenMeteoFloodService();
