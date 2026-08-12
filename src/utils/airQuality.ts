/**
 * Air quality utility functions for AQI interpretation and health recommendations
 */

/**
 * US AQI health category information
 */
export interface AQICategory {
  level: string;
  description: string;
  healthImplications: string;
  cautionaryStatement: string;
  color: string;
}

/**
 * UV index category information
 */
export interface UVIndexCategory {
  level: string;
  description: string;
  recommendation: string;
}

/**
 * Get US AQI health category based on AQI value
 * US EPA AQI scale: https://www.airnow.gov/aqi/aqi-basics/
 */
export function getUSAQICategory(aqi: number): AQICategory {
  if (aqi <= 50) {
    return {
      level: 'Good',
      description: 'Air quality is satisfactory',
      healthImplications: 'Air quality is considered satisfactory, and air pollution poses little or no risk.',
      cautionaryStatement: 'None',
      color: 'Green'
    };
  } else if (aqi <= 100) {
    return {
      level: 'Moderate',
      description: 'Air quality is acceptable',
      healthImplications: 'Air quality is acceptable; however, unusually sensitive people may experience minor respiratory symptoms.',
      cautionaryStatement: 'Unusually sensitive people should consider reducing prolonged outdoor exertion.',
      color: 'Yellow'
    };
  } else if (aqi <= 150) {
    return {
      level: 'Unhealthy for Sensitive Groups',
      description: 'Sensitive groups may experience health effects',
      healthImplications: 'Members of sensitive groups may experience health effects. The general public is not likely to be affected.',
      cautionaryStatement: 'Children, elderly, and people with respiratory conditions should limit prolonged outdoor exertion.',
      color: 'Orange'
    };
  } else if (aqi <= 200) {
    return {
      level: 'Unhealthy',
      description: 'Everyone may begin to experience health effects',
      healthImplications: 'Everyone may begin to experience health effects; sensitive groups may experience more serious health effects.',
      cautionaryStatement: 'Everyone should limit prolonged outdoor exertion, especially sensitive groups.',
      color: 'Red'
    };
  } else if (aqi <= 300) {
    return {
      level: 'Very Unhealthy',
      description: 'Health alert: everyone may experience serious effects',
      healthImplications: 'Health alert: everyone may experience more serious health effects.',
      cautionaryStatement: 'Everyone should avoid prolonged outdoor exertion. Sensitive groups should remain indoors.',
      color: 'Purple'
    };
  } else {
    return {
      level: 'Hazardous',
      description: 'Health warnings of emergency conditions',
      healthImplications: 'Health warnings of emergency conditions. The entire population is more likely to be affected.',
      cautionaryStatement: 'Everyone should avoid all outdoor exertion. Sensitive groups should remain indoors with air filtration.',
      color: 'Maroon'
    };
  }
}

/**
 * Get European AQI health category based on EAQI value
 * European Environment Agency EAQI scale: 0-20 (good) to 100+ (extremely poor)
 */
export function getEuropeanAQICategory(aqi: number): AQICategory {
  if (aqi <= 20) {
    return {
      level: 'Good',
      description: 'Air quality is good',
      healthImplications: 'The air quality is good. Enjoy your usual outdoor activities.',
      cautionaryStatement: 'None',
      color: 'Blue'
    };
  } else if (aqi <= 40) {
    return {
      level: 'Fair',
      description: 'Air quality is fair',
      healthImplications: 'Enjoy your usual outdoor activities.',
      cautionaryStatement: 'None',
      color: 'Green'
    };
  } else if (aqi <= 60) {
    return {
      level: 'Moderate',
      description: 'Air quality is moderate',
      healthImplications: 'Consider reducing intense outdoor activities if you experience symptoms.',
      cautionaryStatement: 'Sensitive individuals should consider reducing intense activities.',
      color: 'Yellow'
    };
  } else if (aqi <= 80) {
    return {
      level: 'Poor',
      description: 'Air quality is poor',
      healthImplications: 'Consider reducing intense outdoor activities if you experience symptoms such as sore eyes, cough, or sore throat.',
      cautionaryStatement: 'Sensitive groups should reduce outdoor activities.',
      color: 'Orange'
    };
  } else if (aqi <= 100) {
    return {
      level: 'Very Poor',
      description: 'Air quality is very poor',
      healthImplications: 'Consider reducing physical activities, particularly outdoors, especially if you experience symptoms.',
      cautionaryStatement: 'Sensitive groups should avoid outdoor activities. General population should reduce outdoor activities.',
      color: 'Red'
    };
  } else {
    return {
      level: 'Extremely Poor',
      description: 'Air quality is extremely poor',
      healthImplications: 'Reduce physical activities outdoors. People with respiratory or heart conditions should remain indoors.',
      cautionaryStatement: 'Everyone should avoid outdoor activities. Sensitive groups should remain indoors.',
      color: 'Purple'
    };
  }
}

/**
 * Get UV index category and recommendations
 * WHO UV Index scale: https://www.who.int/news-room/questions-and-answers/item/radiation-the-ultraviolet-(uv)-index
 */
export function getUVIndexCategory(uvIndex: number): UVIndexCategory {
  if (uvIndex < 3) {
    return {
      level: 'Low',
      description: 'Minimal protection required',
      recommendation: 'No protection required. You can safely stay outside.'
    };
  } else if (uvIndex < 6) {
    return {
      level: 'Moderate',
      description: 'Protection recommended',
      recommendation: 'Wear sunscreen, hat, and sunglasses. Seek shade during midday hours.'
    };
  } else if (uvIndex < 8) {
    return {
      level: 'High',
      description: 'Protection essential',
      recommendation: 'Apply SPF 30+ sunscreen. Wear protective clothing, hat, and sunglasses. Reduce midday sun exposure.'
    };
  } else if (uvIndex < 11) {
    return {
      level: 'Very High',
      description: 'Extra protection required',
      recommendation: 'Minimize sun exposure 10am-4pm. Apply SPF 30+ sunscreen every 2 hours. Wear protective clothing and sunglasses.'
    };
  } else {
    return {
      level: 'Extreme',
      description: 'Maximum protection required',
      recommendation: 'Avoid sun exposure 10am-4pm. Stay in shade. Apply SPF 50+ sunscreen frequently. Wear full protective clothing.'
    };
  }
}

/**
 * Get pollutant description and health context
 */
export function getPollutantInfo(pollutant: string): { name: string; description: string; sources: string } {
  const pollutants: { [key: string]: { name: string; description: string; sources: string } } = {
    pm2_5: {
      name: 'PM2.5 (Fine Particulate Matter)',
      description: 'Particles less than 2.5 micrometers. Can penetrate deep into lungs and bloodstream.',
      sources: 'Vehicle emissions, industrial processes, wildfires, dust'
    },
    pm10: {
      name: 'PM10 (Coarse Particulate Matter)',
      description: 'Particles less than 10 micrometers. Can irritate airways and respiratory system.',
      sources: 'Dust, pollen, mold, vehicle emissions, construction'
    },
    ozone: {
      name: 'Ozone (O₃)',
      description: 'Ground-level ozone can cause respiratory problems and aggravate asthma.',
      sources: 'Formed by reactions between NOx and VOCs in sunlight'
    },
    nitrogen_dioxide: {
      name: 'Nitrogen Dioxide (NO₂)',
      description: 'Irritates airways and can worsen respiratory diseases.',
      sources: 'Vehicle emissions, power plants, industrial facilities'
    },
    sulphur_dioxide: {
      name: 'Sulfur Dioxide (SO₂)',
      description: 'Can cause breathing difficulties and aggravate respiratory conditions.',
      sources: 'Fossil fuel combustion, industrial processes, volcanoes'
    },
    carbon_monoxide: {
      name: 'Carbon Monoxide (CO)',
      description: 'Reduces oxygen delivery to body tissues. Dangerous in enclosed spaces.',
      sources: 'Vehicle emissions, incomplete combustion, industrial processes'
    },
    ammonia: {
      name: 'Ammonia (NH₃)',
      description: 'Can irritate eyes, nose, throat, and respiratory system.',
      sources: 'Agricultural activities, waste treatment, industrial processes'
    }
  };

  return pollutants[pollutant] || {
    name: pollutant.toUpperCase(),
    description: 'Air pollutant',
    sources: 'Various sources'
  };
}

/**
 * Format pollutant concentration with appropriate units and precision
 */
export function formatPollutantConcentration(value: number | undefined, units: string | undefined): string {
  if (value === undefined || value === null) {
    return 'N/A';
  }

  // Round to appropriate precision based on magnitude
  let formatted: string;
  if (value < 1) {
    formatted = value.toFixed(2);
  } else if (value < 10) {
    formatted = value.toFixed(1);
  } else {
    formatted = Math.round(value).toString();
  }

  return units ? `${formatted} ${units}` : formatted;
}
