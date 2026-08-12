import { OpenMeteoService } from '../services/openmeteo.js';
import { pagasaService } from '../services/pagasa.js';

export async function handleCheckServiceStatus(
  openMeteoService: OpenMeteoService,
  version?: string
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const [openMeteo, pagasa] = await Promise.all([
    openMeteoService.checkServiceStatus(),
    pagasaService.checkStatus()
  ]);
  const cache = openMeteoService.getCacheStats();
  const requests = cache.hits + cache.misses;
  const hitRate = requests > 0 ? cache.hits / requests : 0;
  let output = '# Philippine Weather Service Status\n\n';
  if (version) output += `**Server version:** ${version}\n\n`;
  output += `## ${openMeteo.operational ? '✅' : '❌'} Open-Meteo\n\n`;
  output += `${openMeteo.message}\n\n`;
  output += `## ${pagasa.operational ? '✅' : '❌'} PAGASA CAP\n\n`;
  output += `${pagasa.message}\n\n`;
  output += '## Cache\n\n';
  output += `- Entries: ${cache.size}\n`;
  output += `- Hit rate: ${(hitRate * 100).toFixed(1)}%\n\n`;
  output += '*River observations and optional NASA FIRMS access are checked when their tools are called.*\n';
  return { content: [{ type: 'text', text: output }] };
}
