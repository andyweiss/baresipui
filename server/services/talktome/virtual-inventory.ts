import type { BridgeAudioDevice, BridgeInventory } from './types';

/** Virtual capture path: SIP call audio toward talktome (producer / TX). */
export const VIRTUAL_BRIDGE_INPUT_ID = 'baresip-sip-tx';

/** Virtual playback path: talktome audio toward the SIP call (consumer / RX). */
export const VIRTUAL_BRIDGE_OUTPUT_ID = 'baresip-sip-rx';

const STEREO_PAIR = {
  label: '1/2',
  left_channel: 1,
  right_channel: 2,
} as const;

/**
 * Synthetic inventory for the SIP mediasoup bridge. talktome Admin expects
 * announced input/output devices that match each bridge endpoint assignment;
 * without them an otherwise healthy bridge shows "Device missing".
 */
export function buildVirtualBridgeInventory(host: string): BridgeInventory {
  const devices: BridgeAudioDevice[] = [
    {
      id: VIRTUAL_BRIDGE_INPUT_ID,
      name: 'Baresip SIP to TalkToMe',
      direction: 'input',
      is_default: true,
      max_channels: 2,
      supports_48k: true,
      channel_pairs: [{ ...STEREO_PAIR }],
    },
    {
      id: VIRTUAL_BRIDGE_OUTPUT_ID,
      name: 'TalkToMe to Baresip SIP',
      direction: 'output',
      is_default: true,
      max_channels: 2,
      supports_48k: true,
      channel_pairs: [{ ...STEREO_PAIR }],
    },
  ];
  return {
    host: host.trim() || 'baresip',
    devices,
  };
}

export function virtualBridgeDeviceSelection(): {
  inputDevice: string;
  inputLeftChannel: number;
  inputRightChannel: number;
  outputDevice: string;
  outputLeftChannel: number;
  outputRightChannel: number;
} {
  return {
    inputDevice: VIRTUAL_BRIDGE_INPUT_ID,
    inputLeftChannel: 1,
    inputRightChannel: 2,
    outputDevice: VIRTUAL_BRIDGE_OUTPUT_ID,
    outputLeftChannel: 1,
    outputRightChannel: 2,
  };
}

export function virtualBridgeInputDeviceSelection(): {
  inputDevice: string;
  inputLeftChannel: number;
  inputRightChannel: number;
} {
  return {
    inputDevice: VIRTUAL_BRIDGE_INPUT_ID,
    inputLeftChannel: 1,
    inputRightChannel: 2,
  };
}

export function usesVirtualBridgeDevices(port: {
  input?: { deviceId: string; leftChannel: number; rightChannel: number };
  output?: { deviceId: string; leftChannel: number; rightChannel: number } | null;
}): boolean {
  return (
    port.input?.deviceId === VIRTUAL_BRIDGE_INPUT_ID &&
    port.input.leftChannel === 1 &&
    port.input.rightChannel === 2 &&
    port.output?.deviceId === VIRTUAL_BRIDGE_OUTPUT_ID &&
    port.output.leftChannel === 1 &&
    port.output.rightChannel === 2
  );
}

export function usesVirtualBridgeInputDevice(port: {
  input?: { deviceId: string; leftChannel: number; rightChannel: number };
}): boolean {
  return (
    port.input?.deviceId === VIRTUAL_BRIDGE_INPUT_ID &&
    port.input.leftChannel === 1 &&
    port.input.rightChannel === 2
  );
}
