import { describe, expect, it } from 'vitest';
import { parsePagasaCap, pointInPolygon } from '../../src/services/pagasa.js';

const CAP_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>pagasa-test-1</identifier>
  <sent>2026-08-12T08:00:00+08:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <info>
    <event>General Flood Advisory</event>
    <headline>Flood advisory for Metro Manila</headline>
    <urgency>Expected</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <expires>2026-08-12T18:00:00+08:00</expires>
    <responseType>Prepare</responseType>
    <area>
      <areaDesc>Metro Manila</areaDesc>
      <polygon>14.4,120.8 14.8,120.8 14.8,121.2 14.4,121.2 14.4,120.8</polygon>
    </area>
  </info>
</alert>`;

describe('PAGASA CAP parsing', () => {
  it('extracts alert metadata and CAP polygons', () => {
    const alert = parsePagasaCap(CAP_FIXTURE);
    expect(alert.identifier).toBe('pagasa-test-1');
    expect(alert.event).toBe('General Flood Advisory');
    expect(alert.severity).toBe('Moderate');
    expect(alert.areas[0].description).toBe('Metro Manila');
    expect(alert.areas[0].polygons[0]).toHaveLength(5);
  });

  it('matches a point inside a PAGASA polygon and rejects one outside', () => {
    const polygon = parsePagasaCap(CAP_FIXTURE).areas[0].polygons[0];
    expect(pointInPolygon(14.5995, 120.9842, polygon)).toBe(true);
    expect(pointInPolygon(10.3157, 123.8854, polygon)).toBe(false);
  });
});
