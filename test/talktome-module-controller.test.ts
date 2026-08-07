import { describe, expect, it, vi } from 'vitest';
import {
  CtrlTcpTalktomeModuleController,
  type ModuleCommandExecutor,
} from '~/server/services/talktome/module-controller';

describe('CtrlTcpTalktomeModuleController', () => {
  it('emits the exact mediasoup_bridge command protocol and decodes reserve/stat payloads', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'ms_src_reserve') {
        return { data: 'ok: {"local_recv_port":51000}' };
      }
      if (command === 'ms_bridge_stat') {
        return {
          response: JSON.stringify({
            tx: { packets: 12 },
            sources: 1,
          }),
        };
      }
      return { response: true };
    });
    const controller = new CtrlTcpTalktomeModuleController({
      execute,
    } as ModuleCommandExecutor);

    await controller.openContext('studio');
    await controller.configureContext('studio', {
      mixLocalCallers: true,
      bitrateBps: 64_000,
    });
    await controller.bindTransmit('studio', {
      ip: '192.0.2.10',
      port: 40_000,
      payloadType: 111,
      ssrc: 987_654,
    });
    await controller.setTransmitMuted('studio', true);
    await expect(controller.reserveSource('studio', 'producer-1')).resolves.toEqual({
      localRecvPort: 51_000,
    });
    await controller.addSource('studio', {
      producerId: 'producer-1',
      ip: '127.0.0.1',
      port: 50_004,
      payloadType: 111,
      ssrc: 123_456,
    });
    await controller.removeSource('studio', 'producer-1');
    await expect(controller.getStats('studio')).resolves.toEqual({
      tx: { packets: 12 },
      sources: 1,
    });
    await controller.closeContext('studio');

    expect(execute.mock.calls).toEqual([
      ['ms_ctx_open', 'studio'],
      ['ms_ctx_config', 'studio party-line 64000'],
      ['ms_bridge_tx', 'studio 192.0.2.10 40000 111 987654'],
      ['ms_bridge_tx_mute', 'studio on'],
      ['ms_src_reserve', 'studio producer-1'],
      ['ms_bridge_addsrc', 'studio producer-1 127.0.0.1 50004 111 123456'],
      ['ms_bridge_delsrc', 'studio producer-1'],
      ['ms_bridge_stat', 'studio'],
      ['ms_ctx_close', 'studio'],
    ]);
  });

  it('supports isolated mode/optional SSRC and rejects unsafe or failed responses', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ response: true })
      .mockResolvedValueOnce({ response: true })
      .mockResolvedValueOnce({ data: { port: 52_000 } })
      .mockResolvedValueOnce({ error: 'module unavailable' });
    const controller = new CtrlTcpTalktomeModuleController({
      execute,
    } as ModuleCommandExecutor);

    await controller.configureContext('isolated', {
      mixLocalCallers: false,
      bitrateBps: 96_000,
    });
    await controller.addSource('isolated', {
      producerId: 'producer-2',
      ip: '127.0.0.1',
      port: 50_006,
      payloadType: 109,
    });
    await expect(
      controller.reserveSource('isolated', 'producer-2'),
    ).resolves.toEqual({ localRecvPort: 52_000 });
    await expect(controller.getStats('isolated')).rejects.toThrow(
      'module unavailable',
    );

    expect(execute.mock.calls.slice(0, 2)).toEqual([
      ['ms_ctx_config', 'isolated isolated 96000'],
      ['ms_bridge_addsrc', 'isolated producer-2 127.0.0.1 50006 109'],
    ]);
    await expect(controller.openContext('bad key')).rejects.toThrow(
      'command separators',
    );
    await expect(
      controller.reserveSource('isolated', 'bad producer'),
    ).rejects.toThrow('command separators');
  });

  it('keeps context keys and producer IDs correlated across independent module commands', async () => {
    const execute = vi.fn(async (command: string, params?: string) => {
      if (command === 'ms_src_reserve') {
        return {
          data:
            params === 'alpha producer-a'
              ? '{"localRecvPort":51001}'
              : '{"localRecvPort":51002}',
        };
      }
      return { response: true };
    });
    const controller = new CtrlTcpTalktomeModuleController({
      execute,
    } as ModuleCommandExecutor);

    await expect(
      controller.reserveSource('alpha', 'producer-a'),
    ).resolves.toEqual({ localRecvPort: 51_001 });
    await expect(
      controller.reserveSource('beta', 'producer-b'),
    ).resolves.toEqual({ localRecvPort: 51_002 });
    await controller.addSource('alpha', {
      producerId: 'producer-a',
      ip: '127.0.0.1',
      port: 50_001,
      payloadType: 111,
      ssrc: 1001,
    });
    await controller.addSource('beta', {
      producerId: 'producer-b',
      ip: '127.0.0.2',
      port: 50_002,
      payloadType: 112,
      ssrc: 1002,
    });
    await controller.removeSource('alpha', 'producer-a');
    await controller.removeSource('beta', 'producer-b');

    expect(execute.mock.calls).toEqual([
      ['ms_src_reserve', 'alpha producer-a'],
      ['ms_src_reserve', 'beta producer-b'],
      ['ms_bridge_addsrc', 'alpha producer-a 127.0.0.1 50001 111 1001'],
      ['ms_bridge_addsrc', 'beta producer-b 127.0.0.2 50002 112 1002'],
      ['ms_bridge_delsrc', 'alpha producer-a'],
      ['ms_bridge_delsrc', 'beta producer-b'],
    ]);
  });
});
