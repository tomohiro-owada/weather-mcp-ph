import axios, { AxiosInstance } from 'axios';
import { XMLParser } from 'fast-xml-parser';
import type { PagasaAlert, PagasaAlertArea, PagasaRiverGauge } from '../types/pagasa.js';

const PAGASA_BASE = 'https://publicalert.pagasa.dost.gov.ph';
const PANAHON_BASE = 'https://panahon.gov.ph';
const CACHE_MS = 5 * 60 * 1000;
const MAX_ALERTS = 50;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parsePolygon(value: string): Array<{ latitude: number; longitude: number }> {
  return value
    .trim()
    .split(/\s+/)
    .map(pair => pair.split(',').map(Number))
    .filter(parts => parts.length === 2 && parts.every(Number.isFinite))
    .map(([latitude, longitude]) => ({ latitude, longitude }));
}

export function pointInPolygon(
  latitude: number,
  longitude: number,
  polygon: Array<{ latitude: number; longitude: number }>
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      (a.latitude > latitude) !== (b.latitude > latitude) &&
      longitude <
        ((b.longitude - a.longitude) * (latitude - a.latitude)) /
          (b.latitude - a.latitude) +
          a.longitude;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function parsePagasaCap(xml: string): PagasaAlert {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    trimValues: true
  });
  const alert = parser.parse(xml)?.alert;
  const info = asArray<Record<string, unknown>>(alert?.info)[0] ?? {};
  const areas: PagasaAlertArea[] = asArray<Record<string, unknown>>(
    info.area as Record<string, unknown> | Record<string, unknown>[] | undefined
  ).map(area => ({
    description: String(area.areaDesc ?? ''),
    polygons: asArray<string>(area.polygon as string | string[] | undefined)
      .map(parsePolygon)
      .filter(polygon => polygon.length >= 3)
  }));

  return {
    identifier: String(alert?.identifier ?? ''),
    sent: String(alert?.sent ?? ''),
    status: String(alert?.status ?? ''),
    messageType: String(alert?.msgType ?? ''),
    event: String(info.event ?? 'Weather alert'),
    headline: info.headline ? String(info.headline) : undefined,
    description: info.description ? String(info.description) : undefined,
    instruction: info.instruction ? String(info.instruction) : undefined,
    urgency: info.urgency ? String(info.urgency) : undefined,
    severity: info.severity ? String(info.severity) : undefined,
    certainty: info.certainty ? String(info.certainty) : undefined,
    effective: info.effective ? String(info.effective) : undefined,
    onset: info.onset ? String(info.onset) : undefined,
    expires: info.expires ? String(info.expires) : undefined,
    responseTypes: asArray<string>(info.responseType as string | string[] | undefined),
    senderName: info.senderName ? String(info.senderName) : undefined,
    web: info.web ? String(info.web) : undefined,
    areas
  };
}

export class PagasaService {
  private readonly alertsClient: AxiosInstance;
  private readonly panahonClient: AxiosInstance;
  private readonly parser: XMLParser;
  private alertCache?: CacheEntry<PagasaAlert[]>;
  private riverCache?: CacheEntry<PagasaRiverGauge[]>;

  constructor() {
    this.alertsClient = axios.create({
      baseURL: PAGASA_BASE,
      timeout: 15_000,
      headers: { 'User-Agent': 'weather-mcp-ph/1.0' }
    });
    this.panahonClient = axios.create({
      baseURL: PANAHON_BASE,
      timeout: 15_000,
      headers: { 'User-Agent': 'weather-mcp-ph/1.0' }
    });
    this.parser = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      trimValues: true
    });
  }

  async getAlertsForPoint(latitude: number, longitude: number): Promise<PagasaAlert[]> {
    const alerts = await this.getActiveAlerts();
    return alerts.filter(alert =>
      alert.areas.some(area =>
        area.polygons.some(polygon => pointInPolygon(latitude, longitude, polygon))
      )
    );
  }

  async getActiveAlerts(): Promise<PagasaAlert[]> {
    if (this.alertCache && this.alertCache.expiresAt > Date.now()) {
      return this.alertCache.value;
    }

    const feedResponse = await this.alertsClient.get<string>('/feeds/', {
      responseType: 'text'
    });
    const feed = this.parser.parse(feedResponse.data)?.feed;
    const links = asArray<Record<string, unknown>>(feed?.entry)
      .flatMap(entry => asArray<Record<string, unknown>>(
        entry.link as Record<string, unknown> | Record<string, unknown>[] | undefined
      ))
      .filter(link => link['@_type'] === 'application/cap+xml')
      .map(link => String(link['@_href'] ?? ''))
      .filter(Boolean)
      .slice(0, MAX_ALERTS);

    const settled = await Promise.allSettled(links.map(link => this.fetchAlert(link)));
    const now = Date.now();
    const alerts = settled
      .filter((result): result is PromiseFulfilledResult<PagasaAlert> => result.status === 'fulfilled')
      .map(result => result.value)
      .filter(alert => alert.status === 'Actual')
      .filter(alert => !alert.expires || Date.parse(alert.expires) > now)
      .filter(alert => !['Cancel', 'Error'].includes(alert.messageType));

    this.alertCache = { value: alerts, expiresAt: Date.now() + CACHE_MS };
    return alerts;
  }

  async getRiverGauges(): Promise<PagasaRiverGauge[]> {
    if (this.riverCache && this.riverCache.expiresAt > Date.now()) {
      return this.riverCache.value;
    }

    const home = await this.panahonClient.get<string>('/', { responseType: 'text' });
    const token = home.data.match(/meta name="csrf-token" content="([^"]+)"/)?.[1];
    if (!token) throw new Error('PAGASA Panahon token was not present');

    const response = await this.panahonClient.get('/api/v1/riverbasin/waterlevel', {
      params: { token, parameter: 'waterlevel' }
    });
    const raw = Array.isArray(response.data?.data) ? response.data.data : [];
    const gauges: PagasaRiverGauge[] = raw
      .map((item: Record<string, unknown>) => {
        const latitude = Number(item.lat);
        const longitude = Number(item.lon);
        const parsedValue = item.value === null || item.value === '' ? null : Number(item.value);
        return {
          siteId: String(item.site_id ?? ''),
          name: String(item.site_name ?? 'Unknown station'),
          latitude,
          longitude,
          observedAt: String(item.observed_at ?? ''),
          waterLevelMeters: parsedValue !== null && Number.isFinite(parsedValue) ? parsedValue : null
        };
      })
      .filter((gauge: PagasaRiverGauge) =>
        Number.isFinite(gauge.latitude) && Number.isFinite(gauge.longitude)
      );

    this.riverCache = { value: gauges, expiresAt: Date.now() + CACHE_MS };
    return gauges;
  }

  async checkStatus(): Promise<{ operational: boolean; message: string }> {
    try {
      const alerts = await this.getActiveAlerts();
      return {
        operational: true,
        message: `PAGASA CAP feed is operational (${alerts.length} active alerts)`
      };
    } catch (error) {
      return {
        operational: false,
        message: `PAGASA CAP feed unavailable: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private async fetchAlert(url: string): Promise<PagasaAlert> {
    const response = await axios.get<string>(url, {
      timeout: 15_000,
      responseType: 'text',
      headers: { 'User-Agent': 'weather-mcp-ph/1.0' }
    });
    return parsePagasaCap(response.data);
  }
}

export const pagasaService = new PagasaService();
