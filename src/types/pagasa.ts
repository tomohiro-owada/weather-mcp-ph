export interface PagasaAlertArea {
  description: string;
  polygons: Array<Array<{ latitude: number; longitude: number }>>;
}

export interface PagasaAlert {
  identifier: string;
  sent: string;
  status: string;
  messageType: string;
  event: string;
  headline?: string;
  description?: string;
  instruction?: string;
  urgency?: string;
  severity?: string;
  certainty?: string;
  effective?: string;
  onset?: string;
  expires?: string;
  responseTypes: string[];
  senderName?: string;
  web?: string;
  areas: PagasaAlertArea[];
}

export interface PagasaRiverGauge {
  siteId: string;
  name: string;
  latitude: number;
  longitude: number;
  observedAt: string;
  waterLevelMeters: number | null;
}
