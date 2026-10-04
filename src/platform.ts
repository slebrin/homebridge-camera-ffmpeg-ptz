import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import type { API, CharacteristicSetCallback, CharacteristicValue, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge'

import http from 'node:http'

import { APIEvent, CharacteristicEventTypes, PlatformAccessoryEvent } from 'homebridge'
import mqtt from 'mqtt'

import { Logger } from './logger.js'
import { OnvifEventListener } from './onvifEvents.js'
import { OnvifPtzController, PTZ_DIRECTIONS } from './ptz.js'
import type { PtzDirection } from './ptz.js'
import { StreamingDelegate } from './streamingDelegate.js'
import { PLUGIN_NAME, PLATFORM_NAME, MqttAction, getVersion } from './settings.js'
import type { AutomationReturn, CameraConfig, FfmpegPlatformConfig, OnvifEventsConfig, PtzConfig, PtzPreset } from './settings.js'

const version = getVersion()
const PTZ_STOP = 'PtzStop'
const PTZ_SWITCH_SUBTYPES: Record<PtzDirection, string> = {
  up: 'PtzUp',
  down: 'PtzDown',
  left: 'PtzLeft',
  right: 'PtzRight',
}
const DEFAULT_PTZ_LABELS: Record<PtzDirection, string> = {
  up: 'Haut',
  down: 'Bas',
  left: 'Gauche',
  right: 'Droite',
}

function getPtzPresetSubtype(preset: PtzPreset): string {
  const tokenHash = createHash('sha1').update(preset.token).digest('hex').slice(0, 12)
  return `PtzPreset-${tokenHash}`
}

export class FfmpegPlatform implements DynamicPlatformPlugin {
  private readonly log: Logger
  private readonly api: API
  private readonly config: FfmpegPlatformConfig
  private readonly cameraConfigs: Map<string, CameraConfig> = new Map()
  private readonly cachedAccessories: Array<PlatformAccessory> = []
  private readonly accessories: Array<PlatformAccessory> = []
  private readonly motionTimers: Map<string, NodeJS.Timeout> = new Map()
  private readonly doorbellTimers: Map<string, NodeJS.Timeout> = new Map()
  private readonly ptzConfigs: Map<string, PtzConfig> = new Map()
  private readonly ptzControllers: Map<string, OnvifPtzController> = new Map()
  private readonly ptzTimers: Map<string, NodeJS.Timeout> = new Map()
  private readonly ptzRequestIds: Map<string, number> = new Map()
  private readonly onvifEventConfigs: Map<string, OnvifEventsConfig> = new Map()
  private readonly onvifEventListeners: Map<string, OnvifEventListener> = new Map()
  private readonly mqttActions: Map<string, Map<string, Array<MqttAction>>> = new Map()

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = new Logger(log)
    this.api = api
    this.config = config as FfmpegPlatformConfig

    this.config.cameras?.forEach((cameraConfig: CameraConfig) => {
      let error = false

      if (!cameraConfig.name) {
        this.log.error('One of your cameras has no name configured. This camera will be skipped.')
        cameraConfig.name = `Camera ${this.cameraConfigs.size + 1}`
        error = false
      }
      if (!cameraConfig.videoConfig) {
        this.log.error('The videoConfig section is missing from the config. This camera will be skipped.', cameraConfig.name)
        error = true
      } else {
        if (!cameraConfig.videoConfig.source) {
          this.log.error('There is no source configured for this camera. This camera will be skipped.', cameraConfig.name)
          error = true
        } else {
          const sourceArgs = cameraConfig.videoConfig.source.split(/\s+/)
          if (!sourceArgs.includes('-i')) {
            this.log.warn('The source for this camera is missing "-i", it is likely misconfigured.', cameraConfig.name)
          }
        }
        if (cameraConfig.videoConfig.stillImageSource) {
          const stillArgs = cameraConfig.videoConfig.stillImageSource.split(/\s+/)
          if (!stillArgs.includes('-i')) {
            this.log.warn('The stillImageSource for this camera is missing "-i", it is likely misconfigured.', cameraConfig.name)
          }
        }
        if (cameraConfig.videoConfig.vcodec === 'copy' && cameraConfig.videoConfig.videoFilter) {
          this.log.warn('A videoFilter is defined, but the copy vcodec is being used. This will be ignored.', cameraConfig.name)
        }
      }

      if (!error) {
        const uuid = this.api.hap.uuid.generate(cameraConfig.name ?? `Camera ${this.cameraConfigs.size + 1}`)
        if (this.cameraConfigs.has(uuid)) {
          // Camera names must be unique
          this.log.warn('Multiple cameras are configured with this name. Duplicate cameras will be skipped.', cameraConfig.name)
        } else {
          this.cameraConfigs.set(uuid, cameraConfig)
          if (cameraConfig.ptz?.enabled) {
            const validationError = this.validatePtzConfig(cameraConfig.ptz)
            if (validationError) {
              this.log.error(`PTZ is disabled: ${validationError}`, cameraConfig.name)
            } else {
              this.ptzConfigs.set(uuid, cameraConfig.ptz)
            }
          }
          if (cameraConfig.onvifEvents?.enabled) {
            const validationError = this.validateOnvifEventsConfig(cameraConfig.onvifEvents, cameraConfig)
            if (validationError) {
              this.log.error(`ONVIF events are disabled: ${validationError}`, cameraConfig.name)
            } else {
              this.onvifEventConfigs.set(uuid, cameraConfig.onvifEvents)
            }
          }
        }
      }
    })

    api.on(APIEvent.DID_FINISH_LAUNCHING, this.didFinishLaunching.bind(this))
    api.on(APIEvent.SHUTDOWN, () => {
      for (const listener of this.onvifEventListeners.values()) {
        listener.stop()
      }
    })
  }

  addMqttAction(topic: string, message: string, details: MqttAction): void {
    const messageMap = this.mqttActions.get(topic) || new Map()
    const actionArray = messageMap.get(message) || []
    actionArray.push(details)
    messageMap.set(message, actionArray)
    this.mqttActions.set(topic, messageMap)
  }

  setupAccessory(accessory: PlatformAccessory, cameraConfig: CameraConfig): void {
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log.info('Identify requested.', accessory.displayName)
    })

    const accInfo = accessory.getService(this.api.hap.Service.AccessoryInformation)
    if (accInfo) {
      accInfo.setCharacteristic(this.api.hap.Characteristic.Manufacturer, cameraConfig.manufacturer || 'Homebridge')
      accInfo.setCharacteristic(this.api.hap.Characteristic.Model, cameraConfig.model || 'Camera FFmpeg')
      accInfo.setCharacteristic(this.api.hap.Characteristic.SerialNumber, cameraConfig.serialNumber || 'SerialNumber')
      accInfo.setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, cameraConfig.firmwareRevision || version)
    }

    const motionSensor = accessory.getService(this.api.hap.Service.MotionSensor)
    const doorbell = accessory.getService(this.api.hap.Service.Doorbell)
    const doorbellTrigger = accessory.getServiceById(this.api.hap.Service.Switch, 'DoorbellTrigger')
    const motionTrigger = accessory.getServiceById(this.api.hap.Service.Switch, 'MotionTrigger')
    const doorbellSwitch = accessory.getServiceById(this.api.hap.Service.StatelessProgrammableSwitch, 'DoorbellSwitch')

    if (motionSensor) {
      accessory.removeService(motionSensor)
    }
    if (doorbell) {
      accessory.removeService(doorbell)
    }
    if (doorbellTrigger) {
      accessory.removeService(doorbellTrigger)
    }
    if (motionTrigger) {
      accessory.removeService(motionTrigger)
    }
    if (doorbellSwitch) {
      accessory.removeService(doorbellSwitch)
    }

    for (const direction of PTZ_DIRECTIONS) {
      const ptzSwitch = accessory.getServiceById(this.api.hap.Service.Switch, PTZ_SWITCH_SUBTYPES[direction])
      if (ptzSwitch) {
        accessory.removeService(ptzSwitch)
      }
    }
    const ptzStop = accessory.getServiceById(this.api.hap.Service.Switch, PTZ_STOP)
    if (ptzStop) {
      accessory.removeService(ptzStop)
    }
    for (const service of [...accessory.services]) {
      if (service.subtype?.startsWith('PtzPreset-')) {
        accessory.removeService(service)
      }
    }

    const delegate = new StreamingDelegate(this.log, cameraConfig, this.api, this.api.hap, accessory, this.config.videoProcessor)

    accessory.configureController(delegate.controller)

    if (cameraConfig.videoConfig?.prebuffer) {
      this.log.debug('Start prebuffering...', cameraConfig.name)
      if (delegate.recordingDelegate) {
        delegate.recordingDelegate.startPreBuffer()
      }
    }

    // add motion sensor after accessory.configureController. Secure Video creates it own linked motion service
    if (cameraConfig.motion) {
      this.log.debug('add motion stuff', cameraConfig.name)
      const motionSensor = new this.api.hap.Service.MotionSensor(cameraConfig.name)

      if (!accessory.getService(this.api.hap.Service.MotionSensor)) {
        accessory.addService(motionSensor)
      } else {
        this.log.debug('found motion sensor service', cameraConfig.name)
      }
      if (cameraConfig.switches) {
        const motionTrigger = new this.api.hap.Service.Switch(`${cameraConfig.name} Motion Trigger`, 'MotionTrigger')
        motionTrigger
          .getCharacteristic(this.api.hap.Characteristic.On)
          .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            this.motionHandler(accessory, state as boolean, 1)
            callback()
          })
        accessory.addService(motionTrigger)
      }
    }

    // add doorbell  after accessory.configureController. Secure Video creates it own linked doorbell service
    if (cameraConfig.doorbell) {
      const doorbell = new this.api.hap.Service.Doorbell(`${cameraConfig.name} Doorbell`)
      if (!accessory.getService(this.api.hap.Service.Doorbell)) {
        accessory.addService(doorbell)
      } else {
        this.log.debug('found doorbell sensor service', cameraConfig.name)
      }
      if (cameraConfig.switches) {
        const doorbellTrigger = new this.api.hap.Service.Switch(`${cameraConfig.name} Doorbell Trigger`, 'DoorbellTrigger')
        doorbellTrigger
          .getCharacteristic(this.api.hap.Characteristic.On)
          .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            this.doorbellHandler(accessory, state as boolean)
            callback()
          })
        accessory.addService(doorbellTrigger)
      }
    }

    const ptzConfig = this.ptzConfigs.get(accessory.UUID)
    if (ptzConfig) {
      this.ptzControllers.set(accessory.UUID, new OnvifPtzController(ptzConfig))
      for (const direction of PTZ_DIRECTIONS) {
        const serviceName = ptzConfig.labels?.[direction]?.trim() || DEFAULT_PTZ_LABELS[direction]
        const service = new this.api.hap.Service.Switch(
          serviceName,
          PTZ_SWITCH_SUBTYPES[direction],
        )
        service.setCharacteristic(this.api.hap.Characteristic.ConfiguredName, serviceName)
        service
          .getCharacteristic(this.api.hap.Characteristic.On)
          .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            if (state !== true) {
              callback()
              return
            }
            void this.startPtzMove(accessory, direction)
              .then(() => callback())
              .catch((error: unknown) => {
                const failure = error instanceof Error ? error : new Error(String(error))
                this.log.error(`PTZ ${direction} command failed: ${failure.message}`, cameraConfig.name)
                callback(failure)
              })
          })
        accessory.addService(service)
      }

      for (const preset of ptzConfig.presets ?? []) {
        const presetServiceName = preset.name.trim()
        const presetService = new this.api.hap.Service.Switch(
          presetServiceName,
          getPtzPresetSubtype(preset),
        )
        presetService.setCharacteristic(this.api.hap.Characteristic.ConfiguredName, presetServiceName)
        presetService
          .getCharacteristic(this.api.hap.Characteristic.On)
          .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            if (state !== true) {
              callback()
              return
            }
            void this.gotoPtzPreset(accessory, preset)
              .then(() => {
                presetService.updateCharacteristic(this.api.hap.Characteristic.On, false)
                callback()
              })
              .catch((error: unknown) => {
                const failure = error instanceof Error ? error : new Error(String(error))
                this.log.error(`PTZ preset "${preset.name}" command failed: ${failure.message}`, cameraConfig.name)
                presetService.updateCharacteristic(this.api.hap.Characteristic.On, false)
                callback(failure)
              })
          })
        accessory.addService(presetService)
      }
    } else {
      this.ptzControllers.delete(accessory.UUID)
    }

    /*
    for (let rtp of delegate.controller.streamManagements) {
      this.log.debug("StreamMngt: "+rtp.getService().getCharacteristic(this.api.hap.Characteristic.Active).value.toString());
    }
    this.log.debug("recMngt:"+ accessory.getService(this.api.hap.Service.CameraRecordingManagement).getCharacteristic(this.api.hap.Characteristic.Active).value.toString());
*/
    if (this.config.mqtt) {
      if (cameraConfig.mqtt) {
        if (cameraConfig.mqtt.motionTopic) {
          this.addMqttAction(cameraConfig.mqtt.motionTopic, cameraConfig.mqtt.motionMessage || cameraConfig.name!, { accessory, active: true, doorbell: false })
        }
        if (cameraConfig.mqtt.motionResetTopic) {
          this.addMqttAction(cameraConfig.mqtt.motionResetTopic, cameraConfig.mqtt.motionResetMessage || cameraConfig.name!, { accessory, active: false, doorbell: false })
        }
        if (cameraConfig.mqtt.doorbellTopic) {
          this.addMqttAction(cameraConfig.mqtt.doorbellTopic, cameraConfig.mqtt.doorbellMessage || cameraConfig.name!, { accessory, active: true, doorbell: true })
        }
      }

      this.startOnvifEvents(accessory, cameraConfig)
    }
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Configuring cached bridged accessory...', accessory.displayName)

    const cameraConfig = this.cameraConfigs.get(accessory.UUID)

    if (cameraConfig) {
      this.setupAccessory(accessory, cameraConfig)
    }

    this.cachedAccessories.push(accessory)
  }

  private doorbellHandler(accessory: PlatformAccessory, active = true): AutomationReturn {
    const doorbell = accessory.getService(this.api.hap.Service.Doorbell)
    if (doorbell) {
      this.log.debug(`Switch doorbell ${active ? 'on.' : 'off.'}`, accessory.displayName)
      const timeout = this.doorbellTimers.get(accessory.UUID)
      if (timeout) {
        clearTimeout(timeout)
        this.doorbellTimers.delete(accessory.UUID)
      }
      const doorbellTrigger = accessory.getServiceById(this.api.hap.Service.Switch, 'DoorbellTrigger')
      if (active) {
        doorbell.updateCharacteristic(this.api.hap.Characteristic.ProgrammableSwitchEvent, this.api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS)
        if (doorbellTrigger) {
          doorbellTrigger.updateCharacteristic(this.api.hap.Characteristic.On, true)
          let timeoutConfig = this.cameraConfigs.get(accessory.UUID)?.motionTimeout
          timeoutConfig = timeoutConfig && timeoutConfig > 0 ? timeoutConfig : 1
          const timer = setTimeout(() => {
            this.log.debug('Doorbell handler timeout.', accessory.displayName)
            this.doorbellTimers.delete(accessory.UUID)
            doorbellTrigger.updateCharacteristic(this.api.hap.Characteristic.On, false)
          }, timeoutConfig * 1000)
          this.doorbellTimers.set(accessory.UUID, timer)
        }
        return {
          error: false,
          message: 'Doorbell switched on.',
        }
      } else {
        if (doorbellTrigger) {
          doorbellTrigger.updateCharacteristic(this.api.hap.Characteristic.On, false)
        }
        return {
          error: false,
          message: 'Doorbell switched off.',
        }
      }
    } else {
      return {
        error: true,
        message: 'Doorbell is not enabled for this camera.',
      }
    }
  }

  private motionHandler(accessory: PlatformAccessory, active = true, minimumTimeout = 0): AutomationReturn {
    const motionSensor = accessory.getService(this.api.hap.Service.MotionSensor)
    if (motionSensor) {
      this.log.debug(`Switch motion detect ${active ? 'on.' : 'off.'}`, accessory.displayName)
      const timeout = this.motionTimers.get(accessory.UUID)
      if (timeout) {
        clearTimeout(timeout)
        this.motionTimers.delete(accessory.UUID)
      }

      const motionTrigger = accessory.getServiceById(this.api.hap.Service.Switch, 'MotionTrigger')
      const config = this.cameraConfigs.get(accessory.UUID)
      if (active) {
        motionSensor.updateCharacteristic(this.api.hap.Characteristic.MotionDetected, true)
        if (motionTrigger) {
          motionTrigger.updateCharacteristic(this.api.hap.Characteristic.On, true)
        }
        if (!timeout && config?.motionDoorbell) {
          this.doorbellHandler(accessory, true)
        }
        let timeoutConfig = config?.motionTimeout ?? 1
        if (timeoutConfig < minimumTimeout) {
          timeoutConfig = minimumTimeout
        }
        if (timeoutConfig > 0) {
          const timer = setTimeout(() => {
            this.log.debug('Motion handler timeout.', accessory.displayName)
            this.motionTimers.delete(accessory.UUID)
            motionSensor.updateCharacteristic(this.api.hap.Characteristic.MotionDetected, false)
            if (motionTrigger) {
              motionTrigger.updateCharacteristic(this.api.hap.Characteristic.On, false)
            }
          }, timeoutConfig * 1000)
          this.motionTimers.set(accessory.UUID, timer)
        }
        return {
          error: false,
          message: 'Motion switched on.',
          cooldownActive: !!timeout,
        }
      } else {
        motionSensor.updateCharacteristic(this.api.hap.Characteristic.MotionDetected, false)
        if (motionTrigger) {
          motionTrigger.updateCharacteristic(this.api.hap.Characteristic.On, false)
        }
        if (config?.motionDoorbell) {
          this.doorbellHandler(accessory, false)
        }
        return {
          error: false,
          message: 'Motion switched off.',
        }
      }
    } else {
      return {
        error: true,
        message: 'Motion is not enabled for this camera.',
      }
    }
  }

  private validatePtzConfig(config: PtzConfig): string | undefined {
    if (!config.host?.trim()) {
      return 'a host is required when ptz.enabled is true.'
    }
    if (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) {
      return 'port must be an integer between 1 and 65535.'
    }
    if (config.speed !== undefined && (config.speed < 0.01 || config.speed > 1)) {
      return 'speed must be between 0.01 and 1.'
    }
    if (config.duration !== undefined && (!Number.isInteger(config.duration) || config.duration < 1 || config.duration > 60000)) {
      return 'duration must be an integer between 1 and 60000 milliseconds.'
    }
    for (const direction of PTZ_DIRECTIONS) {
      const label = config.labels?.[direction]
      if (label !== undefined && (typeof label !== 'string' || !label.trim())) {
        return `the PTZ label for "${direction}" must be a non-empty string.`
      }
    }
    const presetTokens = new Set<string>()
    for (const preset of config.presets ?? []) {
      if (typeof preset.name !== 'string' || !preset.name.trim()
        || typeof preset.token !== 'string' || !preset.token.trim()) {
        return 'each PTZ preset must have a non-empty name and ONVIF token.'
      }
      if (presetTokens.has(preset.token)) {
        return `the PTZ preset token "${preset.token}" is configured more than once.`
      }
      presetTokens.add(preset.token)
    }
    return undefined
  }

  private validateOnvifEventsConfig(config: OnvifEventsConfig, camera: CameraConfig): string | undefined {
    if (!config.host?.trim()) {
      return 'a host is required when onvifEvents.enabled is true.'
    }
    if (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) {
      return 'port must be an integer between 1 and 65535.'
    }
    if (!config.motionTopic?.trim() && !config.personTopic?.trim()) {
      return 'configure at least one ONVIF topic filter for motionTopic or personTopic.'
    }
    if (!camera.motion) {
      return 'set motion to true to expose the HomeKit motion sensor for ONVIF events.'
    }
    return undefined
  }

  private startOnvifEvents(accessory: PlatformAccessory, camera: CameraConfig): void {
    const previousListener = this.onvifEventListeners.get(accessory.UUID)
    previousListener?.stop()
    this.onvifEventListeners.delete(accessory.UUID)

    const config = this.onvifEventConfigs.get(accessory.UUID)
    if (!config) {
      return
    }

    const listener = new OnvifEventListener(
      config,
      (match, active) => {
        this.log.debug(`ONVIF ${match} event ${active ? 'detected' : 'cleared'}.`, camera.name)
        this.motionHandler(accessory, active)
      },
      error => this.log.error(`ONVIF event subscription failed: ${error.message}`, camera.name),
      topic => this.log.debug(`ONVIF event topic: ${topic}`, camera.name),
    )
    this.onvifEventListeners.set(accessory.UUID, listener)
    void listener.start().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.log.error(`Could not start ONVIF event subscription: ${failure.message}`, camera.name)
    })
  }

  private async startPtzMove(accessory: PlatformAccessory, direction: PtzDirection): Promise<void> {
    const controller = this.ptzControllers.get(accessory.UUID)
    if (!controller) {
      throw new Error('PTZ is not enabled for this camera.')
    }

    const requestId = (this.ptzRequestIds.get(accessory.UUID) ?? 0) + 1
    this.ptzRequestIds.set(accessory.UUID, requestId)

    try {
      await controller.stop()
      if (this.ptzRequestIds.get(accessory.UUID) !== requestId) {
        return
      }

      for (const otherDirection of PTZ_DIRECTIONS) {
        if (otherDirection !== direction) {
          const service = accessory.getServiceById(this.api.hap.Service.Switch, PTZ_SWITCH_SUBTYPES[otherDirection])
          service?.updateCharacteristic(this.api.hap.Characteristic.On, false)
        }
      }

      const previousTimer = this.ptzTimers.get(accessory.UUID)
      if (previousTimer) {
        clearTimeout(previousTimer)
        this.ptzTimers.delete(accessory.UUID)
      }

      await controller.move(direction)
      if (this.ptzRequestIds.get(accessory.UUID) !== requestId) {
        return
      }
    } catch (error) {
      try {
        await controller.stop()
      } catch (stopError) {
        const failure = stopError instanceof Error ? stopError : new Error(String(stopError))
        this.log.error(`Could not stop camera after a failed PTZ command: ${failure.message}`, accessory.displayName)
      }
      throw error
    }

    const duration = this.ptzConfigs.get(accessory.UUID)?.duration ?? 500
    const timer = setTimeout(() => {
      void controller.stop()
        .then(() => {
          if (this.ptzTimers.get(accessory.UUID) !== timer) {
            return
          }
          this.ptzTimers.delete(accessory.UUID)
          const service = accessory.getServiceById(this.api.hap.Service.Switch, PTZ_SWITCH_SUBTYPES[direction])
          service?.updateCharacteristic(this.api.hap.Characteristic.On, false)
        })
        .catch((error: unknown) => {
          if (this.ptzTimers.get(accessory.UUID) === timer) {
            this.ptzTimers.delete(accessory.UUID)
          }
          const failure = error instanceof Error ? error : new Error(String(error))
          this.log.error(`Automatic PTZ stop failed: ${failure.message}`, accessory.displayName)
        })
    }, duration)
    timer.unref()
    this.ptzTimers.set(accessory.UUID, timer)
  }

  private async gotoPtzPreset(accessory: PlatformAccessory, preset: PtzPreset): Promise<void> {
    const controller = this.ptzControllers.get(accessory.UUID)
    if (!controller) {
      throw new Error('PTZ is not enabled for this camera.')
    }

    const requestId = (this.ptzRequestIds.get(accessory.UUID) ?? 0) + 1
    this.ptzRequestIds.set(accessory.UUID, requestId)
    const timer = this.ptzTimers.get(accessory.UUID)
    if (timer) {
      clearTimeout(timer)
      this.ptzTimers.delete(accessory.UUID)
    }

    await controller.stop()
    if (this.ptzRequestIds.get(accessory.UUID) !== requestId) {
      return
    }

    for (const direction of PTZ_DIRECTIONS) {
      const service = accessory.getServiceById(this.api.hap.Service.Switch, PTZ_SWITCH_SUBTYPES[direction])
      service?.updateCharacteristic(this.api.hap.Characteristic.On, false)
    }
    await controller.gotoPreset(preset.token)
  }

  private httpHandler(fullpath: string, name: string): AutomationReturn {
    const accessory = this.accessories.find((curAcc: PlatformAccessory) => {
      return curAcc.displayName === name
    })
    if (accessory) {
      const path = fullpath.split('/').filter(value => value.length > 0)
      switch (path[0]) {
        case 'motion':
          return this.motionHandler(accessory, path[1] !== 'reset')
          break
        case 'doorbell':
          return this.doorbellHandler(accessory)
          break
        default:
          return {
            error: true,
            message: `First directory level must be "motion" or "doorbell", got "${path[0]}".`,
          }
      }
    } else {
      return {
        error: true,
        message: `Camera "${name}" not found.`,
      }
    }
  }

  didFinishLaunching(): void {
    for (const [uuid, cameraConfig] of this.cameraConfigs) {
      const name = cameraConfig.name || `Camera ${this.cameraConfigs.size + 1}`
      const cachedAccessory = this.cachedAccessories.find((curAcc: PlatformAccessory) => curAcc.UUID === uuid)
      if (!cachedAccessory) {
        const accessory = new this.api.platformAccessory(name, uuid)
        this.log.info('Configuring bridged accessory...', accessory.displayName)
        this.setupAccessory(accessory, cameraConfig)
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory])
        this.accessories.push(accessory)
      } else {
        this.accessories.push(cachedAccessory)
      }
    }

    if (this.config.mqtt) {
      const portmqtt = this.config.portmqtt || '1883'
      this.log.info('Setting up MQTT connection...')
      const client = mqtt.connect(`${(this.config.tlsmqtt ? 'mqtts://' : 'mqtt://') + this.config.mqtt}:${portmqtt}`, {
        username: this.config.usermqtt,
        password: this.config.passmqtt,
      })
      client.on('connect', () => {
        this.log.info('MQTT connected.')
        for (const [topic] of this.mqttActions) {
          this.log.debug(`Subscribing to MQTT topic: ${topic}`)
          client.subscribe(topic)
        }
      })
      client.on('message', (topic: string, message: Buffer) => {
        const messageMap = this.mqttActions.get(topic)
        if (messageMap) {
          const actionArray = messageMap.get(message.toString())
          if (actionArray) {
            for (const action of actionArray) {
              if (action.doorbell) {
                this.doorbellHandler(action.accessory, action.active)
              } else {
                this.motionHandler(action.accessory, action.active)
              }
            }
          }
        }
      })
    }
    if (this.config.porthttp) {
      this.log.info(`Setting up ${this.config.localhttp ? 'localhost-only ' : ''
        }HTTP server on port ${this.config.porthttp}...`)
      const server = http.createServer()
      const hostname = this.config.localhttp ? 'localhost' : undefined
      server.listen(this.config.porthttp, hostname)
      server.on('request', (request: http.IncomingMessage, response: http.ServerResponse) => {
        let results: AutomationReturn = {
          error: true,
          message: 'Malformed URL.',
        }
        if (request.url) {
          const spliturl = request.url.split('?')
          if (spliturl.length === 2) {
            const name = decodeURIComponent(spliturl[1]).split('=')[0]
            results = this.httpHandler(spliturl[0], name)
          }
        }
        response.writeHead(results.error ? 500 : 200)
        response.write(JSON.stringify(results))
        response.end()
      })
    }

    this.cachedAccessories.forEach((accessory: PlatformAccessory) => {
      const cameraConfig = this.cameraConfigs.get(accessory.UUID)
      if (!cameraConfig) {
        this.log.info('Removing bridged accessory...', accessory.displayName)
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      }
    })
  }
}
