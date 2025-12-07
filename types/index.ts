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
  autoConnectContact?: string;
  callId?: string;
}

export interface Contact {
  contact: string;
  name: string;
  enabled: boolean;
  status: string;
  presence: string;
  assignedAccount?: string;
}

export interface ContactConfig {
  name: string;
  enabled: boolean;
  status: string;
  source?: string;
  assignedAccount?: string;
}

export interface CallInfo {
  callId: string;
  localUri: string;
  remoteUri: string;
  peerName?: string;
  state: 'Ringing' | 'Established' | 'Closing';
  direction: 'incoming' | 'outgoing';
  startTime: number;
  answerTime?: number;
  endTime?: number;
  duration?: number;
}

export interface AudioMeter {
  accountUri: string;
  inputLevel: number;  // dB
  outputLevel: number; // dB
  timestamp: number;
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
  id?: string;
  peeruri?: string;
  contacturi?: string;
  localuri?: string;
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
