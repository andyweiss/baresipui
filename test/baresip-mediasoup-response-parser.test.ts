import { describe, expect, it } from 'vitest';
import { parseBaresipEventBuffered } from '~/server/services/baresip-parser';
import { StateManager } from '~/server/services/state-manager';

function commandNetstring(data: string, token = 'mediasoup-test'): string {
  const payload = JSON.stringify({
    response: true,
    ok: true,
    data,
    token,
  });
  return `${payload.length}:${payload},`;
}

function warnMessages(state: StateManager): string[] {
  return state
    .getLogs(1000)
    .filter(
      (entry) =>
        entry.level === 'warn' &&
        entry.message.startsWith('Unhandled Command Response:'),
    )
    .map((entry) => entry.message);
}

describe('baresip mediasoup command response parsing', () => {
  it('parses mediasoup context/tx/mute acknowledgements without unhandled warnings', () => {
    const state = new StateManager();

    expect(
      parseBaresipEventBuffered(
        commandNetstring(
          '{"key":"feed-1","state":"open","created":false}',
          'ctx-open',
        ),
        state,
      ),
    ).toEqual({ remaining: '' });
    expect(
      parseBaresipEventBuffered(
        commandNetstring(
          '{"key":"feed-1","mixMode":"party-line","mixLocalCallers":true,"bitrateBps":64000,"changed":false}',
          'ctx-config',
        ),
        state,
      ),
    ).toEqual({ remaining: '' });
    expect(
      parseBaresipEventBuffered(
        commandNetstring(
          '{"key":"feed-1","tx":"configured","changed":true,"localPort":45974,"payloadType":100,"ssrc":11121112}',
          'tx',
        ),
        state,
      ),
    ).toEqual({ remaining: '' });
    expect(
      parseBaresipEventBuffered(
        commandNetstring(
          '{"key":"feed-1","muted":false,"changed":false}',
          'mute',
        ),
        state,
      ),
    ).toEqual({ remaining: '' });

    expect(warnMessages(state)).toEqual([]);
    expect(
      state.getLogs(1000).filter((entry) => entry.source === 'mediasoup-bridge'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'info',
          message: 'mediasoup feed-1: context open reused',
        }),
        expect.objectContaining({
          level: 'info',
          message:
            'mediasoup feed-1: config mixMode=party-line bitrateBps=64000',
        }),
        expect.objectContaining({
          level: 'info',
          message: 'mediasoup feed-1: tx configured localPort=45974',
        }),
        expect.objectContaining({
          level: 'info',
          message: 'mediasoup feed-1: tx unmuted',
        }),
      ]),
    );
  });

  it('parses mediasoup stats and source lifecycle replies', () => {
    const state = new StateManager();
    const stat = {
      key: '13',
      state: 'open',
      calls: 1,
      mixMode: 'party-line',
      mixLocalCallers: true,
      bitrateBps: 64000,
      tx: {
        configured: true,
        muted: true,
        localPort: 39737,
        remoteIp: '51.107.18.159',
        remotePort: 40016,
        payloadType: 100,
        ssrc: 11111124,
        packets: 1002,
        bytes: 88168,
        errors: 0,
        levelDbfs: -96.0,
      },
      rxSourceCount: 1,
      ports: {
        inUse: 1,
        capacity: 100,
        purpose: 'remote-receive',
        txConsumesPool: false,
      },
      sources: [],
    };

    expect(
      parseBaresipEventBuffered(
        commandNetstring(JSON.stringify(stat), 'stat'),
        state,
      ),
    ).toEqual({ remaining: '' });
    expect(
      parseBaresipEventBuffered(
        commandNetstring(
          '{"key":"13","producerId":"29ae7b24-1004-4471-a036-66e182dcced0","localRecvPort":40000,"created":true}',
          'reserve',
        ),
        state,
      ),
    ).toEqual({ remaining: '' });
    expect(
      parseBaresipEventBuffered(
        commandNetstring(
          '{"key":"13","producerId":"29ae7b24-1004-4471-a036-66e182dcced0","state":"active","changed":true,"localRecvPort":40000,"payloadType":100,"ssrc":415342692}',
          'addsrc',
        ),
        state,
      ),
    ).toEqual({ remaining: '' });
    expect(
      parseBaresipEventBuffered(
        commandNetstring(
          '{"key":"13","producerId":"29ae7b24-1004-4471-a036-66e182dcced0","state":"removed","changed":true}',
          'delsrc',
        ),
        state,
      ),
    ).toEqual({ remaining: '' });

    expect(warnMessages(state)).toEqual([]);
    const statLog = state
      .getLogs(1000)
      .find(
        (entry) =>
          entry.source === 'mediasoup-bridge' &&
          entry.message.includes('stat calls='),
      );
    expect(statLog).toEqual(
      expect.objectContaining({
        level: 'debug',
        message:
          'mediasoup 13: stat calls=1 tx_packets=1002 level=-96.0 dBFS muted rx_sources=1',
      }),
    );
    expect(statLog?.data).toBeUndefined();
    expect(
      state
        .getLogs(1000)
        .filter((entry) => entry.source === 'mediasoup-bridge')
        .map((entry) => ({ level: entry.level, message: entry.message })),
    ).toEqual(
      expect.arrayContaining([
        {
          level: 'debug',
          message:
            'mediasoup 13: stat calls=1 tx_packets=1002 level=-96.0 dBFS muted rx_sources=1',
        },
        {
          level: 'info',
          message:
            'mediasoup 13: source 29ae7b24-1004-4471-a036-66e182dcced0 reserved recvPort=40000',
        },
        {
          level: 'info',
          message:
            'mediasoup 13: source 29ae7b24-1004-4471-a036-66e182dcced0 active recvPort=40000',
        },
        {
          level: 'info',
          message:
            'mediasoup 13: source 29ae7b24-1004-4471-a036-66e182dcced0 removed',
        },
      ]),
    );
  });

  it('accepts insmod and callfind acknowledgements without unhandled warnings', () => {
    const state = new StateManager();

    expect(
      parseBaresipEventBuffered(
        commandNetstring('loaded module mediasoup_bridge.so', 'insmod'),
        state,
      ),
    ).toEqual({ remaining: '' });
    expect(
      parseBaresipEventBuffered(
        commandNetstring('ua: sip:2061535@sip.srgssr.ch', 'callfind-ua'),
        state,
      ),
    ).toEqual({ remaining: '' });
    expect(
      parseBaresipEventBuffered(
        commandNetstring(
          'call uri: sip:1069901@sip.srgssr.ch\ncall id: 87ca87b5a5299822',
          'callfind-call',
        ),
        state,
      ),
    ).toEqual({ remaining: '' });
    expect(
      parseBaresipEventBuffered(
        commandNetstring('setting current call: 5d4796bb97576cf8', 'setcurr'),
        state,
      ),
    ).toEqual({ remaining: '' });
    expect(
      parseBaresipEventBuffered(
        commandNetstring('', 'dtmf-empty'),
        state,
      ),
    ).toEqual({ remaining: '' });

    expect(warnMessages(state)).toEqual([]);
    expect(state.getLogs(1000)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'info',
          source: 'tcp-socket',
          message: 'loaded module mediasoup_bridge.so',
        }),
      ]),
    );
  });
});
