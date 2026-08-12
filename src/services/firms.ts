import axios from 'axios';

export interface FirmsDetection {
  latitude: number;
  longitude: number;
  acquiredAt: Date;
  confidence: string;
  fireRadiativePower: number | null;
  dayNight: string;
  satellite: string;
}

export class FirmsService {
  private readonly mapKey = process.env.FIRMS_MAP_KEY?.trim();

  isConfigured(): boolean {
    return Boolean(this.mapKey);
  }

  async getDetections(west: number, south: number, east: number, north: number): Promise<FirmsDetection[]> {
    if (!this.mapKey) {
      throw new Error('FIRMS_MAP_KEY is not configured');
    }
    const area = [west, south, east, north].join(',');
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${this.mapKey}/VIIRS_SNPP_NRT/${area}/1`;
    const response = await axios.get<string>(url, { timeout: 20_000, responseType: 'text' });
    const lines = response.data.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',');
    const index = (name: string) => headers.indexOf(name);
    return lines.slice(1).map(line => {
      const fields = line.split(',');
      const date = fields[index('acq_date')] ?? '';
      const rawTime = (fields[index('acq_time')] ?? '').padStart(4, '0');
      const acquiredAt = new Date(`${date}T${rawTime.slice(0, 2)}:${rawTime.slice(2)}:00Z`);
      const frp = Number(fields[index('frp')]);
      return {
        latitude: Number(fields[index('latitude')]),
        longitude: Number(fields[index('longitude')]),
        acquiredAt,
        confidence: fields[index('confidence')] ?? 'unknown',
        fireRadiativePower: Number.isFinite(frp) ? frp : null,
        dayNight: fields[index('daynight')] ?? '',
        satellite: fields[index('satellite')] ?? ''
      };
    }).filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  }
}

export const firmsService = new FirmsService();
