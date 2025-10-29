export interface Account {
  uri: string;
  registered: boolean;
  callStatus: 'Idle' | 'Ringing' | 'In Call';
  autoConnectStatus: string;
  lastEvent: number;
  configured: boolean;
  registrationError?: string;
  lastRegistrationAttempt?: number;
  source?: string;
}

export interface Contact {
  contact: string;
  name: string;
  enabled: boolean;
  status: string;
  presence: string;
}

export interface ContactConfig {
  name: string;
  enabled: boolean;
  status: string;
  source?: string;
}

export interface BaresipEvent {
  event?: string;
  class?: string;
  type?: string;
  accountaor?: string;
  param?: string;
  event_name?: string;
  local_uri?: string;
  peer_uri?: string;
}

export interface BaresipCommandResponse {
  response?: boolean;
  ok?: boolean;
  data?: string;
  token?: string;
}

export interface WebSocketMessage {
  type: string;
  timestamp?: number;
  message?: string;
  data?: any;
  accounts?: Account[];
  contacts?: Contact[];
  contact?: string;
  status?: string;
}
