import { Cam } from 'onvif'

import type { OnvifEventsConfig } from './settings.js'

type EventMatch = 'motion' | 'person'

type EventCallback = (match: EventMatch, active: boolean) => void
type TopicCallback = (topic: string) => void
type EventRecord = Record<string, unknown>

function isRecord(value: unknown): value is EventRecord {
  return typeof value === 'object' && value !== null
}

function getTopic(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined
  }
  if (typeof event.topic === 'string') {
    return event.topic
  }
  if (!isRecord(event.topic)) {
    return undefined
  }
  const topic = event.topic._
  return typeof topic === 'string' ? topic : undefined
}

function collectItemValues(value: unknown, values: boolean[] = []): boolean[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectItemValues(item, values)
    }
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key.toLowerCase() === 'simpleitem' || key.toLowerCase() === 'elementitem') {
        const eventItems = Array.isArray(item) ? item : [item]
        for (const eventItem of eventItems) {
          if (!isRecord(eventItem) || !isRecord(eventItem.$)) {
            continue
          }
          const itemValue = eventItem.$.Value
          if (typeof itemValue === 'boolean') {
            values.push(itemValue)
          } else if (typeof itemValue === 'string' && (itemValue.toLowerCase() === 'true' || itemValue.toLowerCase() === 'false')) {
            values.push(itemValue.toLowerCase() === 'true')
          }
        }
      } else {
        collectItemValues(item, values)
      }
    }
  }
  return values
}

export function parseOnvifEvent(event: unknown): { topic: string; active?: boolean } | undefined {
  const topic = getTopic(event)
  if (!topic) {
    return undefined
  }
  const values = collectItemValues(event)
  return {
    topic,
    ...(values.length > 0 ? { active: values.some(Boolean) } : {}),
  }
}

export class OnvifEventListener {
  private readonly config: OnvifEventsConfig
  private readonly onEvent: EventCallback
  private readonly onError: (error: Error) => void
  private readonly onTopic: TopicCallback
  private camera?: Cam
  private connecting?: Promise<void>
  private stopped = false
  private readonly seenTopics = new Set<string>()

  constructor(config: OnvifEventsConfig, onEvent: EventCallback, onError: (error: Error) => void, onTopic: TopicCallback) {
    this.config = config
    this.onEvent = onEvent
    this.onError = onError
    this.onTopic = onTopic
  }

  start(): Promise<void> {
    if (this.connecting) {
      return this.connecting
    }

    const hostname = this.config.host?.trim()
    if (!hostname) {
      return Promise.reject(new Error('An ONVIF host is required to receive camera events.'))
    }

    const camera = new Cam({
      hostname,
      port: this.config.port ?? 80,
      username: this.config.username,
      password: this.config.password,
      timeout: 10000,
      autoconnect: false,
    })
    this.camera = camera

    this.connecting = new Promise<void>((resolve, reject) => {
      camera.connect(error => {
        if (error) {
          reject(error)
          return
        }
        if (this.stopped) {
          resolve()
          return
        }

        camera.on('event', (event: unknown) => this.handleEvent(event))
        camera.on('eventsError', (error: unknown) => {
          this.onError(error instanceof Error ? error : new Error(String(error)))
        })
        resolve()
      })
    })
    return this.connecting
  }

  stop(): void {
    this.stopped = true
    const camera = this.camera
    if (!camera) {
      return
    }
    camera.removeAllListeners('event')
    if (camera.events.subscription) {
      camera.unsubscribe(error => {
        if (error) {
          this.onError(error)
        }
      }, true)
    }
  }

  private handleEvent(event: unknown): void {
    const parsed = parseOnvifEvent(event)
    if (!parsed) {
      return
    }
    if (!this.seenTopics.has(parsed.topic)) {
      this.seenTopics.add(parsed.topic)
      this.onTopic(parsed.topic)
    }

    this.matchEvent(parsed.topic, this.config.motionTopic, 'motion', parsed.active)
    this.matchEvent(parsed.topic, this.config.personTopic, 'person', parsed.active)
  }

  private matchEvent(topic: string, configuredTopic: string | undefined, match: EventMatch, active: boolean | undefined): void {
    if (configuredTopic && topic.includes(configuredTopic)) {
      this.onEvent(match, active ?? true)
    }
  }
}
