import { describe, expect, it } from 'vitest';
import { parseBaresipEventBuffered } from '~/server/services/baresip-parser';
import { StateManager } from '~/server/services/state-manager';

function listcallsNetstring(data: string): string {
  const payload = JSON.stringify({
    response: true,
    ok: true,
    data,
    token: 'listcalls-test',
  });
  return `${payload.length}:${payload},`;
}

describe('baresip listcalls response parsing', () => {
  it('restores selected and non-selected parallel calls with opaque IDs and hold state', () => {
    const state = new StateManager();
    const data = [
      'User-Agent: studio@example.com',
      '--- Active calls (2) ---',
      '> [line 1, id selected-call/Z9!abc]  1:23:38  ESTABLISHED sip:alice@example.net',
      '  [line 2, id branch:beta_42@host;tag=one]  0:07  ESTABLISHED (on hold) <sip:bob@example.net>',
    ].join('\n');

    expect(
      parseBaresipEventBuffered(listcallsNetstring(data), state),
    ).toEqual({ remaining: '' });

    expect(state.getCalls()).toEqual([
      expect.objectContaining({
        callId: 'selected-call/Z9!abc',
        localUri: 'sip:studio@example.com',
        remoteUri: 'sip:alice@example.net',
        state: 'Established',
        onHold: false,
      }),
      expect.objectContaining({
        callId: 'branch:beta_42@host;tag=one',
        localUri: 'sip:studio@example.com',
        remoteUri: 'sip:bob@example.net',
        state: 'Established',
        onHold: true,
      }),
    ]);
  });

  it('associates every parallel call with its own User-Agent block', () => {
    const state = new StateManager();
    const data = [
      'User-Agent: alpha@example.com',
      '--- Active calls (2) ---',
      '  [line 1, id alpha.one+nonhex]  0:03  RINGING sip:first@example.net',
      '> [line 2, id alpha/two=opaque]  0:02  ESTABLISHED sip:second@example.net',
      'User-Agent: beta@example.com',
      '--- Active calls (1) ---',
      '  [line 1, id beta-call:three]  4:05  ESTABLISHED (on hold) sip:third@example.net',
    ].join('\n');

    expect(
      parseBaresipEventBuffered(listcallsNetstring(data), state),
    ).toEqual({ remaining: '' });

    expect(
      state.getCalls().map(({ callId, localUri, remoteUri, state, onHold }) => ({
        callId,
        localUri,
        remoteUri,
        state,
        onHold,
      })),
    ).toEqual([
      {
        callId: 'alpha.one+nonhex',
        localUri: 'sip:alpha@example.com',
        remoteUri: 'sip:first@example.net',
        state: 'Ringing',
        onHold: false,
      },
      {
        callId: 'alpha/two=opaque',
        localUri: 'sip:alpha@example.com',
        remoteUri: 'sip:second@example.net',
        state: 'Established',
        onHold: false,
      },
      {
        callId: 'beta-call:three',
        localUri: 'sip:beta@example.com',
        remoteUri: 'sip:third@example.net',
        state: 'Established',
        onHold: true,
      },
    ]);
  });
});
