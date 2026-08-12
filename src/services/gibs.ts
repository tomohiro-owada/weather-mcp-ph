/**
 * NASA GIBS (Global Imagery Browse Services) client for satellite imagery.
 *
 * Serves Himawari-9 AHI imagery as WMTS XYZ tiles in Web Mercator
 * (EPSG:3857), covering the Philippines and western Pacific without auth.
 *
 * GeoColor is a multispectral blend (true color by day, IR cloud-top imagery at
 * night), so it is useful 24/7. Tile URLs are constructed directly (no network
 * call needed); the caller's renderer fetches the tiles.
 *
 * Only the latest frame is served (via the WMTS "default" time). GIBS sub-daily
 * GeoColor snapshots are published at irregular timestamps, so guessing fixed
 * intervals for animation produces missing (404) tiles — animation is therefore
 * intentionally not supported for satellite (radar animates via RainViewer).
 *
 * @see https://nasa-gibs.github.io/gibs-api-docs/
 */

import { ImageryFrame } from '../types/imagery.js';

/** WMTS REST base for EPSG:3857 "best" imagery. */
const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

/** Tile matrix set supported by Himawari geostationary layers (zoom 0–6). */
const TILE_MATRIX_SET = 'GoogleMapsCompatible_Level6';
const MAX_ZOOM = 6;

/** Regional default zoom for a satellite view centered on the coordinate. */
const DEFAULT_ZOOM = 5;

/** Web Mercator projection latitude limit. */
const MAX_LATITUDE = 85.05112878;

export class GibsService {
  private readonly layer = 'Himawari_AHI_Band13_Clean_Infrared';

  /** Convert lat/lon to WMTS tile column/row at a zoom level (Web Mercator). */
  private tileColRow(latitude: number, longitude: number, zoom: number): { x: number; y: number } {
    const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude));
    const n = 2 ** zoom;
    const latRad = (lat * Math.PI) / 180;
    const xRaw = Math.floor(((longitude + 180) / 360) * n);
    const yRaw = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    const clamp = (v: number) => Math.max(0, Math.min(n - 1, v));
    return { x: clamp(xRaw), y: clamp(yRaw) };
  }

  /**
   * Build a WMTS tile URL for the latest available frame (WMTS "default" time).
   * WMTS REST order is {z}/{row=y}/{col=x}.
   */
  buildTileUrl(layer: string, latitude: number, longitude: number, zoom: number): string {
    const z = Math.max(0, Math.min(MAX_ZOOM, zoom));
    const { x, y } = this.tileColRow(latitude, longitude, z);
    return `${GIBS_BASE}/${layer}/default/${TILE_MATRIX_SET}/${z}/${y}/${x}.png`;
  }

  /**
   * Get the latest Himawari-9 clean-infrared frame for a location.
   * Returns a single frame (satellite animation is not supported — see file header).
   */
  getSatelliteImagery(latitude: number, longitude: number): ImageryFrame[] {
    return [
      {
        url: this.buildTileUrl(this.layer, latitude, longitude, DEFAULT_ZOOM),
        timestamp: new Date(),
        description: 'Himawari-9 clean infrared satellite (latest)'
      }
    ];
  }
}

// Singleton instance
export const gibsService = new GibsService();
