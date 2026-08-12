import { pagasaService } from '../services/pagasa.js';
import { LocationStore } from '../services/locationStore.js';
import { GeocodingService } from '../services/geocoding.js';
import { resolveLocationAsync, prependLocationLine } from '../utils/locationResolver.js';
import { validateDetail } from '../utils/validation.js';
import type { PagasaAlert } from '../types/pagasa.js';

interface AlertsArgs {
  latitude?: number;
  longitude?: number;
  location_name?: string;
  city_name?: string;
  active_only?: boolean;
  detail?: 'summary' | 'standard' | 'full';
}

const severityRank: Record<string, number> = {
  Extreme: 0,
  Severe: 1,
  Moderate: 2,
  Minor: 3,
  Unknown: 4
};

function formatDate(value: string | undefined): string {
  if (!value) return 'Not specified';
  return new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila'
  }).format(new Date(value));
}

function severityEmoji(severity: string | undefined): string {
  if (severity === 'Extreme') return '🔴';
  if (severity === 'Severe') return '🟠';
  if (severity === 'Moderate') return '🟡';
  if (severity === 'Minor') return '🔵';
  return '⚪';
}

function renderAlert(alert: PagasaAlert, detail: AlertsArgs['detail']): string {
  const areas = alert.areas.map(area => area.description).filter(Boolean).join(', ');
  let output = `${severityEmoji(alert.severity)} **${alert.event}**\n---\n`;
  if (alert.headline) output += `**${alert.headline}**\n\n`;
  output += `**Severity:** ${alert.severity ?? 'Unknown'} | `;
  output += `**Urgency:** ${alert.urgency ?? 'Unknown'} | `;
  output += `**Certainty:** ${alert.certainty ?? 'Unknown'}\n`;
  output += `**Area:** ${areas || 'Philippines'}\n`;
  output += `**Issued:** ${formatDate(alert.sent)}\n`;
  output += `**Expires:** ${formatDate(alert.expires)}\n`;
  if (detail === 'full' && alert.description) {
    output += `\n**Description:**\n${alert.description}\n`;
  }
  if (detail !== 'summary' && alert.instruction) {
    output += `\n**Instructions:**\n${alert.instruction}\n`;
  }
  if (alert.web) output += `\n**Official information:** ${alert.web}\n`;
  output += `\n**Sender:** ${alert.senderName ?? 'PAGASA-DOST'}\n\n`;
  return output;
}

export async function handleGetAlerts(
  args: unknown,
  locationStore: LocationStore,
  geocodingService: GeocodingService
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const typedArgs = (args ?? {}) as AlertsArgs;
  const resolved = await resolveLocationAsync(typedArgs, locationStore, geocodingService);
  const detail = validateDetail(typedArgs.detail);
  const alerts = await pagasaService.getAlertsForPoint(resolved.latitude, resolved.longitude);
  alerts.sort((a, b) =>
    (severityRank[a.severity ?? 'Unknown'] ?? 4) - (severityRank[b.severity ?? 'Unknown'] ?? 4)
  );

  let output = '# PAGASA Weather Alerts\n\n';
  output += '**Status:** Active alerts only\n\n';
  if (alerts.length === 0) {
    output += '✅ **No active PAGASA alert polygons include this location.**\n\n';
    output += 'Always check PAGASA and local government notices during rapidly changing conditions.\n';
  } else {
    output += `⚠️ **${alerts.length} active alert${alerts.length === 1 ? '' : 's'} found**\n\n`;
    output += alerts.map(alert => renderAlert(alert, detail)).join('');
  }
  output += '\n---\n';
  output += '*Data source: PAGASA-DOST Common Alerting Protocol (CAP) feed · CC BY 4.0*\n';

  return prependLocationLine({ content: [{ type: 'text', text: output }] }, resolved);
}
