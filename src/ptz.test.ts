import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  Cam: vi.fn(),
  connect: vi.fn(),
  continuousMove: vi.fn(),
  gotoPreset: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('onvif', () => ({
  Cam: mocks.Cam.mockImplementation(() => ({
    defaultProfile: { $: { token: 'profile-token' } },
    connect: mocks.connect,
    continuousMove: mocks.continuousMove,
    gotoPreset: mocks.gotoPreset,
    stop: mocks.stop,
  })),
}))

import { OnvifPtzController } from './ptz.js'

describe('OnvifPtzController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.connect.mockImplementation((callback: (error: Error | null) => void) => callback(null))
    mocks.continuousMove.mockImplementation((_options: unknown, callback: (error: Error | null) => void) => callback(null))
    mocks.gotoPreset.mockImplementation((_options: unknown, callback: (error: Error | null) => void) => callback(null))
    mocks.stop.mockImplementation((_options: unknown, callback: (error: Error | null) => void) => callback(null))
  })

  it('connects lazily and sends a bounded directional command with the configured speed', async () => {
    const controller = new OnvifPtzController({
      enabled: true,
      host: '192.168.1.17',
      port: 80,
      speed: 0.35,
      duration: 500,
    })

    await controller.move('up')
    await controller.move('left')

    expect(mocks.Cam).toHaveBeenCalledTimes(1)
    expect(mocks.Cam).toHaveBeenCalledWith({
      hostname: '192.168.1.17',
      port: 80,
      username: undefined,
      password: undefined,
      timeout: 10000,
      autoconnect: false,
    })
    expect(mocks.continuousMove).toHaveBeenNthCalledWith(
      1,
      { profileToken: 'profile-token', x: 0, y: 0.35, zoom: 0, timeout: 500 },
      expect.any(Function),
    )
    expect(mocks.continuousMove).toHaveBeenNthCalledWith(
      2,
      { profileToken: 'profile-token', x: -0.35, y: 0, zoom: 0, timeout: 500 },
      expect.any(Function),
    )
  })

  it('stops both pan/tilt and zoom', async () => {
    const controller = new OnvifPtzController({ enabled: true, host: 'camera.local' })

    await controller.stop()

    expect(mocks.stop).toHaveBeenCalledWith(
      { profileToken: 'profile-token', panTilt: true, zoom: true },
      expect.any(Function),
    )
  })

  it('moves to a configured ONVIF preset token', async () => {
    const controller = new OnvifPtzController({ enabled: true, host: 'camera.local' })

    await controller.gotoPreset('preset-token')

    expect(mocks.gotoPreset).toHaveBeenCalledWith(
      { profileToken: 'profile-token', preset: 'preset-token' },
      expect.any(Function),
    )
  })

  it('prefers a PTZ-capable profile when the camera exposes multiple profiles', async () => {
    mocks.Cam.mockImplementationOnce(() => ({
      profiles: [
        { $: { token: 'video-only-profile' } },
        { $: { token: 'ptz-profile' }, PTZConfiguration: { name: 'PTZ' } },
      ],
      connect: mocks.connect,
      continuousMove: mocks.continuousMove,
      gotoPreset: mocks.gotoPreset,
      stop: mocks.stop,
    }))
    const controller = new OnvifPtzController({ enabled: true, host: 'camera.local' })

    await controller.move('right')

    expect(mocks.continuousMove).toHaveBeenCalledWith(
      expect.objectContaining({ profileToken: 'ptz-profile' }),
      expect.any(Function),
    )
  })

  it('rejects ONVIF command errors', async () => {
    const controller = new OnvifPtzController({ enabled: true, host: 'camera.local' })
    const failure = new Error('camera rejected the PTZ command')
    mocks.continuousMove.mockImplementation((_options: unknown, callback: (error: Error | null) => void) => callback(failure))

    await expect(controller.move('right')).rejects.toThrow(failure)
  })
})
