import { Cam } from 'onvif'

import type { PtzConfig } from './settings.js'

export const PTZ_DIRECTIONS = ['up', 'down', 'left', 'right'] as const

export type PtzDirection = typeof PTZ_DIRECTIONS[number]

const directionVectors: Record<PtzDirection, { x: number; y: number }> = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

export class OnvifPtzController {
  private readonly config: PtzConfig
  private camera?: Cam
  private connecting?: Promise<Cam>
  private commandQueue: Promise<void> = Promise.resolve()

  constructor(config: PtzConfig) {
    this.config = config
  }

  move(direction: PtzDirection): Promise<void> {
    return this.enqueue(async () => {
      const camera = await this.getCamera()
      const profileToken = camera.defaultProfile?.token
      if (!profileToken) {
        throw new Error('The ONVIF camera did not provide a usable media profile.')
      }

      const vector = directionVectors[direction]
      await this.request(callback => camera.continuousMove({
        profileToken,
        x: vector.x * (this.config.speed ?? 0.35),
        y: vector.y * (this.config.speed ?? 0.35),
        zoom: 0,
        timeout: this.config.duration ?? 500,
      }, callback))
    })
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      const camera = await this.getCamera()
      await this.request(callback => camera.stop({
        profileToken: camera.defaultProfile?.token,
        panTilt: true,
        zoom: true,
      }, callback))
    })
  }

  gotoPreset(presetToken: string): Promise<void> {
    return this.enqueue(async () => {
      const camera = await this.getCamera()
      const profileToken = camera.defaultProfile?.token
      if (!profileToken) {
        throw new Error('The ONVIF camera did not provide a usable media profile.')
      }

      await this.request(callback => camera.gotoPreset({
        profileToken,
        preset: presetToken,
      }, callback))
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.commandQueue.then(operation)
    this.commandQueue = result.catch(() => undefined)
    return result
  }

  private async getCamera(): Promise<Cam> {
    if (this.camera) {
      return this.camera
    }

    if (!this.connecting) {
      const hostname = this.config.host?.trim()
      if (!hostname) {
        throw new Error('An ONVIF host is required to control PTZ.')
      }
      const camera = new Cam({
        hostname,
        port: this.config.port ?? 80,
        username: this.config.username,
        password: this.config.password,
        timeout: 10000,
        autoconnect: false,
      })
      this.connecting = new Promise<Cam>((resolve, reject) => {
        camera.connect(error => {
          if (error) {
            this.connecting = undefined
            reject(error)
          } else {
            this.camera = camera
            resolve(camera)
          }
        })
      })
    }

    return this.connecting
  }

  private request(run: (callback: (error: Error | null) => void) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      run(error => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }
}
