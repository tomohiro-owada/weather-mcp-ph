export interface WaveHeightCategory {
  description: string;
  level: string;
  recommendation: string;
}

export function getWaveHeightCategory(meters: number | undefined): WaveHeightCategory {
  if (meters === undefined) return { description: 'Unknown', level: 'Unknown', recommendation: 'Consult PAGASA' };
  if (meters < 0.5) return { description: 'Calm', level: 'Low', recommendation: 'Generally suitable for small craft' };
  if (meters < 1.25) return { description: 'Slight', level: 'Low', recommendation: 'Use normal marine caution' };
  if (meters < 2.5) return { description: 'Moderate', level: 'Moderate', recommendation: 'Small craft should use caution' };
  if (meters < 4) return { description: 'Rough', level: 'High', recommendation: 'Small craft should remain in port' };
  if (meters < 6) return { description: 'Very rough', level: 'Very high', recommendation: 'Avoid marine activity' };
  return { description: 'High to phenomenal', level: 'Extreme', recommendation: 'Dangerous for all vessels' };
}

export interface SafetyAssessment {
  level: string;
  description: string;
  recommendation: string;
}

export function getSafetyAssessment(
  totalWaveHeight: number | undefined,
  windWaveHeight: number | undefined,
  swellHeight: number | undefined,
  wavePeriod: number | undefined
): SafetyAssessment {
  const category = getWaveHeightCategory(totalWaveHeight);
  let description = category.description;
  if (totalWaveHeight !== undefined && wavePeriod !== undefined && wavePeriod < 6 && totalWaveHeight > 1) {
    description += ', short-period and choppy';
  }
  if (windWaveHeight !== undefined && swellHeight !== undefined) {
    description += swellHeight > windWaveHeight * 1.5 ? ', swell-dominated' : ', mixed wind and swell';
  }
  return { level: category.level, description, recommendation: category.recommendation };
}
