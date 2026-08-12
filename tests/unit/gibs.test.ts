import { describe, it, expect } from 'vitest';
import { GibsService } from '../../src/services/gibs.js';

describe('GibsService (satellite imagery)', () => {
  const service = new GibsService();

  describe('Philippines layer', () => {
    it('uses Himawari-9 clean infrared imagery', () => {
      const [frame] = service.getSatelliteImagery(14.5995, 120.9842);
      expect(frame.url).toContain('Himawari_AHI_Band13_Clean_Infrared');
    });
  });

  describe('latest frame (non-animated)', () => {
    it('returns exactly one frame with a valid GIBS WMTS tile URL', () => {
      const frames = service.getSatelliteImagery(14.5995, 120.9842);
      expect(frames).toHaveLength(1);
      const url = frames[0].url;
      expect(url).toContain('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/');
      expect(url).toContain('GoogleMapsCompatible_Level6');
      expect(url).toMatch(/\/\d+\/\d+\/\d+\.png$/); // /{z}/{y}/{x}.png
    });

    it('omits the time dimension for the latest frame', () => {
      const [frame] = service.getSatelliteImagery(14.5995, 120.9842);
      // No ISO timestamp segment in the latest-frame URL.
      expect(frame.url).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('tile coordinate safety', () => {
    it('clamps polar latitudes without producing NaN tile indices', () => {
      const [frame] = service.getSatelliteImagery(89.9, -100); // near North Pole
      const match = frame.url.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/);
      expect(match).not.toBeNull();
      const [, z, y, x] = match!.map(Number);
      expect(Number.isInteger(z)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
      expect(Number.isInteger(x)).toBe(true);
    });
  });
});
